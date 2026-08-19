'use strict';
/**
 * 信任链与安全闭环（正式申请书 §6.3）
 * - Worker 证书身份 / trust_status(approved) 审批
 * - 任务租约 lease(lease_id+nonce+expires_at) 签名与校验
 * - runtime_manifest_hash 下发期望/上报实际比对
 * - 任务/结果/心跳 HMAC 验签 + nonce 防重放 + 幂等
 * - 跨节点抽查：同一 submission 派发第二 Worker 重判比对
 */
const crypto = require('crypto');
const config = require('../config');

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

/* ============ 任务签名 ============ */
// payload = task|task_id|submission_id|attempt|worker_id|lease_id|nonce|expires_at|language|runtime_manifest_hash
function taskPayload(t) {
  return ['task', t.task_id, t.submission_id, t.attempt, t.worker_id,
    t.lease.lease_id, t.lease.nonce, t.lease.expires_at, t.language, t.runtime_manifest_hash].join('|');
}
function signTask(task, secret) {
  return hmacHex(secret, taskPayload(task));
}
function verifyTaskSig(task, secret) {
  return safeEqual(signTask(task, secret), task.sig);
}

/* ============ 结果签名 ============ */
// payload = report|worker_id|task_id|submission_id|attempt|lease_id|status|cases|runtime_manifest_hash|nonce
function reportPayload(r) {
  const cases = r.cases.map((c) => `${c.id}:${c.status}:${c.time_ms}:${c.memory_kb}`).join(',');
  return ['report', r.worker_id, r.task_id, r.submission_id, r.attempt, r.lease_id,
    r.status, cases, r.runtime_manifest_hash, r.nonce].join('|');
}
function signReport(report, secret) {
  return hmacHex(secret, reportPayload(report));
}
function verifyReportSig(report, secret) {
  return safeEqual(signReport(report, secret), report.sig);
}

/* ============ 心跳签名 ============ */
// payload = heartbeat|worker_id|nonce|ts|runtime_manifest_hash
function heartbeatPayload(h) {
  return ['heartbeat', h.worker_id, h.nonce, h.ts, h.runtime_manifest_hash].join('|');
}
function signHeartbeat(h, secret) {
  return hmacHex(secret, heartbeatPayload(h));
}
function verifyHeartbeatSig(h, secret) {
  return safeEqual(signHeartbeat(h, secret), h.sig);
}

/* ============ 租约与 nonce ============ */
const nonceCache = new Map();
function checkNonce(nonce, ts) {
  const now = Date.now();
  if (!nonce || !Number.isFinite(ts) || Math.abs(now - ts) > config.nonceTtlMs) {
    return { ok: false, reason: '时间戳无效或过期' };
  }
  if (nonceCache.has(nonce)) return { ok: false, reason: 'nonce 重复（疑似重放）' };
  for (const [k, v] of nonceCache) {
    if (now - v > config.nonceTtlMs) nonceCache.delete(k);
  }
  nonceCache.set(nonce, now);
  return { ok: true };
}

// 已使用的 lease_id 缓存（幂等：同一租约只接受一次回传）
const usedLeases = new Map();
function checkLeaseUsed(leaseId) {
  if (usedLeases.has(leaseId)) return true;
  usedLeases.set(leaseId, Date.now());
  for (const [k, v] of usedLeases) {
    if (Date.now() - v > config.nonceTtlMs) usedLeases.delete(k);
  }
  return false;
}

/* ============ 证书身份 ============ */
function generateWorkerSecret() {
  return crypto.randomBytes(32).toString('hex');
}
function generateWorkerCertId() {
  return 'WKR-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}
function generateRegisterCode() {
  return 'OJ-' + crypto.randomBytes(8).toString('hex').toUpperCase();
}

/* ============ runtime_manifest_hash ============ */
function manifestHash(entries) {
  // entries: {path,hash}[]，规范化排序后聚合
  const parts = entries
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((e) => `${e.path}:${e.hash}`);
  return sha256(parts.join('\n'));
}

module.exports = {
  hmacHex, sha256, safeEqual,
  signTask, verifyTaskSig, signReport, verifyReportSig, signHeartbeat, verifyHeartbeatSig,
  checkNonce, checkLeaseUsed,
  generateWorkerSecret, generateWorkerCertId, generateRegisterCode,
  manifestHash
};
