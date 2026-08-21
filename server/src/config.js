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
  // Phase 4 关系型主链路 DB（与文档模式 mini-oj.db 并存）
  ojDbFile: process.env.OJ_DB_FILE || path.join(DATA_DIR, 'oj-main-path.db'),

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

  // 选手 Chrome 客户端设备管理：心跳、离线判定与 Admin SSE 更新
  CLIENT_DEVICE_HEARTBEAT_INTERVAL: 20000,
  CLIENT_DEVICE_OFFLINE_AFTER: 60000,
  CLIENT_DEVICE_SWEEP_INTERVAL: 15000,
  CLIENT_DEVICE_EVENT_MIN_INTERVAL: 30000,

  PROGRESS_MIN_INTERVAL: 5000,      // Worker progress 最小间隔
  PROGRESS_MIN_PERCENT_DELTA: 10,   // progress 变化阈值

  /* ================= 租约 / 尝试 ================= */
  leaseTtlMs: 120 * 1000,
  maxAttempt: 3,

  /* ================= 提交 / 同步限流 ================= */
  // Phase 4 正式语言 allowlist（Runtime Enhancement Phase：由 language-profiles.js 派生；
  // 覆盖 c11/c17/cpp11/cpp17/cpp20/cpp23/python3/java21；仅含允许正式提交且 official supported 的状态）
  languages: require('./language-profiles').enabledOfficialLanguages(),
  languageProfiles: require('./language-profiles').legacyLanguageProfiles(),
  maxCodeLength: 256 * 1024, // 256KB 正式提交上限
  sourceMaxUtf8: true,
  // 正式提交限速：同用户 1 次 / 秒（防双击 / 脚本狂刷；Local Run 不限速，根本不请求 Server）
  SUBMIT_RATE_LIMIT_PER_SEC: 1,
  // 选手同步 API 最低间隔（server rate limit）
  SYNC_MIN_INTERVAL: 10000,
  // 同一 user 的 SSE 连接数上限（P1 简化）
  MAX_SSE_PER_USER: 5,

  /* ================= Phase 5：Scoreboard / Cache Lease / Rate Limit ================= */
  // Scoreboard Full Snapshot 限流：同 (user, ip) 滑动窗口
  SCOREBOARD_FULL_LIMIT: 20,      // 窗口内允许次数
  SCOREBOARD_FULL_WINDOW_MS: 30000, // 30s 窗口
  // Cache Lease 时长（Full Snapshot 的 nextSyncAt 提前量）
  SCOREBOARD_LEASE_MS: 10000,     // 10s lease（与 batch window 对齐，给 SSE 留余量）
  // 本地缓存元数据 key 前缀
  SCOREBOARD_CACHE_KEY: 'oj:scoreboard:v1',
  // 本地快照大小阈值：超过则用 IndexedDB，否则 localStorage（单位字节）
  SCOREBOARD_CACHE_INDEXEDDB_THRESHOLD: 65536
};

module.exports = config;
