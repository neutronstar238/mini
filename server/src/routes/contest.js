'use strict';
/**
 * 选手端（contest）API —— 运行于 :3001 OJ Core（比赛制）
 * - 认证
 * - 比赛列表 / 进入校验（未开始返回"比赛还未开始"）
 * - 比赛内题目 / ICPC 榜单 / 提交（提交带 contestId）
 * - server_received_at 权威；clientRequestId 幂等
 * - SSE batch + delta
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../store/db');
const hub = require('../sse/hub');
const scheduler = require('../services/scheduler');
const scoreboard = require('../services/scoreboard');
const contestService = require('../services/contestService');
const audit = require('../services/audit');
const { requireLogin } = require('../middleware/auth');
const submissionService = require('../services/submission-service');
const submissionRepo = require('../store/repositories/submission-repository');
const problemRepo = require('../store/repositories/problem-repository');
const contestRepo = require('../store/repositories/contest-repository');
const { VERDICT } = require('../services/submission-state');
const SlidingWindowRateLimiter = require('../services/rate-limiter');
const metrics = require('../store/db-metrics');
const clientDevices = require('../services/client-device-service');

// Scoreboard Full Snapshot 限流（user 主 + IP 辅助）
const scoreboardFullLimiter = new SlidingWindowRateLimiter({
  limit: config.SCOREBOARD_FULL_LIMIT,
  windowMs: config.SCOREBOARD_FULL_WINDOW_MS
});

const router = express.Router();

/* ================= 认证 ================= */
function publicUser(u) { return { id: u.id, username: u.username, nickname: u.nickname, role: u.role }; }
function issueToken(u) { return jwt.sign({ id: u.id, username: u.username, role: u.role }, config.jwtSecret, { expiresIn: config.jwtExpires }); }

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users.findOne((x) => x.username === username);
  if (!u || !bcrypt.compareSync(password || '', u.passwordHash)) return res.status(401).json({ error: '用户名或密码错误' });
  if (u.banned) return res.status(403).json({ error: '账号已被封禁' });
  // 选手端独立入口：仅普通选手可登录，管理员请到管理端（两个入口共用 DB、登录逻辑独立）
  if (u.role === 'admin') return res.status(403).json({ error: '管理员账号请到管理端登录' });
  const token = issueToken(u);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  audit.log('login', { user: u.id, username: u.username });
  res.json({ token, user: publicUser(u) });
});

router.post('/auth/register', (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username || '')) return res.status(400).json({ error: '用户名需为 3-20 位字母数字下划线' });
  if ((password || '').length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (db.users.findOne((x) => x.username === username)) return res.status(409).json({ error: '用户名已存在' });
  const u = db.users.insert({ username, nickname: nickname || username, passwordHash: bcrypt.hashSync(password, 10), role: 'user', banned: false });
  const token = issueToken(u);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ token, user: publicUser(u) });
});

router.post('/auth/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });
router.get('/auth/me', requireLogin, (req, res) => {
  const u = db.users.byId(req.user.id);
  if (!u) return res.status(401).json({ error: '用户不存在' });
  res.json({ user: publicUser(u) });
});

/* ================= 选手 Chrome 客户端设备心跳 ================= */
router.post('/devices/heartbeat', requireLogin, (req, res, next) => {
  try {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || '');
    const device = clientDevices.heartbeat(req.user, req.body || {}, { ip });
    res.json({ ok: true, device, nextHeartbeatMs: config.CLIENT_DEVICE_HEARTBEAT_INTERVAL });
  } catch (err) { next(err); }
});

/* ================= 比赛 ================= */
// 比赛列表（含状态：upcoming / ongoing / ended）
router.get('/contests', (req, res) => {
  const list = db.contests.all()
    .map((c) => contestService.publicContest(c))
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  res.json({ contests: list });
});

// 比赛详情 + 进入校验
router.get('/contests/:id', requireLogin, (req, res) => {
  const c = db.contests.byId(req.params.id);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  const enter = contestService.canEnter(c);
  if (!enter.ok) return res.status(403).json({ error: enter.error, status: 'upcoming' });
  res.json({ contest: contestService.publicContest(c, true) });
});

