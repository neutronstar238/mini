'use strict';
/**
 * 选手端（contest）API —— 运行于 :3001 OJ Core
 * - 认证/题目/提交/榜单
 * - 提交权威时间 server_received_at；clientRequestId 幂等
 * - sync/bootstrap：cache lease(nextSyncAt) + scoreboard snapshot + submission cursor
 * - server rate limit（同一 user 同步间隔 >= 10s，超限 429 + Retry-After）
 * - SSE batch + delta 推送
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');
const db = require('../store/db');
const hub = require('../sse/hub');
const scheduler = require('../services/scheduler');
const scoreboard = require('../services/scoreboard');
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

/* ================= 题目（仅公开样例，隐藏测试点不出） ================= */
function publicProblem(p) {
  const { testcases, ...rest } = p;
  const subs = db.submissions.find((s) => s.problemId === p.id);
  const ac = subs.filter((s) => s.status === 'AC').length;
  return {
    ...rest, testcaseCount: testcases ? testcases.length : 0,
    samples: p.samples || [], submitCount: subs.length, acCount: ac,
    acRate: subs.length ? Math.round((ac / subs.length) * 100) : 0
  };
}

router.get('/problems', (req, res) => {
  const { q, difficulty } = req.query;
  let list = db.problems.all();
  if (q) list = list.filter((p) => (p.title || '').includes(q));
  if (difficulty && difficulty !== 'all') list = list.filter((p) => p.difficulty === difficulty);
  list.sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json({ problems: list.map(publicProblem) });
});

router.get('/problems/:id', requireLogin, (req, res) => {
  const p = db.problems.byId(req.params.id);
  if (!p) return res.status(404).json({ error: '题目不存在' });
  res.json({ problem: publicProblem(p) });
});

/* ================= 提交（server_received_at 权威 + clientRequestId 幂等） ================= */
// 幂等缓存：clientRequestId → submissionId（防网络重试重复提交）
const idempotencyCache = new Map();
function idempotencyKey(userId, clientRequestId) {
  return `${userId}:${clientRequestId}`;
}

router.post('/submissions', requireLogin, (req, res) => {
  const { problemId, language, code, localVerification, clientRequestId } = req.body || {};
  if (!config.languages.includes(language)) return res.status(400).json({ error: `不支持的语言：${config.languages.join('/')}` });
  if (!code || code.length > config.maxCodeLength) return res.status(400).json({ error: '代码为空或超限' });
  const problem = db.problems.byId(problemId);
  if (!problem) return res.status(404).json({ error: '题目不存在' });
  const user = db.users.byId(req.user.id);
  if (!user || user.banned) return res.status(403).json({ error: '账号不可用' });

  // 幂等：同一 user+clientRequestId 只创建一次
  if (clientRequestId) {
    const key = idempotencyKey(user.id, clientRequestId);
    const existing = idempotencyCache.get(key);
    if (existing) {
      const s = db.submissions.byId(existing);
      if (s) return res.json({ submission: { id: s.id, status: s.status }, deduplicated: true });
    }
  }

  // server_received_at 为唯一权威提交时间
  const serverReceivedAt = new Date().toISOString();
  const submission = db.submissions.insert({
    userId: user.id, username: user.username, problemId: problem.id, problemTitle: problem.title,
    language, code, status: 'SUBMITTED', cases: [], timeMs: 0, memoryKb: 0,
    localVerification: localVerification || null,
    clientRequestId: clientRequestId || null,
    serverReceivedAt
  });
  if (clientRequestId) idempotencyCache.set(idempotencyKey(user.id, clientRequestId), submission.id);

  audit.log('submit', { user: user.id, problem: problem.id, language, localVerified: !!localVerification, serverReceivedAt });
  hub.broadcastPage('submission_update', { id: submission.id, status: 'SUBMITTED', username: user.username, problemId: problem.id, problemTitle: problem.title, language });
  scheduler.submit(submission, { localVerification, clientRequestId, serverReceivedAt });
  res.json({ submission: { id: submission.id, status: submission.status } });
});

router.get('/submissions', requireLogin, (req, res) => {
  const { status, username, problemId, page = 1, pageSize = 20 } = req.query;
  let list = db.submissions.all();
  if (req.user.role !== 'admin') list = list.filter((s) => s.userId === req.user.id);
  if (status && status !== 'all') list = list.filter((s) => s.status === status);
  if (req.query.username) list = list.filter((s) => s.username.includes(req.query.username));
  if (problemId) list = list.filter((s) => s.problemId === problemId);
  list.sort((a, b) => new Date(b.serverReceivedAt || b.createdAt) - new Date(a.serverReceivedAt || a.createdAt));
  const p = Math.max(1, Number(page)); const size = Math.min(100, Number(pageSize) || 20);
  res.json({ total: list.length, page: p, submissions: list.slice((p - 1) * size, p * size) });
});

