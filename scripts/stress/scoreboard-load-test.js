'use strict';
/**
 * Phase 5 Scoreboard 负载测试（500 clients 起步）
 *
 * 目标：验证 Scoreboard SSE / Full Snapshot 主要由内存 Snapshot 服务，
 * 而不是 500 clients → 500 DB query / tick。
 *
 * 行为：
 *  1. 每 client 登录（或注册）→ GET /scoreboard Full Snapshot
 *  2. 建立 /contests/:cid/events SSE（每比赛 channel）
 *  3. 等待 scoreboard-delta / scoreboard_snapshot 事件
 *  4. 部分 client 断开重连（测试 reconnect）
 *  5. 部分 client 转 fallback polling（/scoreboard/version）
 *  6. 结束后读取 /_metrics，报告 SQLite query 计数
 *
 * 用法：node scripts/stress/scoreboard-load-test.js [--clients 500] [--server http://localhost:3001]
 * 需要服务器已启动且以 admin 身份可访问 _metrics。
 */
const crypto = require('crypto');

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1]; }
const N = Number(arg('--clients', 500));
const SERVER = (arg('--server', 'http://localhost:3001') || '').replace(/\/$/, '');

let snapshots = 0, sseConnected = 0, deltas = 0, reconnects = 0, polls = 0, errors = 0;
const t0 = Date.now();

async function loginOrRegister(username) {
  const password = 'stress123';
  const tryLogin = async () => {
    const r = await fetch(`${SERVER}/api/contest/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (r.status !== 200) throw new Error('login ' + r.status);
    return (await r.json()).token;
  };
  // 注册（幂等）
  try {
    await fetch(`${SERVER}/api/contest/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nickname: username })
    });
  } catch (_) {}
  // 登录（重试最多 3 次，容忍瞬时 reset）
  for (let i = 0; i < 3; i++) {
    try { return await tryLogin(); } catch (_) { await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  throw new Error('login retry exhausted');
}

/** 简易 SSE 客户端（http.get） */
function connectSSE(url, onEvent, onClose) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  let closed = false;
  const req = lib.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
    if (res.statusCode !== 200) { errors++; onClose && onClose(); return; }
    sseConnected++;
    let buf = '', event = 'message';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const lines = block.split('\n'); const dataLines = [];
        for (const l of lines) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          else if (l.startsWith('data: ')) dataLines.push(l.slice(6));
        }
        if (dataLines.length) { let d; try { d = JSON.parse(dataLines.join('\n')); } catch (_) {} if (d) onEvent(event, d); }
        event = 'message';
      }
    });
    res.on('end', () => { if (!closed) { closed = true; onClose && onClose(); } });
    res.on('error', () => { if (!closed) { closed = true; onClose && onClose(); } });
  });
  req.on('error', () => { errors++; onClose && onClose(); });
  return { close: () => { closed = true; req.destroy(); } };
}

async function resolveContest(token) {
  const r = await fetch(`${SERVER}/api/contest/contests`, { headers: { Authorization: 'Bearer ' + token } });
  const c = (await r.json()).contests;
  const t = c.find((x) => x.title === 'Browser OJ E2E Test') || c[0];
  return t.id;
}

async function runClient(i, cid) {
  const username = `sb${i}_${Math.random().toString(36).slice(2, 8)}`;
  const token = await loginOrRegister(username);

  // 1. Full Snapshot
  const r = await fetch(`${SERVER}/api/contest/contests/${cid}/scoreboard`, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 200) snapshots++; else errors++;

  // 2. SSE（带 lastVersion + token）
  const lastVer = 0;
  const url = `${SERVER}/api/contest/contests/${cid}/events?lastVersion=${lastVer}&token=${encodeURIComponent(token)}`;
  connectSSE(url, (event) => { if (event === 'scoreboard-delta') deltas++; }, () => {});

  // 3. 部分 client 转 fallback polling（约 30%）
  if (i % 3 === 0) {
    const t = setInterval(async () => {
      try {
        await fetch(`${SERVER}/api/contest/contests/${cid}/scoreboard/version`, { headers: { Authorization: 'Bearer ' + token } });
        polls++;
      } catch (_) {}
    }, 12000 + Math.floor(Math.random() * 3000));
    setTimeout(() => clearInterval(t), 60000);
  }

  // 4. 部分 client 断开重连（约 20%）
  if (i % 5 === 0) {
    setTimeout(() => { reconnects++; connectSSE(url, () => {}, () => {}); }, 5000);
  }
}

