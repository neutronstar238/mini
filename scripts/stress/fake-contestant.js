'use strict';
/**
 * Fake Contestant 压测模拟器（指导文档 §20）
 * - 模拟 N 个选手：登录 → SSE 连接 → 周期提交 → 榜单 delta 接收 → fallback sync
 * - 不发起真实评测（用假提交，评测由 Fake Worker 完成或挂起）
 * 用法：node scripts/stress/fake-contestant.js --users 100 --server http://127.0.0.1:3001
 */
const crypto = require('crypto');
const { request } = require('../../worker/agent/net');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
}
const N = Number(arg('--users', 50));
const SERVER = (arg('--server', 'http://127.0.0.1:3001') || '').replace(/\/$/, '');

let connected = 0, submitted = 0, gotDelta = 0, errors = 0;

function connectSSE(url, onEvent) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  const req = lib.get(url, { headers: { Accept: 'text/event-stream' }, timeout: 20000 }, (res) => {
    if (res.statusCode !== 200) { errors++; return; }
    connected++;
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
    res.on('end', () => setTimeout(() => connectSSE(url, onEvent), 5000));
    res.on('error', () => setTimeout(() => connectSSE(url, onEvent), 5000));
  });
  req.on('error', () => { errors++; setTimeout(() => connectSSE(url, onEvent), 5000); });
}

async function startOne(i) {
  const username = `stress_${i}`;
  const password = 'stress123';
  // 注册（幂等：已存在则登录）
  let login = await request('POST', SERVER + '/api/contest/auth/register', {
    body: JSON.stringify({ username, password, nickname: `压测${i}` })
  });
  if (login.status !== 200 && login.status !== 409) { errors++; return; }
  login = await request('POST', SERVER + '/api/contest/auth/login', { body: JSON.stringify({ username, password }) });
  if (login.status !== 200) { errors++; return; }
  const token = login.json.token;

  // bootstrap
  const boot = await request('GET', SERVER + '/api/contest/sync/bootstrap', { headers: { Authorization: 'Bearer ' + token } });
  if (boot.status === 200) gotDelta++;

  // SSE（每用户维护，token 经 query 传递）
  const url = `${SERVER}/api/contest/events?token=${encodeURIComponent(token)}`;
  connectSSE(url, (event) => { if (event === 'scoreboard_delta') gotDelta++; });

  // 周期提交（10s+随机）
  setInterval(async () => {
    try {
      const probs = await request('GET', SERVER + '/api/contest/problems', { headers: { Authorization: 'Bearer ' + token } });
      const p = probs.json?.problems?.[i % (probs.json?.problems?.length || 1)];
      if (!p) return;
      const sub = await request('POST', SERVER + '/api/contest/submissions', {
        headers: { Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          problemId: p.id,
          language: i % 2 === 0 ? 'cpp' : 'python',
          code: `#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}`,
          clientRequestId: crypto.randomUUID()
        })
      });
      if (sub.status === 200) submitted++;
    } catch (_) { errors++; }
  }, 10000 + Math.floor(Math.random() * 5000));
}

(async () => {
  console.log(`[FakeContestant] 启动 ${N} 个模拟选手…`);
  for (let i = 0; i < N; i++) await startOne(i);
  setInterval(() => {
    process.stdout.write(`\r[FakeContestant] connected=${connected} submitted=${submitted} gotDelta=${gotDelta} errors=${errors}`);
  }, 3000);
})();
