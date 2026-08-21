-- ============================================================
-- Phase 5 · Scoreboard / SSE / Cache Lease / Minimal Admin
-- 增量迁移（幂等，可重复执行）
--  - 为比赛增加 freeze_at（封榜预留字段，当前仅作 interface，不启用公开冻结投影）
-- ============================================================

-- 比赛封榜时间（可选）：若非空且未结束，普通选手 Scoreboard 隐藏其后的新结果，Admin 仍可见真实。
ALTER TABLE oj_contests ADD COLUMN freeze_at TEXT;
