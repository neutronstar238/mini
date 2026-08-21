'use strict';
/**
 * 关系型 SQLite 驱动（Phase 4 OJ Core 主链路专用）
 *
 * 与既有 JSON-doc 文档模式（store/sqliteStore.js）并存：
 *  - 既有文档模式：远程 Worker 评测 / 榜单 / 管理端（保留不动）
 *  - 本关系模式：Contestant 正式提交主链路
 *
 * 仅 OJ Core 允许直接访问；Contestant/Admin/Judge Worker 一律经 OJ Core API。
 * WAL + 短事务；禁止在事务内等待 Judge/网络。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATION_FILE = path.join(__dirname, 'migrations', 'oj-main-path.sql');
const PHASE5_MIGRATION_FILE = path.join(__dirname, 'migrations', 'phase5-scoreboard.sql');

/** 幂等应用迁移脚本（可多次调用，CREATE TABLE IF NOT EXISTS） */
function applyMigration(db, file = MIGRATION_FILE) {
  const sql = fs.readFileSync(file, 'utf8');
  db.exec(sql);
}

/** 判断某列是否存在（供增量 ALTER 幂等保护） */
function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}

/**
 * Phase 5 增量迁移：仅当字段缺失时 ALTER，幂等可重复执行。
 */
function applyPhase5Migration(db) {
  // 比赛封榜时间预留字段
  if (!hasColumn(db, 'oj_contests', 'freeze_at')) {
    db.exec('ALTER TABLE oj_contests ADD COLUMN freeze_at TEXT;');
  }
}

/** 单例：创建（或复用）关系型主链路 DB */
function createOjDb(dataDir, file) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = file || path.join(dataDir, 'oj-main-path.db');
  const db = new Database(dbFile);
  // WAL + 可靠性 PRAGMA
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  applyMigration(db);
  applyPhase5Migration(db);
  return db;
}

let cached = null;

/** 进程内单例访问（与 store/db.js 的文档模式 db 区分） */
function getOjDb() {
  if (cached) return cached;
  const config = require('../config');
  cached = createOjDb(config.dataDir, config.ojDbFile);
  return cached;
}

module.exports = { createOjDb, getOjDb, applyMigration, MIGRATION_FILE };
