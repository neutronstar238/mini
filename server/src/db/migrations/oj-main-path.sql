-- ============================================================
-- Phase 4 · OJ Core Main Path MVP —— 关系型主链路 schema
--
-- 与既有 JSON-doc 文档集合模式（sqliteStore.js）并存过渡：
--   既有文档模式 -> 远程 Worker 评测 / 榜单 / 管理端（保留不动）
--   本关系模式   -> Contestant 正式提交主链路（Phase 4 主线）
--
-- 唯一数据库：SQLite（WAL）。只有 OJ Core 允许直接访问。
-- 幂等约束：UNIQUE(user_id, client_request_id) 防网络重试重复提交。
-- 短事务原则：INSERT / UPDATE 各自独立短事务，禁止事务内等待 Judge/网络。
-- ============================================================

-- ---------- 基础 PRAGMA（由 sqlite.js 驱动统一执行，此处注释留档） ----------
-- PRAGMA journal_mode=WAL;
-- PRAGMA synchronous=NORMAL;
-- PRAGMA busy_timeout=5000;
-- PRAGMA foreign_keys=ON;

-- ---------- 用户 ----------
CREATE TABLE IF NOT EXISTS oj_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- ---------- 比赛 ----------
CREATE TABLE IF NOT EXISTS oj_contests (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at    TEXT,            -- ISO 8601（权威开始时间）
  end_at      TEXT,            -- ISO 8601（可选结束时间）
  status      TEXT NOT NULL DEFAULT 'upcoming', -- upcoming | ongoing | ended
  created_at  TEXT NOT NULL
);

-- ---------- 题目 ----------
CREATE TABLE IF NOT EXISTS oj_problems (
  id             TEXT PRIMARY KEY,
  contest_id     TEXT NOT NULL REFERENCES oj_contests(id),
  label          TEXT NOT NULL DEFAULT '',   -- A / B / C ...
  title          TEXT NOT NULL,
  statement      TEXT NOT NULL DEFAULT '',
  time_limit_ms  INTEGER NOT NULL DEFAULT 1000,
  memory_limit_mb INTEGER NOT NULL DEFAULT 256,
  testcases      TEXT NOT NULL DEFAULT '[]', -- JSON: [{input, answer}] 隐藏测试（仅服务器）
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oj_problems_contest ON oj_problems(contest_id);

-- ---------- 题目公开样例 ----------
CREATE TABLE IF NOT EXISTS oj_problem_samples (
  id             TEXT PRIMARY KEY,
  problem_id     TEXT NOT NULL REFERENCES oj_problems(id),
  sample_index   INTEGER NOT NULL DEFAULT 0,
  input          TEXT NOT NULL DEFAULT '',
  expected_output TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_oj_samples_problem ON oj_problem_samples(problem_id);

-- ---------- 提交 ----------
CREATE TABLE IF NOT EXISTS oj_submissions (
  id                  TEXT PRIMARY KEY,
  contest_id          TEXT NOT NULL REFERENCES oj_contests(id),
  problem_id          TEXT NOT NULL REFERENCES oj_problems(id),
  user_id             TEXT NOT NULL REFERENCES oj_users(id),
  language            TEXT NOT NULL,             -- c11 | cpp11 | python3
  source_code         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'QUEUED',   -- QUEUED | JUDGING | FINISHED
  verdict             TEXT,                             -- null | AC | WA | TLE | MLE | RE | CE | SYSTEM_ERROR
  created_at          TEXT NOT NULL,                    -- 客户端点击时刻（仅日志）
  server_received_at  TEXT NOT NULL,                    -- 权威提交时间（服务器 now）
  judge_started_at    TEXT,
  judge_finished_at   TEXT,
  execution_time_ms   INTEGER,
  memory_kb           INTEGER,
  compile_message     TEXT,
  runtime_message     TEXT,
  client_request_id   TEXT,                             -- 幂等键
  rate_bucket_at      TEXT,                             -- 限速滑动窗口标记
  UNIQUE(user_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_oj_submissions_user   ON oj_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_oj_submissions_contest ON oj_submissions(contest_id);
CREATE INDEX IF NOT EXISTS idx_oj_submissions_problem ON oj_submissions(problem_id);
CREATE INDEX IF NOT EXISTS idx_oj_submissions_status ON oj_submissions(status);