/* ================= 题目（仅公开样例，隐藏测试点不出） ================= */
function publicProblem(p) {
  const { testcases, genCode, solutionCode, ...rest } = p;
  const subs = db.submissions.find((s) => s.problemId === p.id);
  const ac = subs.filter((s) => s.status === 'AC').length;
  return {
    ...rest, testcaseCount: testcases ? testcases.length : 0,
    samples: p.samples || [], submitCount: subs.length, acCount: ac,
    acRate: subs.length ? Math.round((ac / subs.length) * 100) : 0
  };
}

// 进入比赛中间件：校验存在 + 已开始（Phase 4 主链路优先走关系库，回退文档模式）
function requireContestOpen(req, res, next) {
  const relC = contestRepo.findById(req.params.contestId);
  const c = relC || db.contests.byId(req.params.contestId);
  if (!c) return res.status(404).json({ error: { code: 'CONTEST_NOT_FOUND', message: '比赛不存在' } });
  const startAt = relC ? (c.start_at ? new Date(c.start_at).getTime() : 0) : (c.startTimeMs || 0);
  if (Date.now() < startAt) return res.status(403).json({ error: { code: 'CONTEST_NOT_STARTED', message: '比赛还未开始' } });
  req.contest = c;
  req.relContest = relC;
  next();
}

/** 关系库题目列表的公开形态（problems 页） */
function relPublicProblemList(problem) {
  const solvedCount = 0; // 下一阶段计算 acCount
  return {
    id: problem.id,
    label: problem.label,
    title: problem.title,
    order: problem.label ? problem.label.charCodeAt(0) - 64 : 0,
    acCount: solvedCount,
    submitCount: 0
  };
}

// 比赛内题目列表（Phase 4 关系库优先）
router.get('/contests/:contestId/problems', requireLogin, requireContestOpen, (req, res) => {
  if (req.relContest) {
    const problems = problemRepo.listByContest(req.params.contestId);
    return res.json({
      contest: { id: req.relContest.id, title: req.relContest.title, status: req.relContest.status },
      problems: problems.map(relPublicProblemList)
    });
  }
  const problems = contestService.problemsOf(req.params.contestId);
  res.json({ contest: contestService.publicContest(req.contest), problems: problems.map(publicProblem) });
});

// 比赛内题目详情（Phase 4 关系库优先；仅公开样例，隐藏测试不出）
router.get('/contests/:contestId/problems/:pid', requireLogin, requireContestOpen, (req, res) => {
  if (req.relContest) {
    const p = problemRepo.findById(req.params.pid);
    if (!p || p.contest_id !== req.params.contestId) return res.status(404).json({ error: { code: 'PROBLEM_NOT_FOUND', message: '题目不存在' } });
    return res.json({ problem: problemRepo.publicProblem(p) });
  }
  const p = db.problems.byId(req.params.pid);
  if (!p || p.contestId !== req.params.contestId) return res.status(404).json({ error: '题目不存在' });
  res.json({ problem: publicProblem(p) });
});

// 比赛内 ICPC 榜单（旧端点：兼容，返回新快照形态）
router.get('/contests/:contestId/rank', requireLogin, requireContestOpen, (req, res) => {
  const snap = scoreboard.fullSnapshot(req.params.contestId, { admin: req.user.role === 'admin' });
  if (!snap) return res.status(404).json({ error: { code: 'CONTEST_NOT_FOUND', message: '比赛不存在' } });
  res.json({ snapshot: snap });
});

/**
 * Scoreboard Full Snapshot（Phase 5 主端点）。
 * - 返回 version/serverTime/nextSyncAt/participants，只含榜单数据（不含 source/compile/hidden test/judge data）。
 * - Rate Limit：同 (user, ip) 高频 → 429 + Retry-After。
 * - Admin 看真实（freeze 投影关闭），普通选手看公开投影。
 */
