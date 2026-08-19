'use strict';
/**
 * Fake Worker 压测模拟器（指导文档 §20）
 * - 不启动真实 WSL，模拟 Worker 协议：WebSocket/SSE 连接 + 心跳 + 收任务 + 回传
 * - 可指定数量：--workers 100 --server http://127.0.0.1:3001 --register-code OJ-XXX
 * - 每个 Fake Worker 注册后：心跳（15s±jitter）、收任务立即模拟评测完成（随机 verdict）
 * 用法：node scripts/stress/fake-worker.js --workers 100 --server http://127.0.0.1:3001
 */
const crypto = require('crypto');
const { request } = require('../../worker/agent/net');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1];
}

const N = Number(arg('--workers', 20));
const SERVER = (arg('--server', 'http://127.0.0.1:3001') || '').replace(/\/$/, '');
const CODES = (arg('--codes', arg('--register-code', '')) || '').split(',').filter(Boolean);
if (!CODES.length) { console.error('需要 --codes 参数（逗号分隔的注册码列表）或 --register-code'); process.exit(1); }

/** 简易 SSE 客户端（收任务） */
function connectSSE(url, onEvent, onState) {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? require('http') : require('https');
  const req = lib.get(url, { headers: { Accept: 'text/event-stream' }, timeout: 20000 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); onState && onState(false); return; }
    onState && onState(true);
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
    res.on('end', () => { onState && onState(false); setTimeout(() => connectSSE(url, onEvent, onState), 5000); });
    res.on('error', () => { onState && onState(false); setTimeout(() => connectSSE(url, onEvent, onState), 5000); });
  });
  req.on('error', () => { onState && onState(false); setTimeout(() => connectSSE(url, onEvent, onState), 5000); });
}

/** 签名（与 worker-security 一致） */
function hmac(secret, payload) { return crypto.createHmac('sha256', secret).update(payload).digest('hex'); }
function signTaskVerify(task, secret) {
  const p = ['task', task.task_id, task.submission_id, task.attempt, task.worker_id,
    task.lease.lease_id, task.lease.nonce, task.lease.expires_at, task.language, task.runtime_manifest_hash].join('|');
  const expect = hmac(secret, p);
  const a = Buffer.from(expect), b = Buffer.from(String(task.sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function reportPayload(r) {
  const cases = r.cases.map((c) => `${c.id}:${c.status}:${c.time_ms}:${c.memory_kb}`).join(',');
  return ['report', r.worker_id, r.task_id, r.submission_id, r.attempt, r.lease_id, r.status, cases, r.runtime_manifest_hash, r.nonce].join('|');
}
function heartbeatPayload(h) { return ['heartbeat', h.worker_id, h.nonce, h.ts, h.runtime_manifest_hash].join('|'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

let connected = 0, failed = 0, dispatched = 0, reported = 0;

async function startOne(i) {
  try {
    // 注册（每个 worker 用循环列表中的注册码）
    const code = CODES[i % CODES.length];
    const r = await request('POST', SERVER + '/api/worker/register', {
      body: JSON.stringify({ code, name: `FakeWorker-${i}`, hostname: `fake-${i}`, os: 'fake-linux' })
    });
    if (r.status !== 200 || !r.json?.worker_id) { failed++; return; }
    const { worker_id, secret } = r.json;
    const runtimeHash = sha256('fake-runtime-' + i);

    // SSE 任务流
    const token = sha256(`${worker_id}:${secret}:${Math.floor(Date.now() / 60000)}`);
    connectSSE(`${SERVER}/api/worker/events?worker_id=${worker_id}&token=${token}`, (event, task) => {
      if (event === 'task') {
        // 验签 → 模拟评测（随机 verdict）→ 签名回传
        if (!signTaskVerify(task, secret)) { failed++; return; }
        dispatched++;
        setTimeout(async () => {
          const verdicts = ['AC', 'AC', 'AC', 'WA', 'TLE'];
          const status = verdicts[Math.floor(Math.random() * verdicts.length)];
          const cases = (task.problem.testcases || []).map((tc) => ({
            id: tc.id, status: status === 'AC' ? 'AC' : status, time_ms: 10 + Math.floor(Math.random() * 90), memory_kb: 0
          }));
          const report = {
            worker_id, task_id: task.task_id, submission_id: task.submission_id,
            attempt: task.attempt, lease_id: task.lease.lease_id, status,
            cases, time_ms: 50, memory_kb: 0, message: '',
            runtime_manifest_hash: runtimeHash,
            env: { wsl: 'fake', trusted: true },
            nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now()
          };
          report.sig = hmac(secret, reportPayload(report));
          const rep = await request('POST', SERVER + '/api/worker/report', { body: JSON.stringify(report) });
          if (rep.status === 200) reported++;
        }, 5 + Math.floor(Math.random() * 30));
      }
    });

    // 心跳（15s ± jitter）
    const interval = () => {
      const payload = { worker_id, nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now(), runtime_manifest_hash: runtimeHash };
      payload.sig = hmac(secret, heartbeatPayload(payload));
      request('POST', SERVER + '/api/worker/heartbeat', { body: JSON.stringify(payload) }).catch(() => {});
      setTimeout(interval, 15000 + (Math.floor(Math.random() * 6000) - 3000));
    };
    setTimeout(interval, 1000 + Math.floor(Math.random() * 3000));

    connected++;
  } catch (_) { failed++; }
}

// 注册并上报
(async () => {
  for (let i = 0; i < N; i++) await startOne(i);
  setInterval(() => {
    process.stdout.write(`\r[FakeWorker] connected=${connected} failed=${failed} dispatched=${dispatched} reported=${reported}`);
  }, 3000);
  console.log(`\n[FakeWorker] 启动 ${N} 个模拟 Worker（注册码 ${CODES.length} 个轮换）`);
})();