router.get('/submissions/:id', requireLogin, (req, res) => {
  const s = db.submissions.byId(req.params.id);
  if (!s) return res.status(404).json({ error: '提交不存在' });
  if (req.user.role !== 'admin' && s.userId !== req.user.id) return res.status(403).json({ error: '无权查看他人提交' });
  res.json({ submission: s });
});

/* ================= 首次同步 bootstrap（cache lease + 快照） ================= */
// 选手同步限流：userId -> lastSyncAt（server rate limit）
const syncLimiter = new Map();

router.get('/sync/bootstrap', requireLogin, (req, res) => {
  const snapshot = scoreboard.fullSnapshot();
  const mine = db.submissions.all()
    .filter((s) => s.userId === req.user.id)
    .sort((a, b) => new Date(b.serverReceivedAt || b.createdAt) - new Date(a.serverReceivedAt || a.createdAt))
    .slice(0, 50);
  const submissionCursor = mine.length ? mine[0].serverReceivedAt || mine[0].createdAt : null;
  res.json({
    serverTime: Date.now(),
    scoreboardSnapshot: snapshot,
    scoreboardVersion: snapshot.version,
    mySubmissions: mine.map((s) => ({ id: s.id, problemId: s.problemId, problemTitle: s.problemTitle, language: s.language, status: s.status, timeMs: s.timeMs, memoryKb: s.memoryKb, createdAt: s.createdAt })),
    submissionCursor,
    // Cache Lease：nextSyncAt 前禁止重新请求（仅客户端性能机制）
    nextSyncAt: Date.now() + config.CONTESTANT_BATCH_INTERVAL,
    cacheLeaseMs: config.CONTESTANT_BATCH_INTERVAL
  });
});

// 增量同步（SSE 断线 fallback polling 用）：从 version/cursor 之后取 delta
router.get('/sync', requireLogin, (req, res) => {
  // server rate limit：同一 user 最小请求间隔 10s
  const now = Date.now();
  const last = syncLimiter.get(req.user.id) || 0;
  if (now - last < config.SYNC_MIN_INTERVAL) {
    return res.status(429).json({ error: 'Too Many Requests', retryAfter: Math.ceil((config.SYNC_MIN_INTERVAL - (now - last)) / 1000) });
  }
  syncLimiter.set(req.user.id, now);

  const sinceVersion = Number(req.query.scoreboardVersion || 0);
  const cursor = req.query.submissionCursor || null;
  const sb = scoreboard.fullSnapshot();
  // 版本差距过大 → 客户端应重取 full snapshot（changed=true + full）
  const versionGap = sb.version - sinceVersion;
  if (versionGap > 100) {
    return res.json({ changed: true, full: true, scoreboardSnapshot: sb, serverTime: Date.now(), nextSyncAt: now + config.CONTESTANT_BATCH_INTERVAL });
  }
  // submission delta：返回 cursor 之后本人提交的变化（简化：返回最新若干条）
  const mine = db.submissions.all()
    .filter((s) => s.userId === req.user.id)
    .sort((a, b) => new Date(b.serverReceivedAt || b.createdAt) - new Date(a.serverReceivedAt || a.createdAt))
    .slice(0, 20);
  res.json({
    changed: true,
    scoreboardVersion: sb.version,
    submissionDelta: mine.map((s) => ({ submissionId: s.id, status: s.status, timeMs: s.timeMs, memoryKb: s.memoryKb })),
    serverTime: now,
    nextSyncAt: now + config.CONTESTANT_BATCH_INTERVAL
  });
});

/* ================= SSE 实时流（batch + delta） ================= */
// 每位选手的 SSE 连接数上限（P1 简化）
const sseConnections = new Map();
// SSE 鉴权：支持 HttpOnly Cookie（浏览器）或 ?token=（压测/非浏览器客户端）
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
  res.write(`event: scoreboard_delta\ndata: ${JSON.stringify(scoreboard.fullSnapshot())}\n\n`);
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: db.submissions.find((x) => x.status === 'PENDING' || x.status === 'LEASED').length })}\n\n`);
  res.on('close', () => sseConnections.set(uid, (sseConnections.get(uid) || 1) - 1));
});

// 旧路径兼容（保留 /events/stream）
router.get('/events/stream', requireLogin, (req, res) => {
  hub.join('page', res);
  res.write(`event: queue_status\ndata: ${JSON.stringify({ pending: db.submissions.find((x) => x.status === 'PENDING' || x.status === 'LEASED').length })}\n\n`);
});

module.exports = router;
