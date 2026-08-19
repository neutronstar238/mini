'use strict';
/**
 * :3001 OJ Core 内部管理 API（仅 :3002 Admin 服务经 internalAuth 调用）
 * 唯一的 DB Owner 与唯一的 Scheduler 都在这：
 * - 所有管理操作（重判/抽查/审批/题目/节点）都直接操作本进程的 DB 与 Scheduler
 * - :3002 Admin 不直连 SQLite、不创建 Scheduler，全部经本路由代理
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../store/db');
const hub = require('../sse/hub');
const scheduler = require('../services/scheduler');
const audit = require('../services/audit');
const workerRegistry = require('../services/worker-registry');
const { internalAuth } = require('../middleware/internalAuth');
const { generateRegisterCode } = require('../security/trust');

const router = express.Router();
router.use(internalAuth);

/* ================= 总览 ================= */
router.get('/overview', (_req, res) => {
  const subs = db.submissions.all();
  res.json({
    users: db.users.all().length,
    problems: db.problems.all().length,
    submissions: subs.length,
    ac: subs.filter((s) => s.status === 'AC').length,
    pending: subs.filter((s) => ['PENDING', 'SUBMITTED'].includes(s.status)).length,
    judging: subs.filter((s) => ['LEASED', 'COMPILING', 'RUNNING', 'VERIFYING'].includes(s.status)).length,
    workers: db.workers.all().length,
    onlineWorkers: workerRegistry.onlineCount(),
    approvedWorkers: db.workers.find((w) => w.trust_status === 'approved').length,
    anomalies: db.workers.all().reduce((n, w) => n + (w.anomalyCount || 0), 0)
  });
});

/* ================= 节点（Worker 列表，实时状态来自内存 Registry） ================= */
router.get('/nodes', (_req, res) => {
  const live = workerRegistry.snapshot();
  res.json({ workers: live.map((w) => workerRegistry.publicWorker(w)) });
});

// 认证为可信 / 审批 / 挂起（仅写 DB：Worker 静态字段）
router.post('/nodes/:id/tier', (req, res) => {
  const w = db.workers.byId(req.params.id);
  if (!w) return res.status(404).json({ error: 'Worker 不存在' });
  const tier = req.body?.tier === 'trusted' ? 'trusted' : 'sink';
  db.workers.update(w.id, { tier });
  workerRegistry.onConfigChange(w.id, { tier });
  audit.log('tier', { worker: w.id, tier });
  res.json({ ok: true, tier });
});

router.post('/nodes/:id/approve', (req, res) => {
  const w = db.workers.byId(req.params.id);
  if (!w) return res.status(404).json({ error: 'Worker 不存在' });
  const status = req.body?.approved === false ? 'pending' : 'approved';
  db.workers.update(w.id, { trust_status: status, anomalyCount: 0, suspended: false });
  workerRegistry.onConfigChange(w.id, { trust_status: status, suspended: false });
  audit.log('approve', { worker: w.id, status });
  res.json({ ok: true, trust_status: status });
});

router.post('/nodes/:id/suspend', (req, res) => {
  const w = db.workers.byId(req.params.id);
  if (!w) return res.status(404).json({ error: 'Worker 不存在' });
  const suspended = req.body?.suspend !== false;
  db.workers.update(w.id, { suspended });
  workerRegistry.onConfigChange(w.id, { suspended });
  audit.log('suspend', { worker: w.id, on: suspended });
  res.json({ ok: true });
});

