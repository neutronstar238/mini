'use strict';
/**
 * 全链路审计：记录所有关键事件，供管理端追溯
 * 事件：register / approve / suspend / revoke / task_dispatch / heartbeat /
 *       report / spotcheck / lease_expired / anomaly / rejudge / verify_failed / login
 */
const db = require('../store/db');

function log(type, detail) {
  const e = db.audit.insert({ type, detail, at: new Date().toISOString() });
  // 控制审计表规模（环形）
  const all = db.audit.all();
  while (all.length > 2000) db.audit.remove(all[0].id);
  return e;
}

function recent(limit = 100) {
  return db.audit.all()
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

module.exports = { log, recent };
