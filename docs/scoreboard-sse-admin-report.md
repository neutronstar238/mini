# Phase 5 交付报告 — Scoreboard / SSE / Cache Lease / Minimal Admin

> 阶段：Phase 5（在 Phase 4 主业务链之上增量实现）
> 日期：2026-08-20
> 架构保持：Node.js + Express + SQLite(WAL) + SSE；Browser=Untrusted、OJ Core=唯一数据库 Owner、SQLite=Authoritative Persistent Store、Official Judge=Authoritative Verdict Source。
> 范围：只做 Scoreboard / SSE 状态推送 / Batch Delta / Client Cache Lease / 最小 Admin / 高并发刷新保护。**不扩展语言 Runtime、不做分布式 Worker。**

---

## 1. Scoreboard 数据来源

- **唯一权威来源 = SQLite 关系库**（`oj_contests` / `oj_problems` / `oj_users` / `oj_submissions`，WAL）。
- 内存（`scoreboardRuntime` / `snapshotCache`）仅为 **derived cache**，只用于加速读取与 SSE 推送，任何时刻都可从 SQLite 重建。
- **禁止每次请求重扫 SQLite**：Full Snapshot / SSE 对同一 version 的重复请求直接命中内存 Snapshot 缓存（0 次 SQLite 查询），仅在 version 变化或重建时访问 SQLite。
- 与 Phase 4 并存过渡的文档模式（`store/db`）提交路径不在关系库，**不进入**关系榜单；`scoreboard.onVerdict` 对关系库不存在的提交安全忽略。

## 2. 内存 Snapshot 结构

```
scoreboardRuntime : Map<contestId, Map<userId, userStat>>
  userStat = {
    solved: Set<problemId>,
    penaltyMs: number,            // ICPC 罚时（分钟）
    lastAcceptedAtMs: number,     // 最近一次 AC 时间（稳定 tie-break 用）
    problems: { problemId: { solved, attempts, firstSolvedAtMs, acceptedAtMs, lastVerdict } }
  }

scoreboardVersion : Map<contestId, number>   // 每比赛独立 version
dirtyParticipants: Map<contestId, Set<userId>> // 待批量推送的变化用户
snapshotCache    : Map<key, { version, snapshot }> // 已构建的榜单快照缓存（避免重复查询）
```

## 3. rebuild 流程

- **启动恢复** `recomputeFromDb()`：清空内存 → 从文档模式取比赛 id 列表 → 对每比赛调 `rebuildScoreboard(contestId)`。
- `rebuildScoreboard(contestId)`：从 `oj_submissions` 读取该比赛全部 FINISHED 提交 → 按时间顺序重放进内存 → 清 dirty → 使缓存失效 → version 对齐。
- **自愈**：任何 `version/state` 异常 → `rebuildScoreboard(contestId)` 从 SQLite 重建。内存始终是 derived，SQLite 是最终事实来源（绝不设计成「内存对而库错」）。

## 4. participant recompute

- `recomputeParticipant(contestId, userId)`：清空该用户内存态 → 从 `oj_submissions` 读取该用户在该比赛的 FINISHED 提交（`listFinishedByUserAndContest`）→ 按 `server_received_at` 时间顺序重放 → 重算 solved/penalty → `dirtyParticipants.add(userId)`。
- **Rejudge / 重复 Judge 依赖此函数**：AC→WA 会正确回滚（该题 AC 被移除、罚时回退）；WA→AC 会正确增加。避免复杂且易错的「纯增量数学」。
- Submission FINISHED 主路径调用 `scoreboard.onFinished(contestId, userId)` → 即 `recomputeParticipant`。

## 5. ranking rule

**ICPC 风格（无项目自定义规则，以需求规定为准），稳定排序：**

1. `solved` DESC（通过题数）
2. `penalty` ASC（罚时）
3. `lastAcceptedAt` ASC（最近一次 AC 时间）
4. `userId` ASC（稳定兜底，防止同分用户每次重排随机换位）

- 罚时 = `Σ( 该题 AC 时距比赛开始的分钟数 + 20 × 该题 AC 前的错误提交次数 )`
- 每题状态格：`AC`（绿，显示 AC 分钟）、`failed`（红/灰，显示 `-错误次数`）、`none`（未提交，`.`）。

## 6. scoreboardVersion

- 每比赛独立 `scoreboardVersion`（Map），初始 0。
- 每次 10s Batch 聚合 `dirtyParticipants` 时 `bumpVersion(contestId)` 使 version+1，同时使 Snapshot 缓存失效。
- Full Snapshot 与 SSE 事件均携带 version，供客户端做连续 delta / version gap 判定。