router.get('/contests/:contestId/scoreboard', requireLogin, requireContestOpen, (req, res) => {
  const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.socket.remoteAddress || '');
  const rl = scoreboardFullLimiter.check(String(req.user.id), ip);
  if (!rl.allowed) {
    const retryAfter = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
    return res.status(429).set('Retry-After', String(retryAfter)).json({
      error: { code: 'RATE_LIMITED', message: 'Scoreboard 请求过于频繁，请稍后再试' },
      retryAfter
    });
  }
  const snap = scoreboard.fullSnapshot(req.params.contestId, { admin: req.user.role === 'admin' });
  if (!snap) return res.status(404).json({ error: { code: 'CONTEST_NOT_FOUND', message: '比赛不存在' } });
  metrics.inc(metrics.K.SCOREBOARD, 0); // full snapshot 由 scoreboard 内部计数，这里仅标记调用
  res.json({ snapshot: snap });
});

/** 轻量 version 探询（供客户端在 Cache Lease 失效前判断是否需 full sync，几乎零成本） */
router.get('/contests/:contestId/scoreboard/version', requireLogin, requireContestOpen, (req, res) => {
  const isFrozen = scoreboard.isFrozen(req.params.contestId) && req.user.role !== 'admin';
  res.json({
    version: scoreboard.getVersion(req.params.contestId),
    serverTime: new Date().toISOString(),
    frozen: isFrozen
  });
});

/* ================= 正式提交（Phase 4 主链路：server_received_at 权威 + clientRequestId 幂等 + JudgeAdapter） =================
 * 浏览器完全不信任 Local PASS / Local executionTime / Browser verdict。
 * 服务器只接受 source + language + problem/contest id + clientRequestId。
 */
router.post('/contests/:contestId/submissions', requireLogin, requireContestOpen, (req, res, next) => {
  try {
    const { problemId, language, code, source, clientRequestId, clientSubmittedAt } = req.body || {};
    const result = submissionService.submit({
      contestId: req.params.contestId,
      problemId,
      language,
      source: source !== undefined ? source : code, // 兼容旧字段 code
      clientRequestId,
      clientSubmittedAt
    }, req.user.id);

    audit.log('submit', {
      user: req.user.id, contest: req.params.contestId, problem: problemId,
      language, serverReceivedAt: result.submission.serverReceivedAt, duplicate: result.duplicate
    });

    if (result.duplicate) {
      return res.json({
        submission: { id: result.submission.id, status: result.submission.status, verdict: result.submission.verdict || null },
        deduplicated: true
      });
    }
    return res.json({
      submission: { id: result.submission.id, status: result.submission.status },
      serverReceivedAt: result.submission.serverReceivedAt
    });
  } catch (err) {
    return next(err); // 统一 error handler 映射 ApiError
  }
});

// 比赛内我的提交（Phase 4 关系库）
router.get('/contests/:contestId/submissions/me', requireLogin, requireContestOpen, (req, res) => {
  const list = submissionRepo.listByUserAndContest(req.user.id, req.params.contestId, { limit: 50 });
  res.json({
    submissions: list.map((s) => ({
      submissionId: s.id,
      problemId: s.problemId,
      problemTitle: s.problemTitle,
      language: s.language,
      status: s.status,
      verdict: s.verdict || null,
      serverReceivedAt: s.serverReceivedAt,
      executionTime: s.executionTimeMs,
      memory: s.memoryKb
    }))
  });
});

// 比赛内我的提交（可选 status/username/problemId 过滤）——兼容旧前端（文档模式优先，无关系数据时回退）
router.get('/contests/:contestId/submissions', requireLogin, requireContestOpen, (req, res) => {
  const { status, page = 1, pageSize = 20 } = req.query;
  let list = db.submissions.find((s) => s.contestId === req.params.contestId);
  if (req.user.role !== 'admin') list = list.filter((s) => s.userId === req.user.id);
  if (status && status !== 'all') list = list.filter((s) => s.status === status);
  if (req.query.username) list = list.filter((s) => s.username.includes(req.query.username));
  if (req.query.problemId) list = list.filter((s) => s.problemId === req.query.problemId);
  list.sort((a, b) => new Date(b.serverReceivedAt || b.createdAt) - new Date(a.serverReceivedAt || a.createdAt));
  const p = Math.max(1, Number(page)); const size = Math.min(100, Number(pageSize) || 20);
  res.json({ total: list.length, page: p, submissions: list.slice((p - 1) * size, p * size) });
});

