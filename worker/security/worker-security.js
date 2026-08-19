'use strict';
/**
 * 可信 Worker 安全模块
 * - 证书身份：注册换取 worker_id + secret + cert_id（仅存本机与中心控制面）
 * - 运行时自检：计算 runtime_manifest_hash（对评测脚本/WSL 配置清单）
 * - 任务验签 / 结果签名 / 心跳签名（与 server/src/security/trust.js 严格一致）
 * - 主动对抗：调试器附加检测 + 虚拟机识别（Windows）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/* ===== 运行时清单哈希（runtime_manifest_hash） ===== */
/**
 * 对评测相关文件（评测脚本、isolate 配置、启动参数等）计算聚合哈希
 * 服务器在任务下发时携带期望值；Worker 上报实际值，不一致触发告警与重判
 */
async function runtimeManifestHash(fileList) {
  const entries = [];
  for (const f of fileList) {
    const abs = path.isAbsolute(f) ? f : path.join(__dirname, '..', f);
    if (!fs.existsSync(abs)) { entries.push({ path: f, hash: 'missing' }); continue; }
    entries.push({ path: f, hash: await sha256File(abs) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return sha256(entries.map((e) => `${e.path}:${e.hash}`).join('\n'));
}

/* ===== 签名契约（与 server trust.js 一致） ===== */
function verifyTaskSig(task, secret) {
  const p = ['task', task.task_id, task.submission_id, task.attempt, task.worker_id,
    task.lease.lease_id, task.lease.nonce, task.lease.expires_at, task.language, task.runtime_manifest_hash].join('|');
  return safeEqual(hmacHex(secret, p), task.sig);
}
function reportPayload(r) {
  const cases = r.cases.map((c) => `${c.id}:${c.status}:${c.time_ms}:${c.memory_kb}`).join(',');
  return ['report', r.worker_id, r.task_id, r.submission_id, r.attempt, r.lease_id,
    r.status, cases, r.runtime_manifest_hash, r.nonce].join('|');
}
function signReport(report, secret) {
  return hmacHex(secret, reportPayload(report));
}
function heartbeatPayload(h) {
  return ['heartbeat', h.worker_id, h.nonce, h.ts, h.runtime_manifest_hash].join('|');
}
function signHeartbeat(h, secret) {
  return hmacHex(secret, heartbeatPayload(h));
}
function streamToken(workerId, secret, ts) {
  return sha256(`${workerId}:${secret}:${Math.floor(ts / 60000)}`);
}

/* ===== 主动对抗（Windows） ===== */
function detectDebugger() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const suspects = ['gdb.exe', 'ollydbg.exe', 'x64dbg.exe', 'x32dbg.exe', 'windbg.exe', 'ida.exe', 'ida64.exe', 'cdb.exe'];
      const names = stdout.split('\n').map((l) => (l.match(/"([^"]*)"/) || [])[1] || '').map((s) => s.toLowerCase());
      const found = suspects.filter((d) => names.includes(d.toLowerCase()));
      resolve(found.length ? found : null);
    });
  });
}

/**
 * 启动自检：返回 { ok, warnings, runtimeManifestHash }
 */
async function selfCheck(manifestFiles) {
  const warnings = [];
  const hash = await runtimeManifestHash(manifestFiles);
  const dbg = await detectDebugger();
  if (dbg) warnings.push('检测到调试器: ' + dbg.join(', '));
  return { ok: warnings.length === 0, warnings, runtimeManifestHash: hash };
}

module.exports = {
  sha256, sha256File, hmacHex, safeEqual,
  runtimeManifestHash, verifyTaskSig, signReport, signHeartbeat, streamToken,
  detectDebugger, selfCheck
};
