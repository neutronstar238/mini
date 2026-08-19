'use strict';
/**
 * Mini-OJ 服务端入口 —— 三域架构：中心控制域
 * 双 Web 入口（两个域名）：
 *   - 选手端  contest.example.com  → /contest/**（页面与 /api/contest/**）
 *   - 管理端  admin.example.com    → /admin/**（页面与 /api/admin/**）
 * 评测协议  /api/worker/**（仅可信 Worker 用证书身份访问）
 * 本地联调：prefixFallback=true 时可直接用 /contest 与 /admin 前缀访问
 */
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./store/db');
const hub = require('./sse/hub');
const { authOptional } = require('./middleware/auth');
const seedIfEmpty = require('./seed');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(authOptional);

// 入口识别中间件：根据 Host 或前缀判定 contest/admin
function entry(req, res, next) {
  const host = (req.hostname || '').toLowerCase();
  let e = null;
  if (host === config.domainAdmin || host.endsWith('.' + config.domainAdmin)) e = 'admin';
  else if (host === config.domainContest || host.endsWith('.' + config.domainContest)) e = 'contest';
  req.entry = e; // 未识别时保持 null（由路由自行判定）
  next();
}
app.use(entry);

// ---------- 评测协议（Worker）----------（仅 contest 入口暴露，供 Worker 连接）
if (config.entry === 'all' || config.entry === 'contest') {
  app.use('/api/worker', require('./routes/worker'));
}

// ---------- 选手端 API ----------
if (config.entry === 'all' || config.entry === 'contest') {
  app.use('/api/contest', require('./routes/contest'));
}

// ---------- 管理端 API（:3002 Admin 服务代理到 :3001 internal API） ----------
if (config.entry === 'all' || config.entry === 'admin') {
  app.use('/api/admin', require('./routes/admin-v2'));
}

// ---------- :3001 内部管理 API（仅 OJ Core 暴露，供 :3002 代理） ----------
if (config.entry === 'all' || config.entry === 'contest') {
  app.use('/internal/admin', require('./routes/internal-admin'));
}

// ---------- 页面路由（按入口独立挂载，实现两个独立项目） ----------
if (config.entry === 'all' || config.entry === 'contest') {
  app.get('/login', (req, res) => res.render('contest/login', { user: req.user || null }));
  app.get('/contest/login', (req, res) => res.render('contest/login', { user: req.user || null }));
  app.get('/contest', (req, res) => res.redirect(req.user ? '/contest/problems' : '/contest/login'));
  app.get('/problems', (req, res) => res.render('contest/problems', { user: req.user || null }));
  app.get('/problems/:id', (req, res) => res.render('contest/problem-detail', { user: req.user || null }));
  app.get('/contest/problems', (req, res) => res.render('contest/problems', { user: req.user || null }));
  app.get('/contest/problems/:id', (req, res) => res.render('contest/problem-detail', { user: req.user || null }));
  app.get('/submissions', (req, res) => res.render('contest/submissions', { user: req.user || null }));
  app.get('/contest/submissions', (req, res) => res.render('contest/submissions', { user: req.user || null }));
  app.get('/rank', (req, res) => res.render('contest/rank', { user: req.user || null }));
  app.get('/contest/rank', (req, res) => res.render('contest/rank', { user: req.user || null }));
}

if (config.entry === 'all' || config.entry === 'admin') {
  app.get('/login', (req, res) => res.render('admin/login', { user: req.user || null }));
  app.get('/admin/login', (req, res) => res.render('admin/login', { user: req.user || null }));
  app.get('/admin', (req, res) => res.redirect('/admin/overview'));
  app.get('/admin/overview', (req, res) => res.render('admin/overview', { user: req.user || null }));
  app.get('/admin/nodes', (req, res) => res.render('admin/nodes', { user: req.user || null }));
  app.get('/admin/certs', (req, res) => res.render('admin/certs', { user: req.user || null }));
  app.get('/admin/queue', (req, res) => res.render('admin/queue', { user: req.user || null }));
  app.get('/admin/audit', (req, res) => res.render('admin/audit', { user: req.user || null }));
  app.get('/admin/problems', (req, res) => res.render('admin/problems', { user: req.user || null }));
  app.get('/admin/rejudge', (req, res) => res.render('admin/rejudge', { user: req.user || null }));
}

// 根路径：按入口跳转
app.get('/', (req, res) => {
  if (config.entry === 'admin') return res.redirect('/admin/overview');
  return res.redirect(req.user ? '/problems' : '/login');
});

// ---------- 统一错误处理 ----------
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.expose ? err.message : '服务器内部错误' });
});

// ---------- 启动 ----------
seedIfEmpty(db);
app.listen(config.port, config.host, () => {
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│  Mini-OJ 中心控制域  ·  本地预检+可信边缘评测        │');
  console.log(`│  选手端 http://localhost:${config.port}/contest              │`);
  console.log(`│  管理端 http://localhost:${config.port}/admin               │`);
  console.log(`│  Worker  http://localhost:${config.port}/api/worker          │`);
  console.log('│  演示账号: admin/admin123  user1/user123              │');
  console.log('│  Worker 注册码: OJ-DEMO-WORKER-2024                    │');
  console.log('└──────────────────────────────────────────────────────┘');
});