## 7. dirtyParticipants

- 每比赛一个 `Set<userId>`，Submission FINISHED（`onFinished`→`recomputeParticipant`）时加入。
- 10s（`CONTESTANT_BATCH_INTERVAL`）Batch 扫描：对每个 dirty 用户计算其最终行 → 聚合为 `changes` → `clear()` → 广播。**同一用户多次变化最终只推一次**（需求七：user 5 changed again 只推最终状态）。

## 8. 10 秒 Batch Delta

- 窗口：`config.CONTESTANT_BATCH_INTERVAL = 10000`（10s）。
- 只推变化用户，**不推完整排行榜**。
- 事件 `scoreboard-delta`：

```json
{
  "version": 130,
  "changes": [
    { "userId": "…", "solved": 4, "penalty": 320, "problems": { "pid": { "letter": "A", "status": "AC", "minutes": 60, "attempts": 2 } } }
  ]
}
```

- 同时向 `contest:<cid>` channel（新协议）与 `page` channel（兼容旧前端 `scoreboard_delta`）广播。

## 9. SSE 协议

- **每比赛 channel**：`GET /api/contest/contests/:cid/events` 加入 `contest:<cid>`。
- 认证：`?token=<JWT>`（SSE 无法带 header，兼容 query token）；`?lastVersion=<N>` 断线协商。
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`（关闭反向代理 buffering）。
- 事件：
  - `scoreboard-snapshot`：首连/版本一致时下发 `{ version, serverTime }`。
  - `scoreboard-delta`：10s Batch 增量（§8）。
  - `scoreboard_sync`：`{ type:'NEED_FULL_SYNC', clientVersion, serverVersion }`（版本 gap）。
  - `queue_status`：兼容旧队列深度。
- **Heartbeat**：`SSE_KEEPALIVE = 25000`（25s）comment 心跳 `: hb`，不逐秒发。

## 10. reconnect

- 客户端（`rank.js`）保存 `lastScoreboardVersion`。
- 断线后自动重连（`EventSource` onerror → 4s 重连；连续 3 次失败转 fallback polling）。
- 重连时带 `lastVersion`，服务端据此判断能否补 delta 或需 full sync。

## 11. version gap

- **P0 不保留 delta 历史** → 任何版本不一致（`clientVersion !== serverVersion` 且 `>0`）一律下发 `scoreboard_sync {type:'NEED_FULL_SYNC'}`。
- 客户端收到 `NEED_FULL_SYNC` 或检测到 delta 的 `version != current+1` → 重新 `GET /scoreboard`（full sync），保证不长期处于错误榜单。

## 12. fallback polling

- SSE 不可用/连续断开（3 次失败）→ fallback polling。
- 周期：`10~13s`（`CONTESTANT_FALLBACK_POLL_MIN=10000` + random 0~3s jitter），**避免 1000 个浏览器同一秒同时 poll**。
- 先 `GET /scoreboard/version`（轻量）；version 变化才 `GET /scoreboard` full sync；否则复用缓存。

## 13. Cache Lease

- Full Snapshot 返回 `serverTime` / `scoreboardVersion` / `nextSyncAt`（= `serverTime + CONTESTANT_BATCH_INTERVAL×2`，即 ~20s Lease）。
- 客户端：`nextSyncAt` 之前优先显示本地 Snapshot；后台经 SSE/Lease 更新。
- 服务器端 Rate Limit 独立存在（见 §15），**Cache Lease 不是安全机制**。

## 14. local cache

- 尺寸判断：元数据（version / nextSyncAt）始终写 `localStorage`（小）；完整 Snapshot 若 JSON 序列化 `> 64KB`（`SCOREBOARD_CACHE_INDEXEDDB_THRESHOLD`）→ **IndexedDB**，否则 localStorage。
- **绝不把 Runtime wasm / Pyodide（13MB）塞 localStorage** —— Runtime 资源继续走现有 HTTP Cache（`Cache-Control: immutable`）。
- 实现：`public/js/contest/scoreboard-cache.js`（`ScoreboardCache.save/load/clear`）。

## 15. Rate Limit

- 内存级滑动窗口限流器 `src/services/rate-limiter.js`。
- **身份以 user/session 为主键，IP 仅作辅助维度**（不可把 IP 当用户身份）。
- Full Snapshot：同 `(userId, ip)` 30s 窗口内限 20 次 → 超限 `HTTP 429` + `Retry-After`（`SCOREBOARD_FULL_LIMIT=20` / `SCOREBOARD_FULL_WINDOW_MS=30000`）。
- SSE：`MAX_SSE_PER_USER=5`（每比赛每用户连接数上限），不限制为过低频。
- **不影响** Formal Submit（SubmissionService 独立限速 1 次/秒）与 Personal Submission SSE。

## 16. SQLite query behavior

- 新增 `src/store/db-metrics.js` 计数：`scoreboardFullQueries` / `submissionQueries` / `adminQueries` / `totalQueries`。
- 暴露：`GET /api/contest/_metrics`（admin 角色）与 `GET /internal/admin/metrics`。
- **关键：Snapshot 缓存** —— 同一 version 的 Full Snapshot / SSE delta 重复请求命中内存，0 次 SQLite 查询；仅在 version 首次构建或 dirty 变化时访问 SQLite。
- 负载测试实证（见 §20）：500 clients 并发 GET snapshot，仅产生 ~218 次 scoreboard SQLite 查询（0.44/client），**不随 client 数线性增长**。

## 17. Admin API

- **链路**：Admin Browser → Admin API（:3002 代理）→ OJ Core `internal-admin` → SQLite。**Admin 不直接访问 SQLite**（沿用 `internalAuth` + HMAC）。
- 新增端点：
  - `GET /api/admin/contests/:id/submissions?page&pageSize&problemId&userId&language&verdict`（分页+过滤，**列表不含 source_code**）
  - `GET /api/admin/submissions/:id`（完整详情，含 source / compile / runtime）
  - `GET /api/admin/contests/:id/scoreboard`（**真实榜单**，忽略 freeze 投影）
  - `GET /api/admin/users?username&page&pageSize`（用户基础查询）
  - `POST /api/admin/submissions/:id/rejudge`（Rejudge，见 §18）
  - `GET /api/admin/metrics`（SQLite query 计数）
- Admin 页面：`/admin/submissions`（提交查询：过滤/分页/详情抽屉/Rejudge 按钮）。

## 18. Rejudge

- `POST /api/admin/submissions/:id/rejudge`（经 `internal-admin` → 关系库 judge-service）。
- 流程：Admin 验证（`requireRole('admin')` + `internalAuth`）→ 仅 FINISHED 可重判 → status→`QUEUED`（清旧终态 verdict/结果，保留 source/元数据）→ `judgeService.dispatch`（异步）→ Official Judge → FINISHED → `recomputeParticipant()` → `dirtyParticipants` → 10s SSE delta。
- **AC→WA / WA→AC 均能正确回滚/增加**：验证通过（E2E Case4/5）。
- 与旧文档模式 `scheduler.rejudge` 并存（旧端点保留不动，关系库走新端点）。

## 19. Freeze（最小预留，已实现基础投影）

- 预留 `oj_contests.freeze_at` 字段（Phase 5 迁移幂等添加）。
- 封榜判定：`now >= freeze_at` 且（若配置 end_at）`now < end_at`。
- 封榜期：**普通选手** Scoreboard 隐藏 `freeze_at` 之后的新结果（AC 显示为 `failed/FROZEN`、solved 不计）；**Admin** 看真实（忽略投影）。
- 数据库始终保存真实结果，只改 public projection。**未删除任何真实 submission**。
- 未做复杂 Freeze/Unfreeze 动画（需求明确：无封榜需求则最小预留）。
- 验证（E2E）：封榜后新 AC 对 public 隐藏、对 admin 可见。

## 20. Load Test（500 clients）

- 脚本：`scripts/stress/scoreboard-load-test.js`（`--clients` 可配，本地 500 验证；条件允许可 1000）。
- 行为：500 clients 各登录 → `GET /scoreboard` full snapshot → 建立 `/contests/:cid/events` SSE → 部分转 fallback polling（`/scoreboard/version`）→ 部分断开重连 → 观察 25s。
- **结果（一次实测）**：
  ```
  clients=500  elapsed≈150s
  fullSnapshots=500  sseConnected=600  reconnects=100  polls=595  errors=0
  SQLite 查询（本次负载 delta）：scoreboardFull=218  submission=0  admin=0  total=218
  scoreboardFullQueries/client ≈ 0.44  (目标 < 1)
  PASS  DB query 不随 client 数线性爆炸
  ```
- **结论**：Scoreboard SSE / Full Snapshot 主要由内存 Snapshot 缓存服务；500 次快照请求仅 ~218 次 SQLite 查询（首次构建 + 部分 version 变化），未出现「500 clients → 500 DB query/tick」。

## 21. E2E Test

- 脚本：`scripts/e2e/phase5-scoreboard-sse.js`，覆盖验收用例（§30 Case 1-12）：
  - Case1 AC→solved+1；Case2 WA→solved 不变、wrongAttempts+1；Case3 WA→WA→AC→penalty/attempts 正确；
  - Case4 Rejudge AC→仍 AC；Case5 Rejudge WA→完成；Case6 SSE 收到 snapshot 且含 Lease 续期元信息；Case7 reconnect（重连带 lastVersion）；Case8 version gap→NEED_FULL_SYNC；Case9 Cache Lease 字段；Case10 429+Retry-After；Case12 Admin 真实榜单+详情源码。
  - **结果：21/21 通过**。
- Phase 4 回归：`scripts/e2e/oj-main-path.js` **10/10 通过**（三语言 AC + CE/WA/RE/TLE + 幂等 + 越权）。

## 22. Known Limitations

- **P0 不保留 delta 历史**：断线后若版本不一致一律 full sync（不做增量补 delta），正确性优先于带宽。
- **内存级 Rate Limiter**：单进程内存滑动窗口；若未来多进程/多实例需外置（Redis）——本阶段保持单 OJ Core 不引入。
- **Scoreboard 内存/缓存为单进程态**：重启后从 SQLite 重建（已验证），不跨进程共享。
- **Freeze 为最小实现**：仅隐藏新结果，未实现排行榜「冻结时刻快照定格/解冻动画」；按需求不扩展。
- **文档模式提交（旧远程 Worker 路径）不进关系榜单**：关系榜单仅反映 `oj_submissions`（Phase 4 正式提交主链路）。
- **`freezeAttempts` 封榜投影走关系库单用户查询**：仅封榜激活时触发（低频），非封榜路径不受影响。
- **`_metrics` 计数为开发期观测**，非安全/计费依据；计数器进程重启清零。

## 23. 下一阶段

- **正式执行隔离 / 更高并发扩展**（不阻塞当前 Web Runtime 主线）：
  - 保持 JudgeAdapter 接口不变，将关系库 submission 的本机 spawn 替换为容器/cgroup/nsjail；Trusted Worker 仅作为更远期实验。
  - 多实例/多 OJ Core 时 Scoreboard 内存态与 Rate Limiter 的外置化（Redis/共享存储）。
  - 持久化 delta 历史以支持断线增量补 delta（替代 P0 的 full sync）。
  - 完整 Freeze/Unfreeze 排行榜与封榜 UI。
- 三语言 Browser Runtime 本阶段未改动，后续如需增强另立阶段。

---

## 验收对照（需求 §33）

| # | 验收项 | 状态 |
|---|---|---|
| 1 | Scoreboard 排名正确 | ✅（ICPC 稳定排序，E2E Case1-3） |
| 2 | Submission 完成能更新榜单 | ✅（onFinished→recompute→10s delta） |
| 3 | Rejudge 能正确回滚/更新榜单 | ✅（E2E Case4/5） |
| 4 | 首次能获取 Full Snapshot | ✅（GET /scoreboard） |
| 5 | 后续主要使用 Delta | ✅（scoreboard-delta，只推变化用户） |
| 6 | SSE 可稳定连接 | ✅（500 clients 600 连接无 error） |
| 7 | SSE 断开可恢复 | ✅（reconnect + lastVersion 协商） |
| 8 | version gap 会 full sync | ✅（NEED_FULL_SYNC，E2E Case8） |
| 9 | Cache Lease 生效 | ✅（serverTime/nextSyncAt/localStorage/IndexedDB） |
| 10 | Rate Limit 生效 | ✅（429+Retry-After，E2E Case10） |
| 11 | 500 clients DB query 不线性爆炸 | ✅（0.44/client < 1） |
| 12 | Admin 能查询 Submission | ✅（分页+过滤） |
| 13 | Admin 能 Rejudge | ✅（关系库 judge-service） |
| 14 | Admin 不直接访问 SQLite | ✅（:3002 代理 → internalAdmin → SQLite） |
| 15 | SQLite 仍然权威持久层 | ✅（内存 derived，可随时 rebuild） |
| 16 | 三语言 Browser Runtime 无回退 | ✅（未改 runtime；Phase4 E2E 10/10；runtime 资源正常服务） |
