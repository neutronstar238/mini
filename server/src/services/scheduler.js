'use strict';
/**
 * 中心控制面调度器（唯一实例，运行于 :3001 OJ Core）
 * - 事件驱动调度（新提交/重判/Worker 就绪/任务完成/连接恢复/租约过期 → dispatchPending）
 * - watchdog：lease expiry sweep 5s；pending fallback scan 10s
 * - 定向调度：从内存 Worker Registry 选具体 Worker，不广播 TASK_AVAILABLE
 * - Worker 心跳内存化（worker-registry），不写 SQLite
 * - 数据库持久化状态：PENDING / LEASED / RUNNING / FINISHED + 最终结果
 * - judge_attempts 保留每次 attempt 历史（重判不覆盖旧结果）
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../store/db');
const hub = require('../sse/hub');
const sm = require('./state-machine');
const workerRegistry = require('./worker-registry');
const scoreboard = require('./scoreboard');
const { signTask, checkLeaseUsed } = require('../security/trust');

/** 内存态：worker_id -> [task] 待推送队列（仅内存，不用做任务持久状态） */
const workerQueues = new Map();
/** activeTasks: task_id -> { worker_id, submission_id, attempt, lease }（内存态） */
const activeTasks = new Map();

function now() { return Date.now(); }

/**
 * 提交入队：SUBMITTED → PENDING（记录 server_received_at 权威时间）
 * @param {object} submission 已 insert 的提交
 * @param {object} opts { localVerification, clientRequestId, serverReceivedAt }
 */
function submit(submission, opts = {}) {
  const patch = { status: 'PENDING', attempt: 0 };
  if (opts.localVerification != null) patch.localVerification = opts.localVerification;
  if (opts.clientRequestId) patch.clientRequestId = opts.clientRequestId;
  if (opts.serverReceivedAt) patch.serverReceivedAt = opts.serverReceivedAt;
  const updated = db.submissions.update(submission.id, patch);
  hub.broadcastPage('submission_update', { id: updated.id, status: 'PENDING' });
  dispatchPending(); // 事件：新 submission 创建
  return updated;
}

/** 从内存 Worker Registry 选一个 READY Worker（定向调度，防 thundering herd） */
function pickWorker() {
  const candidates = db.workers.all().filter((w) => workerRegistry.schedulable(w));
  const trusted = candidates.filter((w) => w.tier === 'trusted');
  const pool = trusted.length ? trusted : candidates;
  if (!pool.length) return null;
  // 负载均衡：队列最短 + runningTasks 最少
  pool.sort((a, b) => {
    const qa = workerQueues.get(a.id)?.length || 0;
    const qb = workerQueues.get(b.id)?.length || 0;
    const ra = (workerRegistry.workerRuntimeMap.get(a.id)?.runningTasks || []).length;
    const rb = (workerRegistry.workerRuntimeMap.get(b.id)?.runningTasks || []).length;
    return (qa + ra) - (qb + rb);
  });
  return pool[0];
}

/**
 * 为一条 PENDING 提交分配 Worker 并签发任务
 * 流程（指导文档 §4）：PENDING → 选 Worker → DB transaction(创建 Attempt, LEASED) → commit → 定向发送
 */
function dispatchOne(submission) {
  const worker = pickWorker();
  if (!worker) return null;

  const problem = db.problems.byId(submission.problemId);
  if (!problem) {
    db.submissions.update(submission.id, { status: 'SE', message: '题目不存在' });
    return null;
  }

  const lease = {
    lease_id: crypto.randomUUID(),
    nonce: crypto.randomBytes(16).toString('hex'),
    expires_at: now() + config.leaseTtlMs
  };
  const attemptNo = (submission.attempt || 0) + 1;
  const task = {
    task_id: crypto.randomUUID(),
    submission_id: submission.id,
    attempt: attemptNo,
    language: submission.language,
    code: submission.code,
    problem: {
      time_limit_ms: problem.timeLimitMs,
      memory_limit_mb: problem.memoryLimitMb,
      testcases: problem.testcases || [],
      problem_version: problem.version || 1,
      testdata_hash: problem.testdataHash || ''
    },
    worker_id: worker.id,
    tier: worker.tier,
    lease,
    runtime_manifest_hash: worker.runtime_manifest_hash || '',
    trust_status: worker.trust_status
  };
  task.sig = signTask(task, worker.secret);

  // 短事务：持久化 Attempt 历史 + 更新 submission 状态（不包含网络调用）
  const attemptRecord = db.judgeAttempts.insert({
    submissionId: submission.id,
    attempt: attemptNo,
    taskId: task.task_id,
    problemId: problem.id,
    problemVersion: problem.version || 1,
    testdataHash: problem.testdataHash || '',
    language: submission.language,
    workerId: worker.id,
    status: 'LEASED',
    lease,
    createdAt: new Date().toISOString()
  });
  const updated = db.submissions.update(submission.id, {
    status: 'LEASED',
    workerId: worker.id,
    taskId: task.task_id,
    attempt: attemptNo,
    lease,
    currentAttemptId: attemptRecord.id
  });
  db.submissions.update(submission.id, { currentAttemptId: attemptRecord.id });
  updated.currentAttemptId = attemptRecord.id;

  // 内存态：队列 + activeTasks + registry
  workerQueues.set(worker.id, [...(workerQueues.get(worker.id) || []), task]);
  activeTasks.set(task.task_id, { worker_id: worker.id, submission_id: submission.id, attempt: attemptNo, lease });
  workerRegistry.assignTask(worker.id, task);

  // commit 后做网络操作：只向选中的 Worker 发送
  pushToWorker(worker.id);
  hub.emit('admin', 'task_dispatch', { task_id: task.task_id, submission_id: submission.id, worker: worker.id, attempt: attemptNo });
  return task;
}