// 提交详情（Phase 4 关系库优先；仅本人/Admin 可查看完整 source）
router.get('/submissions/:id', requireLogin, (req, res, next) => {
  try {
    const s = submissionRepo.findById(req.params.id);
    if (!s) return res.status(404).json({ error: { code: 'SUBMISSION_NOT_FOUND', message: '提交不存在' } });
    if (req.user.role !== 'admin' && s.userId !== req.user.id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权查看他人提交' } });
    }
    const p = problemRepo.findById(s.problemId);
    res.json({ submission: {
      id: s.id,
      contestId: s.contestId,
      problemId: s.problemId,
      problemTitle: p ? p.title : '',
      language: s.language,
      status: s.status,
      verdict: s.verdict || null,
      sourceCode: s.sourceCode,
      serverReceivedAt: s.serverReceivedAt,
      executionTime: s.executionTimeMs,
      memory: s.memoryKb,
      compileMessage: s.compileMessage,
      runtimeMessage: s.runtimeMessage
    } });
  } catch (err) { next(err); }
});

// 单条提交的 SSE 事件流（个人提交结果推送）
router.get('/submissions/:id/events', requireLogin, (req, res) => {
  const s = submissionRepo.findById(req.params.id);
  if (!s) return res.status(404).json({ error: { code: 'SUBMISSION_NOT_FOUND', message: '提交不存在' } });
  if (req.user.role !== 'admin' && s.userId !== req.user.id) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权查看他人提交' } });
  }
  // 立即推送当前状态，之后由 hub 广播 submission_update
  hub.join('page', res);
  res.write(`event: submission_update\ndata: ${JSON.stringify({ id: s.id, status: s.status, verdict: s.verdict || null })} \n\n`);
});

/* ================= 诊断：SQLite Query 计数（Phase 5 负载观测用） ================= */
router.get('/_metrics', requireLogin, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: { code: 'FORBIDDEN', message: '无权查看指标' } });
  res.json({
    metrics: metrics.snapshot(),
    scoreboard: {
      runtimeSize: scoreboard.getRuntimeSize(),
      versionMapSize: scoreboard.getVersionMapSize(),
      dirtySize: scoreboard.getDirtySize()
    }
  });
});

/* ================= 首次同步 bootstrap ================= */
const syncLimiter = new Map();

router.get('/contests/:contestId/bootstrap', requireLogin, requireContestOpen, (req, res) => {
  const snapshot = scoreboard.fullSnapshot(req.params.contestId);
  const mine = db.submissions.all()
    .filter((s) => s.userId === req.user.id && s.contestId === req.params.contestId)
    .sort((a, b) => new Date(b.serverReceivedAt || b.createdAt) - new Date(a.serverReceivedAt || a.createdAt))
    .slice(0, 50);
  res.json({
    serverTime: Date.now(),
    scoreboardSnapshot: snapshot,
    scoreboardVersion: snapshot.version,
    mySubmissions: mine.map((s) => ({ id: s.id, problemId: s.problemId, problemTitle: s.problemTitle, language: s.language, status: s.status, timeMs: s.timeMs, memoryKb: s.memoryKb, createdAt: s.createdAt })),
    nextSyncAt: Date.now() + config.CONTESTANT_BATCH_INTERVAL,
    cacheLeaseMs: config.CONTESTANT_BATCH_INTERVAL
  });
});

// 增量同步（SSE 断线 fallback polling）
router.get('/contests/:contestId/sync', requireLogin, requireContestOpen, (req, res) => {
  const now = Date.now();
  const last = syncLimiter.get(req.user.id) || 0;
  if (now - last < config.SYNC_MIN_INTERVAL) {
    return res.status(429).json({ error: 'Too Many Requests', retryAfter: Math.ceil((config.SYNC_MIN_INTERVAL - (now - last)) / 1000) });
  }
  syncLimiter.set(req.user.id, now);
  const sb = scoreboard.fullSnapshot(req.params.contestId);
  res.json({
    changed: true, scoreboardVersion: sb.version, scoreboardSnapshot: sb,
    serverTime: now, nextSyncAt: now + config.CONTESTANT_BATCH_INTERVAL
  });
});

/* ================= 比赛内 Scoreboard SSE（Phase 5：每比赛 channel + version 协商） ================= */
// contestId -> Map<userId, count>（每比赛每用户 SSE 连接数限制）
const contestSseConnections = new Map();

