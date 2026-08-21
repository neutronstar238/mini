'use strict';
/**
 * SSE 连接池
 * - 通道（channel）分组：'page'（Web 页面）、'device:<id>'（评测机）、'admin'（管理监控）、'contest:<id>'（比赛榜单）
 * - 定期心跳注释行保活；客户端断开自动清理
 *
 * Phase 5 可靠性加固（针对「僵尸 SSE 连接」）：
 *  - 写保护：res.write 失败（抛错/返回 false 且 write 回调报错）立即剔除，绝不阻塞事件循环。
 *  - 心跳兜底：每次心跳尝试写，失败即 leave；同时周期扫描把「无法响应背压」的连接剔除。
 *  - 背压保护：res.write 返回 false 时挂 once('error')，若写不出去则 leave，防止 res.write 永不回调卡死事件循环。
 */
const HEARTBEAT_MS = (require('../config').SSE_KEEPALIVE) || 25000;

/** 单连接最大存活时间（兜底，防极长连接累积僵尸） */
const MAX_CONN_LIFETIME_MS = 6 * 60 * 60 * 1000; // 6h

class Hub {
  constructor() {
    /** @type {Map<string, Set<import('express').Response>>} */
    this.channels = new Map();
    /** @type {WeakMap<import('express').Response, number>} 连接创建时间戳 */
    this._bornAt = new WeakMap();
    this._timer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this._timer.unref();
  }

  join(channel, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel).add(res);
    this._bornAt.set(res, Date.now());
    // close 时清理（正常断开）
    res.on('close', () => this.leave(channel, res));
    // 连接异常（客户端 RST / 强杀 / 网络断开）兜底清理
    res.on('error', () => this.leave(channel, res));
  }

  leave(channel, res) {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(res);
    this._bornAt.delete(res);
    if (set.size === 0) this.channels.delete(channel);
  }

  /** 单连接写一条，带背压/错误保护。失败返回 false（调用方应 leave）。 */
  _write(res, payload) {
    try {
      const ok = res.write(payload);
      if (ok === false) {
        // 背压：socket 缓冲区满。挂一个一次性 error，若写不出去（drain 永不触发且出错）则 leave。
        res.once('error', () => this._deadConnections.add(res));
        return true; // 背压本身不立即判定失败，由 error 兜底
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 待清理的背压连接（下一轮心跳剔除） */
  get _deadConnections() {
    if (!this.__dead) this.__dead = new Set();
    return this.__dead;
  }

  /** 向指定通道发送事件 */
  emit(channel, event, data) {
    const set = this.channels.get(channel);
    if (!set) return 0;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let n = 0;
    for (const res of set) {
      if (this._deadConnections.has(res)) { this.leave(channel, res); continue; }
      if (!this._write(res, payload)) this.leave(channel, res);
      else n++;
    }
    this._deadConnections.clear();
    return n;
  }

  /** 广播到所有 Web 页面 */
  broadcastPage(event, data) {
    return this.emit('page', event, data) + this.emit('admin', event, data);
  }

  _heartbeat() {
    const now = Date.now();
    for (const [channel, set] of this.channels) {
      for (const res of set) {
        // 兜底：超龄连接强制剔除（防僵尸累积）
        const born = this._bornAt.get(res) || 0;
        if (born && (now - born) > MAX_CONN_LIFETIME_MS) { this.leave(channel, res); continue; }
        if (this._deadConnections.has(res)) { this.leave(channel, res); continue; }
        if (!this._write(res, ': hb\n\n')) this.leave(channel, res);
      }
    }
    this._deadConnections.clear();
  }

  stats() {
    const out = {};
    for (const [ch, set] of this.channels) out[ch] = set.size;
    return out;
  }

  /** 当前 channel 连接总数（含所有通道） */
  totalConnections() {
    let n = 0;
    for (const set of this.channels.values()) n += set.size;
    return n;
  }
}

module.exports = new Hub();
