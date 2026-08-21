'use strict';
/**
 * 内存级滑动窗口限流器（Phase 5）
 *
 * 用途：
 *  - Scoreboard Full Snapshot：较严格（防止恶意高频 full query）
 *  - SSE：放宽（正常实时推送不应被限流）
 *  - 身份以 user/session 为主键，IP 仅作辅助维度（不可把 IP 当用户身份）。
 *
 * 行为：命中阈值 → { allowed:false, retryAfterMs }；未命中 → allowed:true。
 * 纯内存实现，定期清理过期条目防内存泄漏。
 */
class SlidingWindowRateLimiter {
  /**
   * @param {object} opts { limit:number, windowMs:number }
   */
  constructor(opts = {}) {
    this.limit = opts.limit || 10;
    this.windowMs = opts.windowMs || 10000;
    /** key -> number[] (时间戳戳，升序) */
    this.buckets = new Map();
    // 定期清理过期窗口，防内存泄漏
    this._timer = setInterval(() => this._sweep(), Math.max(30000, this.windowMs * 2));
    if (this._timer.unref) this._timer.unref();
  }

  _sweep() {
    const now = Date.now();
    for (const [k, arr] of this.buckets) {
      while (arr.length && arr[0] <= now - this.windowMs) arr.shift();
      if (arr.length === 0) this.buckets.delete(k);
    }
  }

  /**
   * 尝试放行一次请求。
   * @param {string} key 主键（user id / session）
   * @param {string} auxKey 辅助键（IP，可选）
   * @returns {{allowed:boolean, retryAfterMs:number}}
   */
  check(key, auxKey = '') {
    const now = Date.now();
    // 组合 key：优先主键；auxKey 与主键叠加，避免多 IP 绕过
    const realKey = auxKey ? `${key}::${auxKey}` : key;
    const arr = this.buckets.get(realKey) || [];
    // 移除窗口外
    while (arr.length && arr[0] <= now - this.windowMs) arr.shift();
    if (arr.length >= this.limit) {
      const retryAfterMs = Math.max(0, (arr[0] + this.windowMs) - now);
      return { allowed: false, retryAfterMs };
    }
    arr.push(now);
    this.buckets.set(realKey, arr);
    return { allowed: true, retryAfterMs: 0 };
  }
}

module.exports = SlidingWindowRateLimiter;