function dispatchPending() {
  // 使用索引式查询的简化：仅取 PENDING 且未过期
  const pending = db.submissions.find((x) => x.status === 'PENDING').slice(0, 50);
  for (const s of pending) dispatchOne(s);
}

/** 定向推送（只发给选中 Worker 的 channel，不广播） */
function pushToWorker(workerId) {
  const queue = workerQueues.get(workerId) || [];
  while (queue.length) {
    const sent = hub.emit(`worker:${workerId}`, 'task', queue[0]);
    if (sent > 0) {
      workerRegistry.releaseTask(workerId, queue[0].task_id);
      queue.shift();
    } else break; // Worker 不在线，留队由 /pull 兜底
  }
}

/** Worker 轮询拉取兜底 */
function pullTasks(workerId) {
  const queue = workerQueues.get(workerId) || [];
  const tasks = [...queue];
  queue.length = 0;
  return tasks;
}

/** 心跳：仅更新内存 Registry + 触发 dispatchPending（不写 DB） */
function handleHeartbeat(worker, hb) {
  workerRegistry.onHeartbeat(worker.id, hb);
  if (hb.runtime_manifest_hash && worker.runtime_manifest_hash
    && hb.runtime_manifest_hash !== worker.runtime_manifest_hash) {
    recordAnomaly(worker, `runtime_manifest_hash 不一致：期望 ${worker.runtime_manifest_hash.slice(0, 12)} 实际 ${hb.runtime_manifest_hash.slice(0, 12)}`);
  }
  dispatchPending(); // 事件：Worker READY
}

/**
 * 租约过期扫描（watchdog 5s）
 * LEASED 且 lease 过期 → 回 PENDING（attempt+1），达上限判 SE
 */
function sweepExpiredLeases() {
  const t = now();
  for (const s of db.submissions.all()) {
    if (s.status === 'LEASED' && s.lease && t > s.lease.expires_at) {
      activeTasks.delete(s.taskId);
      workerRegistry.releaseTask(s.workerId, s.taskId);
      const attempt = (s.attempt || 0) + 1;
      // 记录 attempt 历史为 EXPIRE
      if (s.currentAttemptId) {
        db.judgeAttempts.update(s.currentAttemptId, { status: 'EXPIRE', finishedAt: new Date().toISOString() });
      }
      if (attempt >= config.maxAttempt) {
        db.submissions.update(s.id, { status: 'SE', message: `租约超时重试 ${attempt} 次仍失败` });
      } else {
        db.submissions.update(s.id, { status: 'PENDING', attempt, lease: null, taskId: null, workerId: null });
      }
      hub.emit('admin', 'lease_expired', { submission_id: s.id, attempt });
      dispatchPending(); // 事件：Lease expired
    }
  }
}

/** watchdog：调度器仅由 :3001 (contest) 入口启用 */
if (config.entry === 'all' || config.entry === 'contest') {
  setInterval(sweepExpiredLeases, config.LEASE_SWEEP_INTERVAL);
  setInterval(dispatchPending, config.SCHEDULER_FALLBACK_SCAN);
}

/** 管理端重判：创建新 attempt（不覆盖旧结果），立即调度 */
function rejudge(submissionId) {
  const s = db.submissions.byId(submissionId);
  if (!s) return null;
  const attempt = (s.attempt || 0) + 1;
  // 保留旧结果于 judgeAttempts，submission 重置为 PENDING 开启新 attempt
  db.submissions.update(s.id, {
    status: 'PENDING', attempt, lease: null, taskId: null, workerId: null,
    spotCheckMeta: null, message: '', cases: [], timeMs: 0, memoryKb: 0
  });
  dispatchPending(); // 事件：Admin rejudge
  return 'PENDING';
}

