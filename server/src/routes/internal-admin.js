'use strict';
/**
 * :3001 OJ Core 内部管理 API（仅 :3002 Admin 服务经 internalAuth 调用）
 * 唯一的 DB Owner 与唯一的 Scheduler 都在这：
 * - 所有管理操作（重判/抽查/审批/题目/节点）都直接操作本进程的 DB 与 Scheduler
 * - :3002 Admin 不直连 SQLite、不创建 Scheduler，全部经本路由代理
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../store/db');
const hub = require('../sse/hub');
const scheduler = require('../services/scheduler');
const audit = require('../services/audit');
const workerRegistry = require('../services/worker-registry');
const config = require('../config');
const { internalAuth } = require('../middleware/internalAuth');
const { generateRegisterCode } = require('../security/trust');

const router = express.Router();

/* 管理端登录（独立认证逻辑，与选手端隔离）：仅供 :3002 Admin 代理调用，只允许管理员 */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users.findOne((x) => x.username === username);
  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) return res.status(401).json({ error: '用户名或密码错误' });
  if (u.banned) return res.status(403).json({ error: '账号已被封禁' });
  if (u.role !== 'admin') return res.status(403).json({ error: '仅管理员可登录管理端' });
  const token = jwt.sign({ id: u.id, username: u.username, role: u.role }, config.jwtSecret, { expiresIn: config.jwtExpires });
  audit.log('admin_login', { user: u.id, username: u.username });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 });
  res.json({ token, user: { id: u.id, username: u.username, nickname: u.nickname, role: u.role } });
});

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

