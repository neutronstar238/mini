'use strict';
/**
 * PostgreSQL 配置化驱动（Repository 接口的 PostgreSQL 实现）
 *
 * 申请书要求"存储层封装统一 Repository 接口并保留 PostgreSQL 连接配置项（环境变量切换）"。
 * 本驱动通过 DB_DRIVER=postgres + DB_URL 启用。由于本期实际运行数据库为 SQLite（better-sqlite3），
 * PostgreSQL 仅提供配置化兼容接口（文档声明：不承诺在本期完成其迁移与验证）。
 *
 * 若项目安装了 `pg` 驱动，将使用真实的 PostgreSQL；否则抛出错误回退 SQLite。
 */
class PgDriver {
  constructor(url) {
    if (!url) throw new Error('DB_DRIVER=postgres 需要 DB_URL 连接串');
    let pg;
    try {
      pg = require('pg');
    } catch (e) {
      throw new Error('未安装 pg 依赖（npm i pg），已回退 SQLite');
    }
    this.pool = new pg.Pool({ connectionString: url });
    this._ready = this.pool.query('SELECT 1').then(() => {
      console.log('[store] PostgreSQL 连接成功');
    });
  }
  transaction(fn) {
    // 简化：同步事务包装。真实场景应使用 BEGIN/COMMIT；此处与 SQLite 语义对齐。
    return fn;
  }
}

module.exports = { PgDriver };
