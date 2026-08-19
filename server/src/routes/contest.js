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

// 进入比赛中间件：校验存在 + 已开始
function requireContestOpen(req, res, next) {
  const c = db.contests.byId(req.params.contestId);
  if (!c) return res.status(404).json({ error: '比赛不存在' });
  const enter = contestService.canEnter(c);
  if (!enter.ok) return res.status(403).json({ error: enter.error, status: 'upcoming' });
  req.contest = c;
  next();
}

// 比赛内题目列表
router.get('/contests/:contestId/problems', requireLogin, requireContestOpen, (req, res) => {
  const problems = contestService.problemsOf(req.params.contestId);
  res.json({
    contest: contestService.publicContest(req.contest),
    problems: problems.map(publicProblem)
  });
});

// 比赛内题目详情
router.get('/contests/:contestId/problems/:pid', requireLogin, requireContestOpen, (req, res) => {
  const p = db.problems.byId(req.params.pid);
  if (!p || p.contestId !== req.params.contestId) return res.status(404).json({ error: '题目不存在' });
  res.json({ problem: publicProblem(p) });
});

// 比赛内 ICPC 榜单
router.get('/contests/:contestId/rank', requireLogin, requireContestOpen, (req, res) => {
  const snap = scoreboard.fullSnapshot(req.params.contestId);
  res.json({ snapshot: snap });
});

/* ================= 提交（server_received_at 权威 + clientRequestId 幂等 + contestId） ================= */
const idempotencyCache = new Map();
function idempotencyKey(userId, clientRequestId) { return `${userId}:${clientRequestId}`; }

router.post('/contests/:contestId/submissions', requireLogin, requireContestOpen, (req, res) => {
  const { problemId, language, code, localVerification, clientRequestId } = req.body || {};
  if (!config.languages.includes(language)) return res.status(400).json({ error: `不支持的语言：${config.languages.join('/')}` });
  if (!code || code.length > config.maxCodeLength) return res.status(400).json({ error: '代码为空或超限' });
  const problem = db.problems.byId(problemId);
  if (!problem || problem.contestId !== req.params.contestId) return res.status(404).json({ error: '题目不存在' });
  const user = db.users.byId(req.user.id);
  if (!user || user.banned) return res.status(403).json({ error: '账号不可用' });

  if (clientRequestId) {
    const key = idempotencyKey(user.id, clientRequestId);
    const existing = idempotencyCache.get(key);
    if (existing) {
      const s = db.submissions.byId(existing);
      if (s) return res.json({ submission: { id: s.id, status: s.status }, deduplicated: true });
    }
  }

  const serverReceivedAt = new Date().toISOString();
  const submission = db.submissions.insert({
    userId: user.id, username: user.username, contestId: req.params.contestId,
    problemId: problem.id, problemTitle: problem.title,
    language, code, status: 'SUBMITTED', cases: [], timeMs: 0, memoryKb: 0,
    localVerification: localVerification || null,
    clientRequestId: clientRequestId || null,
    serverReceivedAt
  });
  if (clientRequestId) idempotencyCache.set(idempotencyKey(user.id, clientRequestId), submission.id);

  audit.log('submit', { user: user.id, contest: req.params.contestId, problem: problem.id, language, localVerified: !!localVerification, serverReceivedAt });
  hub.broadcastPage('submission_update', { id: submission.id, status: 'SUBMITTED', username: user.username, contestId: req.params.contestId, problemId: problem.id, problemTitle: problem.title, language });

  scheduler.submit(submission, { localVerification, clientRequestId, serverReceivedAt });
  res.json({ submission: { id: submission.id, status: submission.status } });
});

// 比赛内我的提交（可选 status/username/problemId 过滤）
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

// 提交详情
router.get('/submissions/:id', requireLogin, (req, res) => {
  const s = db.submissions.byId(req.params.id);
  if (!s) return res.status(404).json({ error: '提交不存在' });
  if (req.user.role !== 'admin' && s.userId !== req.user.id) return res.status(403).json({ error: '无权查看他人提交' });
  res.json({ submission: s });
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

/* ================= SSE 实时流 ================= */
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
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: db.submissions.find((x) => x.status === 'PENDING' || x.status === 'LEASED').length })}\n\n`);
  res.on('close', () => sseConnections.set(uid, (sseConnections.get(uid) || 1) - 1));
});

router.get('/events/stream', requireLogin, (req, res) => {
  hub.join('page', res);
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: db.submissions.find((x) => x.status === 'PENDING' || x.status === 'LEASED').length })}\n\n`);
});

module.exports = router;