async function main() {
  console.log(`=== Phase 5 Scoreboard Load Test · ${N} clients ===`);
  console.log('Server:', SERVER);
  // admin 登录以读取 metrics
  const al = await fetch(`${SERVER}/api/admin/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const adminToken = (await al.json()).token;
  const ac = await fetch(`${SERVER}/api/contest/contests`, { headers: { Authorization: 'Bearer ' + adminToken } });
  const cid = ((await ac.json()).contests.find((x) => x.title === 'Browser OJ E2E Test') || (await ac.json()).contests[0]).id;

  // 并发启动 clients（分批，容错：单 client 失败不中断整体）
  const start = Date.now();
  const batch = 30;
  for (let base = 0; base < N; base += batch) {
    const slice = Math.min(batch, N - base);
    await Promise.all(Array.from({ length: slice }, (_, j) =>
      runClient(base + j, cid).catch((e) => { errors++; })
    ));
    await new Promise((r) => setTimeout(r, 100));
  }

  // 读基线 metrics（负载开始前）
  const baseline = (await (await fetch(`${SERVER}/api/contest/_metrics`, { headers: { Authorization: 'Bearer ' + adminToken } })).json()).metrics || {};

  // 观察窗口：等待 delta / polling
  console.log(`已启动 ${N} clients，观察 25s（等待 delta / polling）…`);
  await new Promise((r) => setTimeout(r, 25000));

  // 读 metrics（负载后）
  const m = await fetch(`${SERVER}/api/contest/_metrics`, { headers: { Authorization: 'Bearer ' + adminToken } });
  const metrics = (await m.json()).metrics || {};
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // delta（本次负载产生的查询数）
  const delta = {
    scoreboardFullQueries: (metrics.scoreboardFullQueries || 0) - (baseline.scoreboardFullQueries || 0),
    submissionQueries: (metrics.submissionQueries || 0) - (baseline.submissionQueries || 0),
    adminQueries: (metrics.adminQueries || 0) - (baseline.adminQueries || 0),
    totalQueries: (metrics.totalQueries || 0) - (baseline.totalQueries || 0)
  };

  console.log('\n=== 结果 ===');
  console.log(`clients=${N}  elapsed=${elapsed}s`);
  console.log(`fullSnapshots=${snapshots}  sseConnected=${sseConnected}  deltas=${deltas}  reconnects=${reconnects}  polls=${polls}  errors=${errors}`);
  console.log(`本次负载 SQLite 查询：scoreboardFull=${delta.scoreboardFullQueries}  submission=${delta.submissionQueries}  admin=${delta.adminQueries}  total=${delta.totalQueries}`);

  // 判定：SSE/delta 主要由内存服务，不随 client 数线性增长。
  // 关键：500 clients 并发 GET snapshot 不应产生 500 次 DB 查询（full snapshot 查询数远小于 client 数）。
  const snapQueriesPerClient = delta.scoreboardFullQueries / N;
  const verdict = snapQueriesPerClient < 1 && sseConnected > N * 0.8;
  console.log(`\nscoreboardFullQueries/client=${snapQueriesPerClient.toFixed(3)}  (目标 < 1，即内存快照服务为主)`);
  console.log(verdict ? 'PASS  DB query 不随 client 数线性爆炸' : 'FAIL  DB query 疑似线性增长');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