/* ================= 比赛管理 ================= */
router.get('/contests', (_req, res) => {
  const list = db.contests.all().sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  res.json({ contests: list });
});
router.get('/contests/:id', (req, res) => {
  const c = db.contests.byId(req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  res.json({ contest: c });
});
router.post('/contests', (req, res) => {
  const { title, description, startTimeMs } = req.body || {};
  if (!title) return res.status(400).json({ error: '标题必填' });
  const startMs = Number(startTimeMs) || Date.now();
  const c = db.contests.insert({
    title, description: description || '',
    startTimeMs: startMs,
    status: startMs > Date.now() ? 'upcoming' : 'ongoing',
    problemIds: [], createdAt: new Date().toISOString()
  });
  audit.log('create_contest', { contest: c.id, title: c.title });
  res.json({ contest: c });
});
router.put('/contests/:id', (req, res) => {
  const c = db.contests.byId(req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  const patch = {};
  if (req.body.title !== undefined) patch.title = req.body.title;
  if (req.body.description !== undefined) patch.description = req.body.description;
  if (req.body.startTimeMs !== undefined) {
    patch.startTimeMs = Number(req.body.startTimeMs) || c.startTimeMs;
    patch.status = patch.startTimeMs > Date.now() ? 'upcoming' : 'ongoing';
  }
  if (req.body.problemIds !== undefined) patch.problemIds = req.body.problemIds;
  const updated = db.contests.update(c.id, patch);
  audit.log('update_contest', { contest: c.id });
  res.json({ contest: updated });
});
router.delete('/contests/:id', (req, res) => {
  const c = db.contests.byId(req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  // 级联删除该比赛下的题目与提交
  db.problems.find((p) => p.contestId === c.id).forEach((p) => db.problems.remove(p.id));
  db.submissions.find((s) => s.contestId === c.id).forEach((s) => db.submissions.remove(s.id));
  db.contests.remove(c.id);
  audit.log('delete_contest', { contest: c.id });
  res.json({ ok: true });
});

/* ================= 题目管理（比赛制：contestId + md 题面 + gen/solution 代码） ================= */
const testdata = require('../services/testdata');

// 编译探活（供管理端判断能否用 gen/solution 自动生成）
router.get('/compiler', async (_req, res) => {
  const ok = await testdata.probeCompiler();
  res.json({ gxx: ok });
});

router.get('/problems', (_req, res) => {
  const list = db.problems.all().sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json({ problems: list });
});
router.get('/problems/:id', (req, res) => {
  const p = db.problems.byId(req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  res.json({ problem: p });
});
router.post('/problems', async (req, res) => {
  const { title, description, contestId, timeLimitMs, memoryLimitMb, samples, testcases, genCode, solutionCode, autoGen } = req.body || {};
  if (!title) return res.status(400).json({ error: '标题必填' });
  if (!contestId) return res.status(400).json({ error: '请选择所属比赛' });
  const contest = db.contests.byId(contestId);
  if (!contest) return res.status(400).json({ error: '所属比赛不存在' });
  try {
    // 若启用自动生成且提供了 gen/solution，则用 g++ 生成测试数据；否则用手动 testcases fallback
    let finalTestcases = (testcases || []).map((t, i) => ({ id: i + 1, input: t.input || '', answer: t.answer || '' }));
    let genWarnings = [];
    if (autoGen && genCode && solutionCode) {
      const resData = await testdata.generateTestcases(genCode, solutionCode);
      finalTestcases = resData.testcases;
      genWarnings = resData.warnings || [];
    }
    const maxOrder = Math.max(0, ...db.problems.all().filter((p) => p.contestId === contestId).map((p) => p.order || 0));
    const p = db.problems.insert({
      contestId, title, description: description || '',
      timeLimitMs: Number(timeLimitMs) || 1000, memoryLimitMb: Number(memoryLimitMb) || 256,
      samples: samples || [{ input: '', output: '' }],
      testcases: finalTestcases, genCode: genCode || '', solutionCode: solutionCode || '',
      order: maxOrder + 1, version: 1, testdataHash: hashTestdata(finalTestcases)
    });
    // 更新比赛的 problemIds
    db.contests.update(contestId, { problemIds: [...(contest.problemIds || []), p.id] });
    audit.log('create_problem', { problem: p.id, title: p.title, contest: contestId });
    res.json({ problem: p, warnings: genWarnings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.put('/problems/:id', async (req, res) => {
  const p = db.problems.byId(req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  const patch = {};
  try {
    if (req.body.title !== undefined) patch.title = req.body.title;
    if (req.body.contestId !== undefined) patch.contestId = req.body.contestId;
    if (req.body.description !== undefined) patch.description = req.body.description;
    if (req.body.samples !== undefined) patch.samples = req.body.samples;
    if (req.body.timeLimitMs !== undefined) patch.timeLimitMs = Number(req.body.timeLimitMs) || p.timeLimitMs;
    if (req.body.memoryLimitMb !== undefined) patch.memoryLimitMb = Number(req.body.memoryLimitMb) || p.memoryLimitMb;
    if (req.body.genCode !== undefined) patch.genCode = req.body.genCode;
    if (req.body.solutionCode !== undefined) patch.solutionCode = req.body.solutionCode;

    // 测试数据来源：优先 autoGen（gen/solution 自动生成），否则手动 testcases
    let genWarnings = [];
    if (req.body.autoGen && (patch.genCode ?? p.genCode) && (patch.solutionCode ?? p.solutionCode)) {
      const resData = await testdata.generateTestcases(
        patch.genCode ?? p.genCode,
        patch.solutionCode ?? p.solutionCode
      );
      patch.testcases = resData.testcases;
      genWarnings = resData.warnings || [];
    } else if (req.body.testcases !== undefined) {
      patch.testcases = (req.body.testcases || []).map((t, i) => ({ id: i + 1, input: t.input || '', answer: t.answer || '' }));
    }
    if (patch.testcases !== undefined) patch.testdataHash = hashTestdata(patch.testcases);

    patch.version = (p.version || 1) + 1;
    const updated = db.problems.update(p.id, patch);
    // 若变更了所属比赛，同步更新两个比赛的 problemIds
    if (patch.contestId && patch.contestId !== p.contestId) {
      const oldC = db.contests.byId(p.contestId);
      if (oldC) db.contests.update(oldC.id, { problemIds: (oldC.problemIds || []).filter((x) => x !== p.id) });
      const newC = db.contests.byId(patch.contestId);
      if (newC && !(newC.problemIds || []).includes(p.id)) {
        db.contests.update(newC.id, { problemIds: [...(newC.problemIds || []), p.id] });
      }
    }
    audit.log('update_problem', { problem: p.id, version: patch.version });
    res.json({ problem: updated, warnings: genWarnings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
router.delete('/problems/:id', (req, res) => {
  const p = db.problems.byId(req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  // 从所属比赛的 problemIds 移除
  const c = db.contests.byId(p.contestId);
  if (c) db.contests.update(c.id, { problemIds: (c.problemIds || []).filter((x) => x !== p.id) });
  db.problems.remove(req.params.id);
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
