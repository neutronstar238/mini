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
// 浏览器本地运行时（Runno/WASI）依赖 SharedArrayBuffer，需 cross-origin isolation。
// 仅对 contest（选手端）页面设置 COOP/COEP，管理端无需。
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  const isContest = host === config.domainContest || host.endsWith('.' + config.domainContest)
    || req.path.startsWith('/contest') || req.path.startsWith('/js/contest');
  if (isContest) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  // HTML 页面响应不缓存，避免开发期更新后浏览器仍显示旧页面
  if (req.accepts('html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: function (res, filePath) {
    // .wasm 必须返回 application/wasm，否则 WebAssembly.compileStreaming/instantiateStreaming 退化为 ArrayBuffer 路径
    if (filePath.endsWith('.wasm')) {
      res.setHeader('Content-Type', 'application/wasm');
    }
    // Runno 自托管运行时大文件（clang.wasm ~31MB、wasm-ld.wasm、python wasm、tar.gz sysroot 等）
    // URL 稳定（版本化目录），使用 immutable 长缓存：填充 HTTP cache，并利于 V8 Wasm code cache 命中
    if (/[\\/]js[\\/]runno[\\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
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

// 页面登录守卫：未登录访问受保护页面时重定向到对应入口的登录页
function guardPage(loginPath) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(loginPath);
    next();
  };
}

// ---------- 页面路由（按入口独立挂载，实现两个独立项目） ----------
if (config.entry === 'all' || config.entry === 'contest') {
  app.get('/login', (req, res) => res.render('contest/login', { user: req.user || null }));
  app.get('/contest/login', (req, res) => res.render('contest/login', { user: req.user || null }));
  // 比赛制入口：先进比赛列表
  app.get('/contest', (req, res) => res.redirect(req.user ? '/contest/contests' : '/contest/login'));
  app.get('/contest/contests', guardPage('/contest/login'), (req, res) => res.render('contest/contests', { user: req.user || null }));
  // 进入比赛 → 该比赛题目列表
  app.get('/contest/contests/:id', guardPage('/contest/login'), (req, res) => res.redirect('/contest/contests/' + req.params.id + '/problems'));
  // 比赛内页面
  app.get('/contest/contests/:cid/problems', guardPage('/contest/login'), (req, res) => res.render('contest/problems', { user: req.user || null, contestId: req.params.cid }));
  app.get('/contest/contests/:cid/problems/:pid', guardPage('/contest/login'), (req, res) => res.render('contest/problem-detail', { user: req.user || null, contestId: req.params.cid, problemId: req.params.pid }));
  app.get('/contest/contests/:cid/submissions', guardPage('/contest/login'), (req, res) => res.render('contest/submissions', { user: req.user || null, contestId: req.params.cid }));
  app.get('/contest/contests/:cid/rank', guardPage('/contest/login'), (req, res) => res.render('contest/rank', { user: req.user || null, contestId: req.params.cid }));
}

if (config.entry === 'all' || config.entry === 'admin') {
  app.get('/login', (req, res) => res.render('admin/login', { user: req.user || null }));
  app.get('/admin/login', (req, res) => res.render('admin/login', { user: req.user || null }));
  // 管理端页面：未登录一律跳登录页
  app.get('/admin', (req, res) => res.redirect(req.user ? '/admin/overview' : '/admin/login'));
  app.get('/admin/overview', guardPage('/admin/login'), (req, res) => res.render('admin/overview', { user: req.user || null }));
  app.get('/admin/nodes', guardPage('/admin/login'), (req, res) => res.render('admin/nodes', { user: req.user || null }));
  app.get('/admin/certs', guardPage('/admin/login'), (req, res) => res.render('admin/certs', { user: req.user || null }));
  app.get('/admin/queue', guardPage('/admin/login'), (req, res) => res.render('admin/queue', { user: req.user || null }));
  app.get('/admin/audit', guardPage('/admin/login'), (req, res) => res.render('admin/audit', { user: req.user || null }));
  app.get('/admin/contests', guardPage('/admin/login'), (req, res) => res.render('admin/contests', { user: req.user || null }));
  app.get('/admin/problems', guardPage('/admin/login'), (req, res) => res.render('admin/problems', { user: req.user || null }));
  app.get('/admin/rejudge', guardPage('/admin/login'), (req, res) => res.render('admin/rejudge', { user: req.user || null }));
}

// 根路径：按入口跳转（未登录跳对应登录页）
app.get('/', (req, res) => {
  if (config.entry === 'admin') return res.redirect(req.user ? '/admin/overview' : '/admin/login');
  return res.redirect(req.user ? '/contest/contests' : '/login');
});

// ---------- 统一错误处理 ----------
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.expose ? err.message : '服务器内部错误' });
});

// ---------- 启动 ----------
seedIfEmpty(db);
// 重启后从 DB 重建内存榜单（仅 OJ Core / 联调模式）
if (config.entry === 'all' || config.entry === 'contest') {
  require('./services/scoreboard').recomputeFromDb();
}
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
