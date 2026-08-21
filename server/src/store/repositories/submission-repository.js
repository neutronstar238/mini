'use strict';
/**
 * SubmissionRepository —— 关系型 submissions 表（Phase 4 主链路）
 *
 * 关键职责：
 *  - 幂等：UNIQUE(user_id, client_request_id)，重复提交返回原 submissionId（DUPLICATE_REQUEST）
 *  - 限速：rate_bucket_at 滑动窗口（同用户 1 次/秒）
 *  - 短事务：INSERT / UPDATE 各自独立事务，禁止在事务内等待 Judge/网络
 *  - 状态机持久化：QUEUED / JUDGING / FINISHED + verdict
 */
const crypto = require('crypto');
const { getOjDb } = require('../../db/sqlite');
const metrics = require('../db-metrics');

/** 关系行 → 业务对象（列名 → 驼峰） */
function rowToObj(r) {
  if (!r) return null;
  return {
    id: r.id,
    contestId: r.contest_id,
    problemId: r.problem_id,
    userId: r.user_id,
    language: r.language,
    sourceCode: r.source_code,
    status: r.status,
    verdict: r.verdict,
    createdAt: r.created_at,
    serverReceivedAt: r.server_received_at,
    judgeStartedAt: r.judge_started_at,
    judgeFinishedAt: r.judge_finished_at,
    executionTimeMs: r.execution_time_ms,
    memoryKb: r.memory_kb,
    compileMessage: r.compile_message,
    runtimeMessage: r.runtime_message,
    clientRequestId: r.client_request_id
  };
}

function findById(id) {
  metrics.inc(metrics.K.ADMIN, 1);
  const r = getOjDb().prepare('SELECT * FROM oj_submissions WHERE id = ?').get(id);
  return rowToObj(r);
}

/** 幂等查找：同一 (user_id, client_request_id) 已存在 → 返回原提交 */
function findByIdempotent(userId, clientRequestId) {
  if (!clientRequestId) return null;
  const r = getOjDb().prepare(
    'SELECT * FROM oj_submissions WHERE user_id = ? AND client_request_id = ?'
  ).get(userId, clientRequestId);
  return rowToObj(r);
}

function listByUserAndContest(userId, contestId, { limit = 50 } = {}) {
  metrics.inc(metrics.K.SUBMISSION, 1);
  const rows = getOjDb().prepare(
    `SELECT s.*, p.title AS problem_title
     FROM oj_submissions s
     LEFT JOIN oj_problems p ON p.id = s.problem_id
     WHERE s.user_id = ? AND s.contest_id = ?
     ORDER BY s.server_received_at DESC LIMIT ?`
  ).all(userId, contestId, limit);
  return rows.map((r) => ({ ...rowToObj(r), problemTitle: r.problem_title || '' }));
}

/**
 * 创建提交（短事务 INSERT）。
 * @returns {{ok:boolean, submission?:object, code?:string}} code=DUPLICATE_REQUEST 表示幂等命中
 */
