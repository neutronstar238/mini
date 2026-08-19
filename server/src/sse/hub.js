'use strict';
/**
 * SSE 连接池
 * - 通道（channel）分组：'page'（Web 页面）、'device:<id>'（评测机）、'admin'（管理监控）
 * - 定期心跳注释行保活；客户端断开自动清理
 */
const HEARTBEAT_MS = 15000;

class Hub {
  constructor() {
    /** @type {Map<string, Set<import('express').Response>>} */
    this.channels = new Map();
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
    res.on('close', () => this.leave(channel, res));
  }

  leave(channel, res) {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.channels.delete(channel);
  }

  /** 向指定通道发送事件 */
  emit(channel, event, data) {
    const set = this.channels.get(channel);
    if (!set) return 0;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let n = 0;
    for (const res of set) {
      try { res.write(payload); n++; } catch (_) { this.leave(channel, res); }
    }
    return n;
  }

  /** 广播到所有 Web 页面 */
  broadcastPage(event, data) {
    return this.emit('page', event, data) + this.emit('admin', event, data);
  }

  _heartbeat() {
    for (const [channel, set] of this.channels) {
      for (const res of set) {
        try { res.write(': hb\n\n'); } catch (_) { this.leave(channel, res); }
      }
    }
  }

  stats() {
    const out = {};
    for (const [ch, set] of this.channels) out[ch] = set.size;
    return out;
  }
}

module.exports = new Hub();
