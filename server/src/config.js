'use strict';
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// 应用入口模式：contest（选手端 OJ Core）/ admin（管理端）/ all（本地联调双入口）
const ENTRY = process.env.APP_ENTRY || 'all';

// 各入口独立监听端口（避开服务器已占用的 3000）
const ENTRY_PORTS = { contest: 3001, admin: 3002 };

const config = {
  entry: ENTRY,
  port: ENTRY === 'all'
    ? Number(process.env.PORT || 3000)
    : Number(process.env.PORT || ENTRY_PORTS[ENTRY] || 3001),
  host: process.env.HOST || '0.0.0.0',

  // 双入口域名（部署时经 Nginx 按 ServerName 分发并传递真实 Host；
  // 占位默认值仅用于本地联调，实际部署须经环境变量 DOMAIN_CONTEST/DOMAIN_ADMIN 注入）
  domainContest: process.env.DOMAIN_CONTEST || 'contest.example.com',
  domainAdmin: process.env.DOMAIN_ADMIN || 'admin.example.com',
  prefixFallback: true,

  // JWT / HMAC
  jwtSecret: process.env.JWT_SECRET || 'mini-oj-jwt-secret-change-me',
  jwtExpires: '24h',
  hmacSecret: process.env.HMAC_SECRET || 'mini-oj-hmac-secret-change-me',
  // :3002 → :3001 内部管理 API 共享密钥
  internalApiSecret: process.env.INTERNAL_API_SECRET || 'mini-oj-internal-secret-change-me',
  // :3002 访问 :3001 内部 API 的基础地址（admin 入口专用）
  coreBaseUrl: process.env.CORE_BASE_URL || 'http://127.0.0.1:3001',

  dataDir: DATA_DIR,
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, 'mini-oj.db'),

  /* ================= 时间参数（指导文档 §19，全部集中于此） ================= */
  WORKER_HEARTBEAT_INTERVAL: 15000,
  WORKER_HEARTBEAT_JITTER: 3000,
  WORKER_SUSPECT_AFTER: 30000,
  WORKER_OFFLINE_AFTER: 45000,

  SCHEDULER_FALLBACK_SCAN: 10000,   // pending fallback scan：10 秒
  LEASE_SWEEP_INTERVAL: 5000,       // lease expiry sweep：5 秒

  CONTESTANT_BATCH_INTERVAL: 10000, // 选手 SSE batch window：10 秒
  CONTESTANT_FALLBACK_POLL_MIN: 10000,
  CONTESTANT_FALLBACK_POLL_JITTER: 3000,

  SSE_KEEPALIVE: 25000,

  PROGRESS_MIN_INTERVAL: 5000,      // Worker progress 最小间隔
  PROGRESS_MIN_PERCENT_DELTA: 10,   // progress 变化阈值

  /* ================= 租约 / 尝试 ================= */
  leaseTtlMs: 120 * 1000,
  maxAttempt: 3,

  /* ================= 提交 / 同步限流 ================= */
  languages: ['cpp', 'python'],
  maxCodeLength: 64 * 1024,
  // 选手同步 API 最低间隔（server rate limit）
  SYNC_MIN_INTERVAL: 10000,
  // 同一 user 的 SSE 连接数上限（P1 简化）
  MAX_SSE_PER_USER: 5
};

module.exports = config;
