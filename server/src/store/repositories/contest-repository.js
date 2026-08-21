'use strict';
/**
 * ContestRepository —— 关系型 contests 表（Phase 4 主链路）
 * 仅 OJ Core 直连 SQLite。
 */
const crypto = require('crypto');
const { getOjDb } = require('../../db/sqlite');
const metrics = require('../db-metrics');

function findById(id) {
  metrics.inc(metrics.K.SCOREBOARD, 1);
  return getOjDb().prepare('SELECT * FROM oj_contests WHERE id = ?').get(id) || null;
}

function insert({ id, title, description = '', startAt, endAt = null, status = 'upcoming' }) {
  const rid = id || crypto.randomUUID();
  const createdAt = new Date().toISOString();
  getOjDb().prepare(
    'INSERT INTO oj_contests (id, title, description, start_at, end_at, status, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(rid, title, description, startAt || createdAt, endAt, status, createdAt);
  return findById(rid);
}

function update(id, patch) {
  const cur = findById(id);
  if (!cur) return null;
  getOjDb().prepare(
    `UPDATE oj_contests SET title=?, description=?, start_at=?, end_at=?, status=? WHERE id=?`
  ).run(
    patch.title ?? cur.title,
    patch.description ?? cur.description,
    patch.startAt ?? cur.start_at,
    patch.endAt ?? cur.end_at,
    patch.status ?? cur.status,
    id
  );
  return findById(id);
}

/** 用文档模式种子比赛补齐关系库（并存过渡） */
function ensureContest(docContest) {
  if (!docContest) return null;
  let c = findById(docContest.id);
  if (c) return c;
  return insert({
    id: docContest.id,
    title: docContest.title,
    description: docContest.description || '',
    startAt: docContest.startTimeMs ? new Date(docContest.startTimeMs).toISOString() : null,
    status: docContest.status || 'ongoing'
  });
}

module.exports = { findById, insert, update, ensureContest };
