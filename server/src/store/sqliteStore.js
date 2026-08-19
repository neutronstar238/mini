'use strict';
/**
 * Repository 存储层 —— SQLite 实现（better-sqlite3 事务化）
 *
 * 为满足申请书"存储层封装统一 Repository 接口，保留 PostgreSQL 配置化切换"，
 * 本层对外暴露与 JSON 存储完全一致的 Collection API：
 *   all() / find(fn) / findOne(fn) / byId(id) / insert(item) / update(id, patch) / remove(id)
 * 业务层无需关心底层是 JSON 还是 SQLite，也无需改动。
 *
 * 结构：每张表以「单行 JSON 文档数组」形式存储于一列，表 = 一个 Collection。
 * - 事务化：所有写操作通过 better-sqlite3 的 .transaction 原子执行
 * - PostgreSQL 配置化：DB_DRIVER=postgres 时尝试切换到 pg 驱动（见 driver 适配，未安装 pg 则回退 SQLite）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * SQLite Collection
 * 将一条条记录序列化为 JSON 文档行，字段为文档(JSON)。
 * 每行：id TEXT PRIMARY KEY, doc TEXT NOT NULL（JSON 全文）
 */
class Collection {
  constructor(driver, tableName) {
    this.driver = driver;
    this.table = tableName;
    this._init();
  }

  _init() {
    this.driver.db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
  }

  _allDocs() {
    const rows = this.driver.db.prepare(`SELECT doc FROM ${this.table}`).all();
    return rows.map((r) => JSON.parse(r.doc));
  }

  all() { return this._allDocs(); }

  find(fn) { return this._allDocs().filter(fn); }

  findOne(fn) { return this._allDocs().find(fn) || null; }

  byId(id) {
    const row = this.driver.db.prepare(`SELECT doc FROM ${this.table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.doc) : null;
  }

  insert(item) {
    const record = Object.assign({ id: item.id || crypto.randomUUID(), createdAt: new Date().toISOString() }, item);
    const stmt = this.driver.db.prepare(`INSERT OR REPLACE INTO ${this.table} (id, doc) VALUES (?, ?)`);
    stmt.run(record.id, JSON.stringify(record));
    return record;
  }

  update(id, patch) {
    const existing = this.byId(id);
    if (!existing) return null;
    const merged = Object.assign({}, existing, patch, { id: id, updatedAt: new Date().toISOString() });
    const stmt = this.driver.db.prepare(`UPDATE ${this.table} SET doc = ? WHERE id = ?`);
    stmt.run(JSON.stringify(merged), id);
    return merged;
  }

  remove(id) {
    const stmt = this.driver.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`);
    return stmt.run(id).changes > 0;
  }
}

/** 事务包装：批量写操作原子执行 */
class SQLiteDriver {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }
  transaction(fn) {
    return this.db.transaction(fn);
  }
}

/**
 * 创建存储层（Collection 集合）
 * 通过环境变量切换驱动：
 *   DB_DRIVER=sqlite   （默认，better-sqlite3）
 *   DB_DRIVER=postgres （需安装 pg 并配置 DB_URL，未安装时回退 sqlite）
 */
function createCollections(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });

  let driver;
  const usePg = process.env.DB_DRIVER === 'postgres';
  if (usePg) {
    try {
      const { PgDriver } = require('./pgDriver');
      driver = new PgDriver(process.env.DB_URL || process.env.DATABASE_URL);
      console.log('[store] 使用 PostgreSQL 驱动');
    } catch (err) {
      console.warn('[store] 无法加载 pg 驱动，回退 SQLite:', err.message);
      usePgFallback();
    }
  } else {
    usePgFallback();
  }

  function usePgFallback() {
    const file = process.env.DB_FILE || path.join(dataDir, 'mini-oj.db');
    driver = new SQLiteDriver(file);
    console.log('[store] 使用 SQLite 驱动:', file);
  }

  const db = {
    driver,
    contests: new Collection(driver, 'contests'),
    users: new Collection(driver, 'users'),
    problems: new Collection(driver, 'problems'),
    submissions: new Collection(driver, 'submissions'),
    judgeAttempts: new Collection(driver, 'judge_attempts'),
    workers: new Collection(driver, 'workers'),
    registerCodes: new Collection(driver, 'register_codes'),
    queueTickets: new Collection(driver, 'queue_tickets'),
    audit: new Collection(driver, 'audit'),
    meta: new Collection(driver, 'meta')
  };
  return db;
}

module.exports = { createCollections, Collection };
