'use strict';
/**
 * JudgeService —— 服务器端正式评测编排（Phase 4 主链路）
 *
 * 职责：
 *  - QUEUED → JUDGING → FINISHED(+verdict) 状态推进（唯一推进方）
 *  - 调用 JudgeAdapter（DEV ONLY spawn gcc/g++/python）跑 hidden test
 *  - 每步独立短事务持久化（禁止在 SQLite 事务内等待 Judge/网络）
 *  - SSE 推送状态变更给 Contestant
 *  - 启动恢复：扫描 QUEUED/JUDGING，QUEUED 重新 enqueue，JUDGING 标 SYSTEM_ERROR 或重试
 *
 * Judge 层只接收 submissionId/source/language/limits/testcases，不接收 Cookie/Session/密码。
 */
const submissionRepo = require('../store/repositories/submission-repository');
const problemRepo = require('../store/repositories/problem-repository');
const { SUB_STATUS, VERDICT, validateTransition, isFinished } = require('./submission-state');
const { judgeSubmission } = require('../judge/judge-adapter');
const hub = require('../sse/hub');
const scoreboard = require('./scoreboard');

/** 内存态：submissionId -> in-flight（供快速 SSE / 状态查询） */
const inFlight = new Map();

let dispatchQueue = Promise.resolve();

/** 串行化评测，避免并发 spawn 过多（DEV ONLY 简单限流） */
function enqueue(fn) {
  dispatchQueue = dispatchQueue.then(fn).catch((err) => {
    console.error('[judge] 评测队列错误:', err.message);
  });
  return dispatchQueue;
}

/** SSE 推送某提交状态 */
function emitSubmission(sub) {
  hub.broadcastPage('submission_update', {
    id: sub.id,
    contestId: sub.contestId,
    problemId: sub.problemId,
    status: sub.status,
    verdict: sub.verdict || null,
    executionTimeMs: sub.executionTimeMs,
    memoryKb: sub.memoryKb
  });
}

/**
 * 评测一条提交：读取问题隐藏测试 → JUDGING → JudgeAdapter → 短事务写终态 → SSE。
 * @param {object} submission 提交对象（关系库）
 */
async function runJudge(submission) {
  // QUEUED → JUDGING（短事务）
  let cur = submissionRepo.findById(submission.id);
  if (!cur) return;
  let check = validateTransition(cur, SUB_STATUS.JUDGING);
  if (!check.ok) { console.warn('[judge] 无法进入 JUDGING:', check.error); return; }
  cur = submissionRepo.updateStatus(submission.id, { status: SUB_STATUS.JUDGING, judgeStartedAt: new Date().toISOString() });
  inFlight.set(submission.id, cur);
  emitSubmission(cur);
  console.log('[judge:transition]', JSON.stringify({
    submissionId: cur.id, userId: cur.userId, problemId: cur.problemId,
    language: cur.language, from: 'QUEUED', to: SUB_STATUS.JUDGING, at: cur.judgeStartedAt
  }));

  // 读取问题（含隐藏测试，仅服务端）
  const problem = problemRepo.findById(submission.problemId);
  const testcases = problemRepo.getTestcases(problem);
  const timeLimitMs = problem ? problem.time_limit_ms : 1000;
  const memoryLimitMb = problem ? problem.memory_limit_mb : 256;

  let result;
  try {
    result = await judgeSubmission({
      language: submission.language,
      source: submission.sourceCode,
      problemId: submission.problemId,
      timeLimitMs,
      memoryLimitMb,
      testcases
    });
  } catch (err) {
    result = {
      verdict: VERDICT.SYSTEM_ERROR,
      executionTimeMs: 0,
      memoryKb: 0,
      compileMessage: '',
      runtimeMessage: 'Judge 执行异常: ' + err.message
    };
  }

  // 短事务写 FINISHED + verdict
  const finished = submissionRepo.updateStatus(submission.id, {
    status: SUB_STATUS.FINISHED,
    verdict: result.verdict,
    judgeFinishedAt: new Date().toISOString(),
    executionTimeMs: result.executionTimeMs,
    memoryKb: result.memoryKb,
    compileMessage: result.compileMessage,
    runtimeMessage: result.runtimeMessage
  });
  inFlight.delete(submission.id);
  emitSubmission(finished);

  // 结构化终态日志：verdict + judge duration（不含 source / Cookie / 密码）
  const durationMs = (finished.judgeStartedAt && finished.judgeFinishedAt)
    ? (new Date(finished.judgeFinishedAt).getTime() - new Date(finished.judgeStartedAt).getTime())
    : null;
  console.log('[judge:verdict]', JSON.stringify({
    submissionId: finished.id, userId: finished.userId, problemId: finished.problemId,
    language: finished.language, verdict: finished.verdict, status: SUB_STATUS.FINISHED,
    judgeDurationMs: durationMs, executionTimeMs: finished.executionTimeMs, memoryKb: finished.memoryKb,
    compilerPath: result.compilerEvidence ? result.compilerEvidence.compilerPath : null,
    compilerVersion: result.compilerEvidence ? result.compilerEvidence.compilerVersion : null,
    compilerStandard: result.compilerEvidence ? result.compilerEvidence.standard : null,
    compilerOptimization: result.compilerEvidence ? result.compilerEvidence.optimization : null
  }));

  // Phase 5：Submission FINISHED → 从 SQLite 重算该选手榜单状态 → 10s batch → SSE delta。
  // 个人 submission SSE 已在上方 emitSubmission 独立推送（QUEUED/JUDGING/FINISHED 尽快通知本人）。
  try {
    scoreboard.onFinished(submission.contestId, submission.userId);
  } catch (err) {
    console.error('[judge:scoreboard] 更新榜单失败:', err.message);
  }
}

/** 提交正式评测入口（SubmissionService 在 INSERT 提交后调用） */
function dispatch(submission) {
  console.log('[judge:enqueue]', JSON.stringify({
    submissionId: submission.id, userId: submission.userId, problemId: submission.problemId,
    language: submission.language, status: submission.status, receivedAt: submission.serverReceivedAt
  }));
  // 已经打开“我的提交”页面的浏览器可通过 SSE 看到完整 QUEUED → JUDGING → FINISHED 链路。
  emitSubmission(submission);
  enqueue(() => runJudge(submission));
}

/** 启动恢复：扫描 QUEUED/JUDGING，避免永久卡住 */
function init() {
  const inFlightList = submissionRepo.listInFlight();
  let requeued = 0, errored = 0;
  for (const s of inFlightList) {
    if (s.status === SUB_STATUS.QUEUED) {
      // 可重新 enqueue
      dispatch(s);
      requeued++;
    } else if (s.status === SUB_STATUS.JUDGING) {
      // 当前进程无法恢复半途 Judge → 标记 SYSTEM_ERROR（或重新 enqueue，这里选标记）
      submissionRepo.updateStatus(s.id, {
        status: SUB_STATUS.FINISHED,
        verdict: VERDICT.SYSTEM_ERROR,
        judgeFinishedAt: new Date().toISOString(),
        runtimeMessage: '服务重启，无法恢复进行中的评测'
      });
      errored++;
    }
  }
  if (inFlightList.length) {
    console.log(`[judge] 启动恢复：QUEUED 重新入队 ${requeued}，JUDGING 标记 SYSTEM_ERROR ${errored}`);
  }
}

function getInFlight(id) {
  return inFlight.get(id) || null;
}

module.exports = { dispatch, init, runJudge, getInFlight };