function insert({ id, contestId, problemId, userId, language, sourceCode, createdAt, serverReceivedAt, clientRequestId }) {
  const rid = id || crypto.randomUUID();
  const db = getOjDb();
  metrics.inc(metrics.K.SUBMISSION, 1);
  let existing = null;
  const tx = db.transaction(() => {
    // 幂等检查：同 (user_id, client_request_id) 已存在则不重复插入
    if (clientRequestId) {
      existing = db.prepare(
        'SELECT * FROM oj_submissions WHERE user_id = ? AND client_request_id = ?'
      ).get(userId, clientRequestId);
      if (existing) return;
    }
    db.prepare(
      `INSERT INTO oj_submissions
         (id, contest_id, problem_id, user_id, language, source_code, status, created_at,
          server_received_at, client_request_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      rid, contestId, problemId, userId, language, sourceCode, 'QUEUED',
      createdAt || new Date().toISOString(), serverReceivedAt, clientRequestId || null
    );
  });
  tx();

  if (existing) return { ok: true, duplicate: true, submission: rowToObj(existing) };
  return { ok: true, duplicate: false, submission: findById(rid) };
}

/** 状态推进（短事务 UPDATE）：status / verdict / 关键时间点 */
function updateStatus(id, patch) {
  const cur = findById(id);
  if (!cur) return null;
  const db = getOjDb();
  metrics.inc(metrics.K.SUBMISSION, 1);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE oj_submissions SET
         status=?, verdict=?, judge_started_at=?, judge_finished_at=?,
         execution_time_ms=?, memory_kb=?, compile_message=?, runtime_message=?
       WHERE id=?`
    ).run(
      patch.status ?? cur.status,
      patch.verdict !== undefined ? patch.verdict : cur.verdict,
      patch.judgeStartedAt ?? cur.judgeStartedAt,
      patch.judgeFinishedAt ?? cur.judgeFinishedAt,
      patch.executionTimeMs ?? cur.executionTimeMs,
      patch.memoryKb ?? cur.memoryKb,
      patch.compileMessage ?? cur.compileMessage,
      patch.runtimeMessage ?? cur.runtimeMessage,
      id
    );
  });
  tx();
  return findById(id);
}

/** 启动恢复：扫描 QUEUED/JUDGING，避免永久卡住 */
function listInFlight() {
  const rows = getOjDb().prepare(
    "SELECT * FROM oj_submissions WHERE status IN ('QUEUED','JUDGING') ORDER BY server_received_at"
  ).all();
  return rows.map(rowToObj);
}

function countInFlight(contestId) {
  const db = getOjDb();
  const row = contestId
    ? db.prepare("SELECT COUNT(*) AS n FROM oj_submissions WHERE contest_id = ? AND status IN ('QUEUED','JUDGING')").get(contestId)
    : db.prepare("SELECT COUNT(*) AS n FROM oj_submissions WHERE status IN ('QUEUED','JUDGING')").get();
  return row ? row.n : 0;
}

/** Admin 总览：正式 JudgeAdapter 主链路统计。 */
function overviewCounts() {
  const row = getOjDb().prepare(
    `SELECT COUNT(*) AS submissions,
            SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'JUDGING' THEN 1 ELSE 0 END) AS judging,
            SUM(CASE WHEN status = 'FINISHED' AND verdict = 'AC' THEN 1 ELSE 0 END) AS ac
     FROM oj_submissions`
  ).get() || {};
  return {
    submissions: Number(row.submissions) || 0,
    pending: Number(row.pending) || 0,
    judging: Number(row.judging) || 0,
    ac: Number(row.ac) || 0
  };
}

/** 限速检查：同用户 1 次/秒（滑动窗口）。返回是否放行 */
function rateLimitCheck(userId, now = Date.now()) {
  const cur = findLatestByUser(userId);
  if (!cur || !cur.serverReceivedAt) return { allowed: true };
  const last = new Date(cur.serverReceivedAt).getTime();
  return { allowed: now - last >= 1000, retryAfterMs: Math.max(0, 1000 - (now - last)) };
}

function findLatestByUser(userId) {
  const r = getOjDb().prepare(
    'SELECT * FROM oj_submissions WHERE user_id = ? ORDER BY server_received_at DESC LIMIT 1'
  ).get(userId);
  return rowToObj(r);
}

/** 统计某用户某题是否 AC（用于 solved 状态展示） */
function userSolved(userId, problemId) {
  const r = getOjDb().prepare(
    "SELECT COUNT(*) AS n FROM oj_submissions WHERE user_id=? AND problem_id=? AND status='FINISHED' AND verdict='AC'"
  ).get(userId, problemId);
  return (r && r.n > 0);
}

/* ================= Phase 5：Scoreboard / Admin 关系查询 ================= */

