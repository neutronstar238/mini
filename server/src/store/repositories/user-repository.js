'use strict';
/**
 * UserRepository —— 关系型 users 表（Phase 4 主链路）
 * 仅 OJ Core 直连 SQLite。认证 + 提交校验用。
 */
const { getOjDb } = require('../../db/sqlite');
const metrics = require('../db-metrics');

function findById(id) {
  metrics.inc(metrics.K.SCOREBOARD, 1);
  return getOjDb().prepare('SELECT * FROM oj_users WHERE id = ?').get(id) || null;
}

function findByUsername(username) {
  metrics.inc(metrics.K.SUBMISSION, 1);
  return getOjDb().prepare('SELECT * FROM oj_users WHERE username = ?').get(username) || null;
}

function insert({ id, username, passwordHash, role = 'user', banned = 0 }) {
  const createdAt = new Date().toISOString();
  getOjDb().prepare(
    'INSERT INTO oj_users (id, username, password_hash, role, banned, created_at) VALUES (?,?,?,?,?,?)'
  ).run(id, username, passwordHash, role, banned ? 1 : 0, createdAt);
  return findById(id);
}

/** 保证比赛/提交涉及的用户存在；若文档模式种子已有但关系库没有，按需补齐 */
function ensureUser(docUser) {
  if (!docUser) return null;
  let u = findById(docUser.id);
  if (u) return u;
  return insert({
    id: docUser.id,
    username: docUser.username,
    passwordHash: docUser.passwordHash,
    role: docUser.role || 'user',
    banned: docUser.banned ? 1 : 0
  });
}

/** 用户基础查询（Admin：username 模糊 / 分页） */
function listUsers({ username, page = 1, pageSize = 50 } = {}) {
  const db = getOjDb();
  const p = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const where = [];
  const params = [];
  if (username) { where.push('username LIKE ?'); params.push(`%${username}%`); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  metrics.inc(metrics.K.ADMIN, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM oj_users ${whereSql}`).get(...params).n;
  metrics.inc(metrics.K.ADMIN, 1);
  // oj_users 无 nickname 列（nickname 仅文档模式有）；用户名即展示名
  const rows = db.prepare(
    `SELECT id, username, role, banned, created_at FROM oj_users ${whereSql} ORDER BY created_at LIMIT ? OFFSET ?`
  ).all(...params, size, (p - 1) * size);
  return { total, page: p, pageSize: size, rows };
}

module.exports = { findById, findByUsername, insert, ensureUser, listUsers };