/** 跨节点抽查：同一 submission 派发第二 Worker 重判比对 */
function spotCheck(submissionId) {
  const s = db.submissions.byId(submissionId);
  if (!s || !s.taskId) return { ok: false, error: '提交无任务可抽查' };
  db.submissions.update(s.id, {
    spotCheckMeta: { original: { status: s.status, cases: s.cases }, at: new Date().toISOString() }
  });
  db.submissions.update(s.id, { status: 'PENDING', attempt: s.attempt, lease: null, taskId: null, workerId: null });
  const ret = dispatchOne(db.submissions.byId(submissionId));
  return ret ? { ok: true, task: ret } : { ok: false, error: '无可用 Worker 抽查' };
}

/** 接受结果回传：验签/幂等/持久化 attempt 结果/状态推进/更新内存榜单 */
function acceptReport(worker, report) {
  const info = activeTasks.get(report.task_id);
  if (!info) return { ok: false, error: '任务不存在或已处理' };
  if (info.worker_id !== worker.id) return { ok: false, error: '任务不属于该 Worker' };
  if (report.lease_id !== info.lease.lease_id) return { ok: false, error: '租约不匹配' };
  if (checkLeaseUsed(report.lease_id)) return { ok: false, error: '租约已使用（重复回传）', dup: true };

  const sub = db.submissions.byId(report.submission_id);
  let verdict = report.status;
  let message = report.message || '';

  // 抽查比对
  if (sub && sub.spotCheckMeta) {
    const orig = sub.spotCheckMeta.original;
    const same = orig.status === report.status;
    message = `抽查比对：原结果 ${orig.status}，复测结果 ${report.status}，${same ? '一致' : '不一致(进入人工复核)'}`;
    if (!same) {
      db.submissions.update(sub.id, { status: 'WA', message, spotCheckMeta: { ...sub.spotCheckMeta, rechecked: report.status, at: new Date().toISOString() } });
      hub.emit('admin', 'spotcheck_mismatch', { submission_id: sub.id, orig: orig.status, recheck: report.status });
      return { ok: true, mismatched: true };
    }
    verdict = report.status;
  }

  // 短事务：更新 attempt 历史为 FINISHED + 更新 submission
  if (sub && sub.currentAttemptId) {
    db.judgeAttempts.update(sub.currentAttemptId, {
      status: 'FINISHED', result: verdict, cases: report.cases || [],
      timeMs: report.time_ms || 0, memoryKb: report.memory_kb || 0,
      message, finishedAt: new Date().toISOString(), runtimeManifestHash: report.runtime_manifest_hash
    });
  }

  activeTasks.delete(report.task_id);
  workerRegistry.releaseTask(worker.id, report.task_id);
  const updated = db.submissions.update(report.submission_id, {
    status: verdict, cases: report.cases || [], timeMs: report.time_ms || 0,
    memoryKb: report.memory_kb || 0, message, judgedAt: new Date().toISOString(),
    env: report.env, runtimeManifestHash: report.runtime_manifest_hash,
    spotCheckMeta: null
  });

  // 更新内存榜单（Scoreboard Runtime）
  scoreboard.onVerdict(updated);
  dispatchPending(); // 事件：Worker task finished

  hub.broadcastPage('submission_update', {
    id: updated.id, status: updated.status, timeMs: updated.timeMs, memoryKb: updated.memoryKb,
    userId: updated.userId, problemId: updated.problemId
  });
  hub.emit('admin', 'task_report', { task_id: report.task_id, submission_id: report.submission_id, status: verdict });
  return { ok: true };
}

function recordAnomaly(worker, reason) {
  const count = (worker.anomalyCount || 0) + 1;
  const offline = count >= config.deviceAnomalyThreshold;
  db.workers.update(worker.id, {
    anomalyCount: count, anomalyReason: reason, anomalyAt: new Date().toISOString(),
    ...(offline ? { suspended: true } : {})
  });
  workerRegistry.onConfigChange(worker.id, { suspended: offline });
  hub.emit('admin', 'worker_anomaly', { worker_id: worker.id, reason, count, offline, at: new Date().toISOString() });
  if (offline) {
    for (const [tid, info] of activeTasks) {
      if (info.worker_id === worker.id) {
        activeTasks.delete(tid);
        const s = db.submissions.byId(info.submission_id);
        if (s && s.status === 'LEASED') db.submissions.update(s.id, { status: 'PENDING', lease: null, taskId: null, workerId: null });
      }
    }
    workerQueues.delete(worker.id);
    dispatchPending();
  }
}

module.exports = {
  submit, dispatchOne, dispatchPending, pushToWorker, pullTasks,
  handleHeartbeat, sweepExpiredLeases, spotCheck, rejudge, acceptReport, recordAnomaly,
  pickWorker
};