/**
 * 某比赛全部已终态提交（Scoreboard rebuild / recompute 用）。
 * @param {string} contestId
 * @param {object} opts { admin:boolean }
 * @returns {Array<object>} 行对象（含 user_id / problem_id / status / verdict / server_received_at / judge_started_at 等）
 */
function listFinishedByContest(contestId, opts = {}) {
  metrics.inc(metrics.K.SCOREBOARD, 1);
  const rows = getOjDb().prepare(
    "SELECT id, contest_id, problem_id, user_id, status, verdict, server_received_at, judge_started_at, judge_finished_at " +
    "FROM oj_submissions WHERE contest_id = ? AND status = 'FINISHED' ORDER BY server_received_at"
  ).all(contestId);
  return rows;
}

/**
 * 某用户在某比赛的全部终态提交（recomputeParticipant 单选手重算）。
 * @returns {Array<object>}
 */
function listFinishedByUserAndContest(userId, contestId) {
  metrics.inc(metrics.K.SCOREBOARD, 1);
  const rows = getOjDb().prepare(
    "SELECT id, contest_id, problem_id, user_id, status, verdict, server_received_at, judge_started_at, judge_finished_at " +
    "FROM oj_submissions WHERE contest_id = ? AND user_id = ? AND status = 'FINISHED' ORDER BY server_received_at"
  ).all(contestId, userId);
  return rows;
}

/**
 * Admin 分页查询（列表默认不含 source_code，避免一次 SELECT 全部提交 + 源码）。
 * @param {string} contestId
 * @param {object} f { page, pageSize, problemId, userId, language, verdict }
 * @returns {{total:number, rows:Array}}
 */
function listAdminByContest(contestId, f = {}) {
  const db = getOjDb();
  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 20));
  const where = ['s.contest_id = ?'];
  const params = [contestId];
  if (f.problemId) { where.push('s.problem_id = ?'); params.push(f.problemId); }
  if (f.userId) { where.push('s.user_id = ?'); params.push(f.userId); }
  if (f.language) { where.push('s.language = ?'); params.push(f.language); }
  if (f.verdict) { where.push('s.verdict = ?'); params.push(f.verdict); }
  const whereSql = where.join(' AND ');

  metrics.inc(metrics.K.ADMIN, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM oj_submissions s WHERE ${whereSql}`).get(...params).n;

  metrics.inc(metrics.K.ADMIN, 1);
  const rows = db.prepare(
    `SELECT s.id, s.contest_id, s.problem_id, s.user_id, s.language, s.status, s.verdict,
            s.server_received_at, s.judge_started_at, s.judge_finished_at,
            s.execution_time_ms, s.memory_kb,
            p.title AS problem_title, p.label AS problem_label, u.username AS username
     FROM oj_submissions s
     LEFT JOIN oj_problems p ON p.id = s.problem_id
     LEFT JOIN oj_users u ON u.id = s.user_id
     WHERE ${whereSql}
     ORDER BY s.server_received_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);

  return { total, page, pageSize, rows };
}

/** Admin 详情：带 source_code（列表不返回，详情单独返回） */
function findDetailById(id) {
  metrics.inc(metrics.K.ADMIN, 1);
  const r = getOjDb().prepare(
    `SELECT s.*, p.title AS problem_title, p.label AS problem_label, u.username AS username
     FROM oj_submissions s
     LEFT JOIN oj_problems p ON p.id = s.problem_id
     LEFT JOIN oj_users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).get(id);
  return r ? { ...rowToObj(r), problemTitle: r.problem_title, problemLabel: r.problem_label, username: r.username } : null;
}

module.exports = {
  findById, findByIdempotent, listByUserAndContest, insert, updateStatus,
  listInFlight, countInFlight, overviewCounts, rateLimitCheck, findLatestByUser, userSolved,
  listFinishedByContest, listFinishedByUserAndContest, listAdminByContest, findDetailById
};
