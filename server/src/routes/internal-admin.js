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
// Phase 5：关系库权威 Admin（仅 OJ Core 直连 SQLite）
const submissionRepo = require('../store/repositories/submission-repository');
const contestRepo = require('../store/repositories/contest-repository');
const userRepo = require('../store/repositories/user-repository');
const scoreboard = require('../services/scoreboard');
const metrics = require('../store/db-metrics');
const clientDevices = require('../services/client-device-service');

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
  const official = submissionRepo.overviewCounts();
  res.json({
    users: db.users.all().length,
    problems: db.problems.all().length,
    submissions: official.submissions,
    ac: official.ac,
    pending: official.pending,
    judging: official.judging,
    judgeBackend: 'JudgeAdapter'
  });
});

/* ================= 选手 Chrome 客户端设备 ================= */
router.get('/devices', (_req, res) => {
  res.json(clientDevices.list());
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

/* ================= Phase 5：关系库 Admin（submission 查询 / 详情 / 真实榜单 / 用户） ================= */

/**
 * GET /internal/admin/contests/:id/submissions
 * 分页 + 过滤（problemId / userId / language / verdict）。列表不返回完整源码。
 */
router.get('/contests/:id/submissions', (req, res) => {
  const r = submissionRepo.listAdminByContest(req.params.id, {
    page: req.query.page,
    pageSize: req.query.pageSize,
    problemId: req.query.problemId,
    userId: req.query.userId,
    language: req.query.language,
    verdict: req.query.verdict
  });
  // 列表不含 source_code
  const list = r.rows.map((s) => ({
    id: s.id,
    contestId: s.contest_id,
    problemId: s.problem_id,
    problemTitle: s.problem_title || '',
    problemLabel: s.problem_label || '',
    userId: s.user_id,
    username: s.username || '',
    language: s.language,
    status: s.status,
    verdict: s.verdict || null,
    serverReceivedAt: s.server_received_at,
    executionTimeMs: s.execution_time_ms,
    memoryKb: s.memory_kb
  }));
  res.json({ total: r.total, page: r.page, pageSize: r.pageSize, submissions: list });
});

/**
 * GET /internal/admin/submissions/:id
 * 完整详情（含 source_code / compile / runtime message）。
 */
router.get('/submissions/:id', (req, res) => {
  const s = submissionRepo.findDetailById(req.params.id);
  if (!s) return res.status(404).json({ error: '提交不存在' });
  res.json({ submission: {
    id: s.id,
    contestId: s.contestId,
    problemId: s.problemId,
    problemTitle: s.problemTitle || '',
    problemLabel: s.problemLabel || '',
    userId: s.userId,
    username: s.username || '',
    nickname: s.nickname || '',
    language: s.language,
    status: s.status,
    verdict: s.verdict || null,
    sourceCode: s.sourceCode,
    serverReceivedAt: s.serverReceivedAt,
    judgeStartedAt: s.judgeStartedAt,
    judgeFinishedAt: s.judgeFinishedAt,
    executionTimeMs: s.executionTimeMs,
    memoryKb: s.memoryKb,
    compileMessage: s.compileMessage,
    runtimeMessage: s.runtimeMessage
  } });
});

/**
 * GET /internal/admin/contests/:id/scoreboard
 * 真实榜单（Admin 看真实，忽略 freeze 投影）。
 */
router.get('/contests/:id/scoreboard', (req, res) => {
  const snap = scoreboard.fullSnapshot(req.params.id, { admin: true });
  if (!snap) return res.status(404).json({ error: '比赛不存在' });
  res.json({ snapshot: snap });
});

/**
 * GET /internal/admin/users
 * 用户基础查询（username 模糊 / 分页）。
 */
router.get('/users', (req, res) => {
  const r = userRepo.listUsers({ username: req.query.username, page: req.query.page, pageSize: req.query.pageSize });
  res.json(r);
});

/** Phase 5 指标（SQLite query 计数 / scoreboard 内存态） */
router.get('/metrics', (_req, res) => {
  res.json({
    metrics: metrics.snapshot(),
    scoreboard: {
      runtimeSize: scoreboard.getRuntimeSize(),
      versionMapSize: scoreboard.getVersionMapSize(),
      dirtySize: scoreboard.getDirtySize()
    }
  });
});

/* ================= 重判 / 抽查（唯一 Scheduler 在此触发） ================= */
router.post('/rejudge/:submissionId', (req, res) => {
  const s = db.submissions.byId(req.params.submissionId);
  if (!s) return res.status(404).json({ error: '提交不存在' });
  const result = scheduler.rejudge(s.id);
  audit.log('rejudge', { submission: s.id, adminVia: 'internal' });
  res.json({ ok: true, status: result });
});

/* ================= Phase 5：关系库 Rejudge（经 judge-service，Official Judge 权威） ================= */
const judgeService = require('../services/judge-service');
const { SUB_STATUS, VERDICT } = require('../services/submission-state');

/**
 * POST /internal/admin/submissions/:id/rejudge
 * 关系库重判：Admin 验证（internalAuth）→ status→QUEUED（清旧终态）→ judgeService.dispatch
 * → Official Judge → FINISHED → recomputeParticipant → dirty → SSE delta。
 * AC→WA / WA→AC 均能正确回滚/增加榜单。
 */
router.post('/submissions/:id/rejudge', (req, res) => {
  const s = submissionRepo.findById(req.params.id);
  if (!s) return res.status(404).json({ error: '提交不存在' });

  // 仅终态可重判
  if (s.status !== SUB_STATUS.FINISHED) {
    return res.status(400).json({ error: '仅 FINISHED 状态的提交可重判（当前 ' + s.status + '）' });
  }

  // 重置为 QUEUED，清空旧终态结果（保留 source / 元数据；可选保留 history）
  const queued = submissionRepo.updateStatus(s.id, {
    status: SUB_STATUS.QUEUED,
    verdict: null,
    judgeStartedAt: null,
    judgeFinishedAt: null,
    executionTimeMs: null,
    memoryKb: null,
    compileMessage: null,
    runtimeMessage: null
  });

  // 重新入队评测（异步，事务外）
  judgeService.dispatch(queued);
  audit.log('rejudge_v2', { submission: s.id, contest: s.contestId, problem: s.problemId, user: s.userId, from: s.verdict });
  res.json({ ok: true, status: SUB_STATUS.QUEUED, submissionId: s.id, from: s.verdict });
});

router.post('/spotcheck/:submissionId', (req, res) => {
  const result = scheduler.spotCheck(req.params.submissionId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  audit.log('spotcheck', { submission: req.params.submissionId, task: result.task.task_id });
  res.json({ ok: true, task: { task_id: result.task.task_id, worker: result.task.worker_id } });
});

/* ================= 语言启停（受控端点，仅 :3002 Admin 经 internalAuth 调用；Runtime Enhancement Phase） =================
 * Body: { id: 'cpp23'|'java21'|..., status: 'ENABLED'|'EXPERIMENTAL'|'DISABLED' }
 * 仅修改内存态 overrideStatus；不持久化（重启恢复代码默认值）。所有语言状态变更必须经过审计。
 * 安全：internalAuth 已挂在 router.use(internalAuth)，无需再校验。
 */
const languageProfiles = require('../language-profiles');

router.get('/languages', (_req, res) => {
  const ids = Object.keys(languageProfiles.PROFILES);
  res.json({
    languages: ids.map((id) => ({
      id,
      displayName: languageProfiles.PROFILES[id].displayName,
      status: languageProfiles.getEffectiveStatus(id),
      defaultStatus: languageProfiles.PROFILES[id].status,
      officialSupported: languageProfiles.PROFILES[id].officialJudge.supported,
      localSupported: languageProfiles.PROFILES[id].localRuntime.supported,
      officialEnabled: languageProfiles.isOfficialEnabled(id)
    }))
  });
});

router.post('/languages/:id/status', (req, res) => {
  const id = req.params.id;
  const status = req.body && req.body.status;
  if (!status) return res.status(400).json({ error: 'MISSING_STATUS', message: '缺少 status 字段' });
  if (!languageProfiles.setStatus(id, status)) {
    return res.status(400).json({ error: 'INVALID_STATUS', message: `无效的 status/language id: id=${id} status=${status}` });
  }
  audit.log('language_status_change', { id, status });
  res.json({ ok: true, id, status, effectiveStatus: languageProfiles.getEffectiveStatus(id) });
});

/* ================= 内部 SSE 事件流（:3002 Admin 桥接） ================= */
router.get('/events', (req, res) => {
  // 校验 query 令牌（admin-v2 生成）
  const token = req.query.token;
  const ts = req.query.ts;
  const secret = config.internalApiSecret;
  if (!secret || !token || !ts) return res.status(401).json({ error: '缺少令牌' });
  const expect = crypto.createHmac('sha256', secret).update(`${ts}:/internal/admin/events`).digest('hex');
  const actualToken = Buffer.from(token);
  const expectedToken = Buffer.from(expect);
  if (actualToken.length !== expectedToken.length || !crypto.timingSafeEqual(actualToken, expectedToken)) {
    return res.status(401).json({ error: '令牌无效' });
  }
  // 复用 admin 通道（:3001 的 hub 已广播 admin 事件）
  hub.join('admin', res);
});

module.exports = router;
