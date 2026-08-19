'use strict';
/**
 * Worker 核心 Agent（注册 / 心跳 / 任务接收 / 评测 / 报告回传）
 * 被 Electron 主进程与 headless 模式共用。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { request } = require('./net');
const sec = require('../security/worker-security');
const wsl = require('../judge/wsl-judge');

const DEVICE_FILE = path.join(__dirname, '..', 'worker.json');
// 参与运行时清单哈希的文件（评测脚本与安全模块）
const MANIFEST_FILES = [
  'judge/wsl-judge.js',
  'security/worker-security.js'
];

function log(tag, msg) {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] [${tag}] ${msg}`);
}

async function ensureRegistered(args) {
  if (fs.existsSync(DEVICE_FILE)) {
    const d = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
    if (args.server) d.server = args.server.replace(/\/$/, '');
    return d;
  }
  if (!args.register || !args.server) {
    throw new Error('首次运行需注册：node judge/headless.js --register <注册码> --server <地址>');
  }
  const server = args.server.replace(/\/$/, '');
  log('register', `注册到 ${server}...`);
  const r = await request('POST', server + '/api/worker/register', {
    body: JSON.stringify({ code: args.register, name: args.name || require('os').hostname(), hostname: require('os').hostname(), os: 'windows-wsl' })
  });
  if (r.status !== 200 || !r.json?.worker_id) throw new Error(`注册失败 HTTP ${r.status}: ${r.text}`);
  const d = { worker_id: r.json.worker_id, cert_id: r.json.cert_id, secret: r.json.secret, server, name: args.name || require('os').hostname() };
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2));
  log('register', `注册成功 ${d.worker_id.slice(0, 8)}… trust_status=${r.json.trust_status}（需管理员审批后领任务）`);
  return d;
}

function connectSSE(url, handlers, onState) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, { headers: { Accept: 'text/event-stream' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`SSE HTTP ${res.statusCode}`)); }
      onState(true); resolve(res);
      let buffer = '', event = 'message';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          const dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          if (dataLines.length && handlers[event]) {
            let data = null; try { data = JSON.parse(dataLines.join('\n')); } catch (_) { data = dataLines.join('\n'); }
            handlers[event](data);
          }
          event = 'message';
        }
      });
      res.on('end', () => onState(false));
      res.on('error', () => onState(false));
    });
    req.on('timeout', () => { req.destroy(); onState(false); });
    req.on('error', (err) => { reject(err); onState(false); });
  });
}

async function run(args, { onStatus } = {}) {
  const dev = await ensureRegistered(args);
  const server = dev.server;
  const status = onStatus || ((s) => { if (s) log('status', s); });
  status(`已连接 ${server} (${dev.worker_id.slice(0, 8)}…)`);

  // 启动自检
  const check = await sec.selfCheck(MANIFEST_FILES);
  const runtimeHash = check.runtimeManifestHash;
  if (!check.ok) { log('selfcheck', '⚠ 主动对抗告警: ' + check.warnings.join('; ')); }
  log('selfcheck', `runtime_manifest_hash=${runtimeHash.slice(0, 16)}…`);

  // 心跳
  setInterval(async () => {
    const payload = { worker_id: dev.worker_id, nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now(), runtime_manifest_hash: runtimeHash };
    payload.sig = sec.signHeartbeat(payload, dev.secret);
    try {
      const r = await request('POST', server + '/api/worker/heartbeat', { body: JSON.stringify(payload) });
      if (r.status === 403) { status('Worker 已被挂起，退出'); process.exit(3); }
    } catch (_) { /* server 不可达 */ }
  }, 15000);

  // 任务队列（串行）
  let busy = false;
  const queue = [];
  async function processQueue() {
    if (busy || !queue.length) return;
    busy = true;
    const task = queue.shift();
    try {
      if (!sec.verifyTaskSig(task, dev.secret)) {
        log('task', `✗ 任务验签失败 ${task.task_id?.slice(0, 8)}（疑似篡改）`);
        return;
      }
      // 运行时清单一致性：任务携带的期望哈希必须与本机一致
      if (task.runtime_manifest_hash && task.runtime_manifest_hash !== runtimeHash) {
        log('task', `✗ 运行时清单不匹配：期望 ${task.runtime_manifest_hash.slice(0, 12)} 实际 ${runtimeHash.slice(0, 12)}，拒绝评测`);
        return;
      }
      status(`评测任务 ${task.task_id.slice(0, 8)} 语言=${task.language} 测试点=${task.problem.testcases.length}`);
      const result = await wsl.judge(task);
      status(`评测完成 → ${result.status} (${result.timeMs}ms)`);

      const report = {
        worker_id: dev.worker_id, task_id: task.task_id, submission_id: task.submission_id,
        attempt: task.attempt, lease_id: task.lease.lease_id, status: result.status,
        cases: result.cases, time_ms: result.timeMs, memory_kb: result.memoryKb,
        message: (result.message || '').slice(0, 4000),
        runtime_manifest_hash: runtimeHash,
        env: { wsl: wsl.wslAvailable() ? 'Ubuntu-22.04' : 'none', trusted: true },
        nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now()
      };
      report.sig = sec.signReport(report, dev.secret);
      const r = await request('POST', server + '/api/worker/report', { body: JSON.stringify(report) });
      log('report', r.status === 200 ? `回传成功 ${task.task_id.slice(0, 8)} → ${result.status}` : `✗ 回传被拒 HTTP ${r.status}: ${r.text}`);
    } catch (err) {
      log('task', `✗ 异常: ${err.message}`);
    } finally {
      busy = false; processQueue();
    }
  }

  // SSE 任务流 + 轮询兜底
  let sseAlive = false, pollTimer = null;
  const token = sec.streamToken(dev.worker_id, dev.secret, Date.now());
  const sseUrl = `${server}/api/worker/events?worker_id=${dev.worker_id}&token=${token}`;

  async function connect() {
    try {
      await connectSSE(sseUrl, {
        task: (t) => { queue.push(t); processQueue(); },
        command: (c) => { log('command', `指令: ${c.action}`); if (c.action === 'reconnect') status('服务端要求重连'); },
        blacklist: () => { log('command', 'Worker 被拉黑，退出'); process.exit(3); }
      }, (alive) => {
        sseAlive = alive;
        if (alive) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
        else { setTimeout(connect, 5000); if (!pollTimer) pollTimer = setInterval(pollOnce, 5000); }
      });
    } catch (_) {
      setTimeout(connect, 10000);
      if (!pollTimer) pollTimer = setInterval(pollOnce, 5000);
    }
  }

  async function pollOnce() {
    if (sseAlive) return;
    const payload = { worker_id: dev.worker_id, nonce: crypto.randomBytes(16).toString('hex'), ts: Date.now() };
    payload.sig = sec.signHeartbeat(payload, dev.secret);
    try {
      const r = await request('POST', server + '/api/worker/pull', { body: JSON.stringify(payload) });
      if (r.status === 200 && r.json?.tasks?.length) {
        log('poll', `拉取到 ${r.json.tasks.length} 个任务`);
        r.json.tasks.forEach((t) => queue.push(t));
        processQueue();
      }
    } catch (_) {}
  }

  await connect();
  status('就绪，等待任务…');
  return dev;
}

module.exports = { run, ensureRegistered, log };
