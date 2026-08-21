'use strict';
/**
 * SQLite 关系库查询计数（Phase 5）
 *
 * 目标：证明 Scoreboard SSE / Full Snapshot 主要由内存 Snapshot 服务，
 * 而不是 500 clients → 500 DB query / tick。
 *
 * 计数维度：
 *  - scoreboardFullQueries : Full Snapshot / rebuild / participant recompute 触发的 SQL
 *  - submissionQueries     : 选手端提交 / 个人提交列表 / 个人 SSE 相关 SQL
 *  - adminQueries          : Admin 端 submission 查询 / 真实榜单 / rejudge 相关 SQL
 *
 * 说明：这些计数器是「轻量开发期观测」指标，不是安全/计费依据。
 * 通过 GET /api/contest/_metrics 或 GET /internal/admin/metrics 暴露。
 */
const counters = {
  scoreboardFullQueries: 0,
  submissionQueries: 0,
  adminQueries: 0,
  totalQueries: 0
};

/** 自 SQLite 调用点的标记 token */
const K = {
  SCOREBOARD: 'SCOREBOARD',
  SUBMISSION: 'SUBMISSION',
  ADMIN: 'ADMIN'
};

function inc(kind, n = 1) {
  if (kind === K.SCOREBOARD) counters.scoreboardFullQueries += n;
  else if (kind === K.SUBMISSION) counters.submissionQueries += n;
  else if (kind === K.ADMIN) counters.adminQueries += n;
  counters.totalQueries += n;
}

function snapshot() {
  return { ...counters, at: new Date().toISOString() };
}

function reset() {
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = { K, inc, snapshot, reset };
