'use strict';
/**
 * 可信 Worker 评测协议（中心控制面 :3001 ↔ 可信执行域）
 * - 注册：注册码换取 worker_id + secret + 证书ID（secret 仅此一次返回）—— 首次注册才写 DB 环境信息
 * - SSE 任务流 / 轮询拉取兜底（定向调度）
 * - 心跳：只更新内存 Worker Registry（不写 SQLite）
 * - 结果回传（验签 + 租约幂等 + 状态推进 + attempt 历史 + 抽查比对）
 */
const express = require('express');
const db = require('../store/db');
const hub = require('../sse/hub');
const scheduler = require('../services/scheduler');
const workerRegistry = require('../services/worker-registry');
const audit = require('../services/audit');
const trust = require('../security/trust');

const router = express.Router();

/** 从请求解析 Worker（静态字段读 DB，在线状态读内存） */
function authenticateWorker(req) {
  const workerId = req.body?.worker_id || req.query.worker_id;
  const w = db.workers.byId(workerId);
  if (!w) return { error: 'Worker 不存在', status: 404 };
  if (w.suspended) return { error: 'Worker 已被挂起', status: 403 };
  return { worker: w };
}

// 注册（注册码换取凭据；首次注册写 DB 静态环境信息）
router.post('/register', (req, res) => {
  const { code, name, hostname, os } = req.body || {};
  if (!code) return res.status(400).json({ error: '注册码必填' });
  const rc = db.registerCodes.findOne((c) => c.code === code && !c.used);
  if (!rc) return res.status(403).json({ error: '注册码无效或已被使用' });

  const secret = trust.generateWorkerSecret();
  const worker = db.workers.insert({
    name: name || hostname || 'Worker',
    hostname: hostname || '',
    os: os || 'windows-wsl',
    certId: trust.generateWorkerCertId(),
    secret,
    tier: 'sink',
    trust_status: 'pending',
    suspended: false,
    anomalyCount: 0,
    runtime_manifest_hash: null,
    envFingerprint: null,
    registeredAt: new Date().toISOString()
  });
  db.registerCodes.update(rc.id, { used: true, usedBy: worker.id, usedAt: new Date().toISOString() });
  workerRegistry.onConnect(worker.id);
  audit.log('register', { worker: worker.id, name: worker.name });
  res.json({
    worker_id: worker.id, cert_id: worker.certId, secret,
    trust_status: 'pending',
    heartbeat_interval_ms: workerRegistry.nextHeartbeatInterval()
  });
});

// SSE 任务流（鉴权：streamToken 分钟窗；连接即标记内存在线）
router.get('/events', (req, res) => {
  const { worker_id, token } = req.query;
  const w = db.workers.byId(worker_id);
  if (!w) return res.status(404).json({ error: 'Worker 不存在' });
  if (w.suspended) return res.status(403).json({ error: 'Worker 已挂起' });
  const expect = trust.sha256(`${w.id}:${w.secret}:${Math.floor(Date.now() / 60000)}`);
  const expectPrev = trust.sha256(`${w.id}:${w.secret}:${Math.floor((Date.now() - 60000) / 60000)}`);
  if (token !== expect && token !== expectPrev) return res.status(401).json({ error: '流令牌无效' });
  workerRegistry.onConnect(w.id);
  hub.join(`worker:${w.id}`, res);
  scheduler.dispatchPending(); // 事件：Worker reconnect
});

// 轮询拉取兜底
router.post('/pull', (req, res) => {
  const auth = authenticateWorker(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { worker } = auth;
  const { nonce, ts } = req.body || {};
  const check = trust.checkNonce(nonce, Number(ts));
  if (!check.ok) return res.status(401).json({ error: check.reason });
  const hb = { worker_id: worker.id, nonce, ts: Number(ts), sig: req.body?.sig };
  if (!trust.verifyHeartbeatSig(hb, worker.secret)) return res.status(401).json({ error: '签名校验失败' });
  workerRegistry.onHeartbeat(worker.id, {});
  scheduler.dispatchPending();
  res.json({ tasks: scheduler.pullTasks(worker.id) });
});

// 心跳：只更新内存，不写 DB
router.post('/heartbeat', (req, res) => {
  const auth = authenticateWorker(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { worker } = auth;
  const { nonce, ts } = req.body || {};
  const check = trust.checkNonce(nonce, Number(ts));
  if (!check.ok) return res.status(401).json({ error: check.reason });
  const hb = { worker_id: worker.id, nonce, ts: Number(ts), runtime_manifest_hash: req.body?.runtime_manifest_hash, sig: req.body?.sig };
  if (!trust.verifyHeartbeatSig(hb, worker.secret)) {
    scheduler.recordAnomaly(worker, '心跳签名校验失败');
    return res.status(401).json({ error: '签名校验失败' });
  }
  workerRegistry.onHeartbeat(worker.id, {
    runtime_manifest_hash: req.body?.runtime_manifest_hash,
    cpuUsage: req.body?.cpuUsage,
    memoryUsage: req.body?.memoryUsage,
    slots: req.body?.slots
  });
  // 环境指纹只首次注册/变化时写 DB
  if (req.body?.runtime_manifest_hash && worker.runtime_manifest_hash !== req.body.runtime_manifest_hash) {
    db.workers.update(worker.id, {
      runtime_manifest_hash: req.body.runtime_manifest_hash,
      envFingerprint: req.body?.env || worker.envFingerprint
    });
  }
  scheduler.handleHeartbeat(worker, req.body);
  res.json({ ok: true, interval_ms: workerRegistry.nextHeartbeatInterval() });
});

// 结果回传
router.post('/report', (req, res) => {
  const auth = authenticateWorker(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });
  const { worker } = auth;
  const report = req.body || {};
  for (const f of ['task_id', 'submission_id', 'attempt', 'lease_id', 'status', 'nonce', 'sig']) {
    if (report[f] === undefined) return res.status(400).json({ error: `缺少字段 ${f}` });
  }
  const check = trust.checkNonce(report.nonce, Number(report.ts));
  if (!check.ok) {
    scheduler.recordAnomaly(worker, `结果重放被拒：${check.reason}`);
    audit.log('verify_failed', { worker: worker.id, task: report.task_id, reason: check.reason });
    return res.status(401).json({ error: check.reason });
  }
  if (!trust.verifyReportSig(report, worker.secret)) {
    scheduler.recordAnomaly(worker, '结果签名校验失败（疑似伪造）');
    audit.log('verify_failed', { worker: worker.id, task: report.task_id, reason: '签名校验失败' });
    return res.status(401).json({ error: '签名校验失败' });
  }
  const result = scheduler.acceptReport(worker, report);
  if (!result.ok) {
    if (!result.dup) scheduler.recordAnomaly(worker, `结果被拒：${result.error}`);
    audit.log('report_reject', { worker: worker.id, task: report.task_id, reason: result.error });
    return res.status(400).json({ error: result.error });
  }
  audit.log('report', { worker: worker.id, task: report.task_id, submission: report.submission_id, status: result.mismatched ? '抽查不一致' : report.status });
  res.json({ ok: true });
});

module.exports = router;