/* ================= 证书 / 注册码 ================= */
router.get('/certs', (_req, res) => {
  res.json({ codes: db.registerCodes.all().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});
router.post('/certs', (_req, res) => {
  const code = db.registerCodes.insert({ code: generateRegisterCode(), used: false, note: 'Worker 注册码' });
  audit.log('gen_code', { code: code.code });
  res.json({ code });
});

/* ================= 队列 ================= */
router.get('/queue', (_req, res) => {
  const subs = db.submissions.all();
  const rank = ['SUBMITTED', 'PENDING', 'LEASED', 'COMPILING', 'RUNNING', 'VERIFYING'];
  subs.sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status) || new Date(a.createdAt) - new Date(b.createdAt));
  res.json({ submissions: subs.filter((s) => !['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'SE'].includes(s.status)) });
});

/* ================= 审计 / 日志 ================= */
router.get('/audit', (_req, res) => res.json({ events: audit.recent(200) }));

/* ================= 题目管理 ================= */
router.get('/problems', (_req, res) => res.json({ problems: db.problems.all().sort((a, b) => (a.order || 0) - (b.order || 0)) }));
router.get('/problems/:id', (req, res) => {
  const p = db.problems.byId(req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  res.json({ problem: p });
});
router.post('/problems', (req, res) => {
  const { title, description, difficulty, timeLimitMs, memoryLimitMb, samples, testcases, tags } = req.body || {};
  if (!title) return res.status(400).json({ error: '标题必填' });
  const maxOrder = Math.max(0, ...db.problems.all().map((p) => p.order || 0));
  const p = db.problems.insert({
    title, description: description || '', difficulty: difficulty || '简单',
    timeLimitMs: Number(timeLimitMs) || 1000, memoryLimitMb: Number(memoryLimitMb) || 256,
    samples: samples || [{ input: '', output: '' }],
    testcases: (testcases || []).map((t, i) => ({ id: i + 1, input: t.input || '', answer: t.answer || '' })),
    tags: tags || [], order: maxOrder + 1, version: 1, testdataHash: hashTestdata(testcases || [])
  });
  audit.log('create_problem', { problem: p.id, title: p.title });
  res.json({ problem: p });
});
router.put('/problems/:id', (req, res) => {
  const p = db.problems.byId(req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  const patch = {};
  for (const k of ['title', 'description', 'difficulty', 'samples', 'tags']) if (req.body[k] !== undefined) patch[k] = req.body[k];
  if (req.body.timeLimitMs !== undefined) patch.timeLimitMs = Number(req.body.timeLimitMs) || p.timeLimitMs;
  if (req.body.memoryLimitMb !== undefined) patch.memoryLimitMb = Number(req.body.memoryLimitMb) || p.memoryLimitMb;
  if (req.body.testcases !== undefined) {
    patch.testcases = (req.body.testcases || []).map((t, i) => ({ id: i + 1, input: t.input || '', answer: t.answer || '' }));
    patch.testdataHash = hashTestdata(req.body.testcases || []);
  }
  patch.version = (p.version || 1) + 1;
  audit.log('update_problem', { problem: p.id, version: patch.version });
  res.json({ problem: db.problems.update(p.id, patch) });
});
router.delete('/problems/:id', (req, res) => {
  if (!db.problems.remove(req.params.id)) return res.status(404).json({ error: '题目不存在' });
  audit.log('delete_problem', { problem: req.params.id });
  res.json({ ok: true });
});

/** 测试数据哈希：对 input+answer 规范化后聚合 SHA-256 */
function hashTestdata(testcases) {
  const parts = (testcases || []).map((t) => `${t.input}\u0000${t.answer}`);
  return crypto.createHash('sha256').update(parts.join('\u0001')).digest('hex');
}

/* ================= 重判 / 抽查（唯一 Scheduler 在此触发） ================= */
router.post('/rejudge/:submissionId', (req, res) => {
  const s = db.submissions.byId(req.params.submissionId);
  if (!s) return res.status(404).json({ error: '提交不存在' });
  const result = scheduler.rejudge(s.id);
  audit.log('rejudge', { submission: s.id, adminVia: 'internal' });
  res.json({ ok: true, status: result });
});

router.post('/spotcheck/:submissionId', (req, res) => {
  const result = scheduler.spotCheck(req.params.submissionId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  audit.log('spotcheck', { submission: req.params.submissionId, task: result.task.task_id });
  res.json({ ok: true, task: { task_id: result.task.task_id, worker: result.task.worker_id } });
});

/* ================= 内部 SSE 事件流（:3002 Admin 桥接） ================= */
router.get('/events', (req, res) => {
  // 校验 query 令牌（admin-v2 生成）
  const token = req.query.token;
  const ts = req.query.ts;
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || !token || !ts) return res.status(401).json({ error: '缺少令牌' });
  const expect = crypto.createHmac('sha256', secret).update(`${ts}:/internal/admin/events`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expect))) return res.status(401).json({ error: '令牌无效' });
  // 复用 admin 通道（:3001 的 hub 已广播 admin 事件）
  hub.join('admin', res);
});

module.exports = router;
