'use strict';
/**
 * 内存 Worker Registry（指导文档 §5）
 * - Worker 心跳只更新内存，不写 SQLite
 * - DB 只持久化静态信息：首次注册、环境变化、管理员要求重新检测
 * - 在线状态判定：<=30s ONLINE，30~45s SUSPECT，>45s OFFLINE
 * - 调度选择 Worker 也基于此内存态（含 slots/currentTask/queue）
 */
const config = require('../config');

/** workerId -> runtime state */
const workerRuntimeMap = new Map();

/** 心跳返回 interval（含随机 jitter，防同频） */
function nextHeartbeatInterval() {
  const jitter = Math.floor(Math.random() * config.WORKER_HEARTBEAT_JITTER * 2) - config.WORKER_HEARTBEAT_JITTER;
  return config.WORKER_HEARTBEAT_INTERVAL + jitter;
}

/** Worker 上线：连接建立时（SSE/WS 连接） */
function onConnect(workerId) {
  const now = Date.now();
  const entry = workerRuntimeMap.get(workerId) || {
    connection: null,
    lastHeartbeat: now,
    state: 'ONLINE',
    cpuUsage: 0,
    memoryUsage: 0,
    slots: 1,
    runningTasks: [],
    currentTask: null,
    queue: 0
  };
  entry.state = 'ONLINE';
  entry.lastHeartbeat = now;
  workerRuntimeMap.set(workerId, entry);
}

/** 心跳：仅更新内存（禁止写 DB） */
function onHeartbeat(workerId, payload) {
  const now = Date.now();
  const entry = workerRuntimeMap.get(workerId) || {
    connection: null, slots: 1, runningTasks: [], currentTask: null, queue: 0
  };
  entry.lastHeartbeat = now;
  entry.state = 'ONLINE';
  if (payload) {
    if (typeof payload.cpuUsage === 'number') entry.cpuUsage = payload.cpuUsage;
    if (typeof payload.memoryUsage === 'number') entry.memoryUsage = payload.memoryUsage;
    if (typeof payload.slots === 'number') entry.slots = payload.slots;
  }
  workerRuntimeMap.set(workerId, entry);
}

/** 连接断开 */
function onDisconnect(workerId) {
  const e = workerRuntimeMap.get(workerId);
  if (e) e.state = 'DISCONNECTED';
  // 注意：正在执行的任务不能立即重新分配，需由 Lease 状态决定
}

/** 计算在线状态（不查 DB） */
function onlineState(entry, now = Date.now()) {
  const age = now - (entry?.lastHeartbeat || 0);
  if (age <= config.WORKER_SUSPECT_AFTER) return 'ONLINE';
  if (age <= config.WORKER_OFFLINE_AFTER) return 'SUSPECT';
  return 'OFFLINE';
}

/** 是否可被调度（approved + 未禁用 + ONLINE） */
function schedulable(workerRow) {
  if (!workerRow || workerRow.trust_status !== 'approved' || workerRow.suspended) return false;
  const e = workerRuntimeMap.get(workerRow.id);
  return onlineState(e) === 'ONLINE';
}

/** 在线 Worker 数量（内存判定） */
function onlineCount() {
  const now = Date.now();
  let n = 0;
  for (const e of workerRuntimeMap.values()) {
    if (onlineState(e, now) === 'ONLINE') n++;
  }
  return n;
}

/** 快照（结合 DB 静态字段与内存动态状态） */
function snapshot() {
  const db = require('../store/db');
  const now = Date.now();
  return db.workers.all().map((w) => {
    const e = workerRuntimeMap.get(w.id);
    return {
      id: w.id, name: w.name, hostname: w.hostname, os: w.os, certId: w.certId,
      tier: w.tier || 'sink', trust_status: w.trust_status || 'pending', suspended: !!w.suspended,
      anomalyCount: w.anomalyCount || 0, anomalyReason: w.anomalyReason || '',
      runtime_manifest_hash: w.runtime_manifest_hash || '',
      envFingerprint: w.envFingerprint,
      registeredAt: w.registeredAt,
      onlineState: e ? onlineState(e, now) : 'OFFLINE',
      lastHeartbeat: e ? e.lastHeartbeat : null,
      cpuUsage: e ? e.cpuUsage : 0,
      memoryUsage: e ? e.memoryUsage : 0,
      slots: e ? e.slots : 1,
      currentTask: e ? e.currentTask : null,
      runningTasks: e ? e.runningTasks : [],
      queue: e ? e.queue : 0
    };
  });
}

function publicWorker(w) {
  return {
    id: w.id, name: w.name, hostname: w.hostname, os: w.os, certId: w.certId,
    tier: w.tier, trust_status: w.trust_status, suspended: w.suspended,
    anomalyCount: w.anomalyCount, anomalyReason: w.anomalyReason,
    runtime_manifest_hash: w.runtime_manifest_hash, envFingerprint: w.envFingerprint,
    registeredAt: w.registeredAt,
    online: w.onlineState === 'ONLINE', onlineState: w.onlineState, lastHeartbeat: w.lastHeartbeat,
    cpuUsage: w.cpuUsage, memoryUsage: w.memoryUsage, slots: w.slots,
    currentTask: w.currentTask, runningTasks: w.runningTasks, queue: w.queue
  };
}

/** 标记任务已分配/已释放（调度器调用） */
function assignTask(workerId, task) {
  const e = workerRuntimeMap.get(workerId) || { runningTasks: [], queue: 0 };
  e.currentTask = { task_id: task.task_id, submission_id: task.submission_id, status: 'ASSIGNED', at: Date.now() };
  if (e.queue > 0) e.queue--;
  workerRuntimeMap.set(workerId, e);
}
function releaseTask(workerId, taskId) {
  const e = workerRuntimeMap.get(workerId);
  if (e) { e.currentTask = null; e.runningTasks = e.runningTasks.filter((t) => t !== taskId); }
}

/** 管理员修改配置后同步到内存（如挂起/审批） */
function onConfigChange(workerId, patch) {
  const e = workerRuntimeMap.get(workerId);
  if (e && patch.suspended === true) e.state = 'SUSPENDED';
}

module.exports = {
  workerRuntimeMap, nextHeartbeatInterval,
  onConnect, onHeartbeat, onDisconnect, onlineState, schedulable,
  onlineCount, snapshot, publicWorker, assignTask, releaseTask, onConfigChange
};
