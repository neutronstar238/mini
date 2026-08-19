'use strict';
/**
 * 性能指标采集（指导文档 §20）
 * - 从 :3001 internal API 采样：HTTP 负载、队列深度、worker 状态、judge throughput
 * - 从 SQLite 统计 write/s 与 busy/error
 * 用法：node scripts/stress/metrics.js [--interval 3] [--db e:\mini\server\data\mini-oj.db]
 */
const crypto = require('crypto');
const SECRET = process.env.INTERNAL_API_SECRET || 'test-internal-secret';
const CORE = process.env.CORE_BASE_URL || 'http://127.0.0.1:3001';
const DB_FILE = process.env.MINI_OJ_DB || 'e:/mini/server/data/mini-oj.db';

const argv = process.argv.slice(2);
function arg(name, def) { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1]; }
const INTERVAL = Number(arg('--interval', 3)) * 1000;

async function callInternal(path) {
  const ts = String(Date.now());
  const token = crypto.createHmac('sha256', SECRET).update(`${ts}:${path}`).digest('hex');
  const r = await fetch(CORE + path, { headers: { 'X-Internal-Token': token, 'X-Internal-Ts': ts } });
  return r.json().catch(() => ({}));
}

let prevAttempts = 0, prevTime = Date.now();
let sqliteWrites = 0, sqliteErrors = 0, httpReqs = 0, sseConns = 0;

// 拦截 http 统计（本进程内模拟 HTTP 计数：internal 调用次数）
async function sample() {
  const now = Date.now();
  const [overview, queue, nodes] = await Promise.all([
    callInternal('/internal/admin/overview'),
    callInternal('/internal/admin/queue'),
    callInternal('/internal/admin/nodes')
  ]);
  httpReqs += 3;

  // judge throughput（attempts 增长）
  let attempts = 0;
  try {
    const Database = require('e:/mini/server/node_modules/better-sqlite3');
    const db = new Database(DB_FILE, { readonly: true });
    attempts = db.prepare('SELECT COUNT(*) c FROM judge_attempts').get().c;
    db.close();
  } catch (e) { sqliteErrors++; }

  const dt = (now - prevTime) / 1000;
  const throughput = dt > 0 ? Math.round((attempts - prevAttempts) / dt) : 0;
  prevAttempts = attempts; prevTime = now;

  const online = nodes.workers ? nodes.workers.filter((w) => w.online).length : 0;
  console.log(`[metrics @${new Date().toLocaleTimeString()}]` +
    ` submissions=${overview.submissions} pending=${overview.pending} judging=${overview.judging}` +
    ` | queue=${queue.submissions ? queue.submissions.length : 0}` +
    ` | workers=${overview.workers} online=${online}` +
    ` | judgeThroughput=${throughput}/s` +
    ` | attempts=${attempts} sqliteErr=${sqliteErrors}` +
    ` | internalReq=${httpReqs}`);
}

console.log('开始采样（Ctrl+C 停止）…');
sample();
setInterval(sample, INTERVAL);