/**
 * GET /contests/:contestId/events
 * 每比赛 Scoreboard 事件流：
 *  - 事件 scoreboard-delta：{ version, changes:[{userId,solved,penalty,problems}] }
 *  - 事件 scoreboard_sync：{ type:'NEED_FULL_SYNC', clientVersion, serverVersion }（断线后版本过旧）
 *  - 事件 queue_status：队列深度（兼容）
 * 连接参数：?token=JWT（SSE 无法带 header，兼容 query token）；?lastVersion=N 供断线协商。
 * 响应头：text/event-stream + no-cache + keep-alive + X-Accel-Buffering:no（关闭反向代理 buffering）。
 */
router.get('/contests/:contestId/events', (req, res) => {
  if (!req.user && req.query.token) {
    try { req.user = jwt.verify(req.query.token, config.jwtSecret); } catch (_) { /* 无效 */ }
  }
  if (!req.user) return res.status(401).json({ error: '未登录' });
  const uid = req.user.id;
  const cid = req.params.contestId;
  // 每比赛每用户连接数限制（SSE 放宽，但防单用户刷连接）
  const byContest = contestSseConnections.get(cid) || new Map();
  const n = byContest.get(uid) || 0;
  if (n >= config.MAX_SSE_PER_USER) return res.status(429).json({ error: 'SSE 连接数过多' });
  byContest.set(uid, n + 1);
  contestSseConnections.set(cid, byContest);

  hub.join(`contest:${cid}`, res);
  const serverVersion = scoreboard.getVersion(cid);
  // 断线协商：客户端上报 lastVersion。
  // P0 不保留 delta 历史 → 任何版本不一致（落后或超前，无法保证连续 delta）一律 NEED_FULL_SYNC。
  const clientVersion = req.query.lastVersion !== undefined ? Number(req.query.lastVersion) : NaN;
  if (!Number.isNaN(clientVersion) && clientVersion > 0 && clientVersion !== serverVersion) {
    res.write(`event: scoreboard_sync\ndata: ${JSON.stringify({ type: 'NEED_FULL_SYNC', clientVersion, serverVersion })}\n\n`);
  } else {
    // 首次连接（无 lastVersion）/ 版本已最新：发当前版本快照元信息
    const now = Date.now();
    res.write(`event: scoreboard_snapshot\ndata: ${JSON.stringify({
      version: serverVersion,
      serverTime: new Date(now).toISOString(),
      nextSyncAt: new Date(now + config.CONTESTANT_BATCH_INTERVAL * 2).toISOString()
    })}\n\n`);
  }
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: submissionRepo.countInFlight(cid) })}\n\n`);

  res.on('close', () => {
    const m = contestSseConnections.get(cid);
    if (m) {
      m.set(uid, (m.get(uid) || 1) - 1);
      if (m.get(uid) <= 0) m.delete(uid);
      if (m.size === 0) contestSseConnections.delete(cid);
    }
  });
});

/* ================= SSE 实时流（旧：全局 page 通道，兼容个人 submission + queue） ================= */
const sseConnections = new Map();
router.get('/events', (req, res) => {
  if (!req.user && req.query.token) {
    try { req.user = jwt.verify(req.query.token, config.jwtSecret); } catch (_) { /* 无效 */ }
  }
  if (!req.user) return res.status(401).json({ error: '未登录' });
  const uid = req.user.id;
  const n = sseConnections.get(uid) || 0;
  if (n >= config.MAX_SSE_PER_USER) return res.status(429).json({ error: 'SSE 连接数过多' });
  sseConnections.set(uid, n + 1);
  hub.join('page', res);
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: submissionRepo.countInFlight() })}\n\n`);
  res.on('close', () => sseConnections.set(uid, (sseConnections.get(uid) || 1) - 1));
});

router.get('/events/stream', requireLogin, (req, res) => {
  hub.join('page', res);
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: submissionRepo.countInFlight() })}\n\n`);
});

// 统一 API 错误处理（Phase 4 主链路错误码格式）
router.use(require('../middleware/api-error').apiErrorHandler);

module.exports = router;
