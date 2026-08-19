# Mini-OJ 架构说明（三域 + 单 Scheduler + 单 DB Owner）

依据《Chrome 浏览器本地预检与可信边缘评测分布式方案项目立项申请书》与指导文档实现。

---

## 1. 架构

```
┌──────────── 不可信域（Contestant Chrome）────────────┐
│  WASM 本地预检（C/C++/Python 公开样例）· 不接触隐藏数据 │
└───────────────────┬──────────────────────────────────┘
                    │ HTTPS / SSE
┌───────────────────▼────────────── :3001 OJ Core ────┐
│  · 唯一 SQLite DB Owner（WAL + busy_timeout + 短事务）│
│  · 唯一 Scheduler（事件驱动 + watchdog）              │
│  · 唯一 Judge State Machine / Lease Manager          │
│  · 唯一 Worker Registry（内存心跳，不写 DB）           │
│  · 选手 SSE（batch+delta）+ 内存榜单 + cache lease     │
│  · /internal/admin/* 内部管理 API（HMAC 鉴权）        │
└───────────┬───────────────────────────┬──────────────┘
            │ internal API（:3002 无 DB 直连）│ mTLS/HMAC + SSE/WS
┌───────────▼────────── :3002 Admin ───┐ ┌────────────▼──── 可信执行域 ─┐
│  · 独立管理 Web                       │ │  Windows Judge Worker APP     │
│  · 无 SQLite 直连 / 无 Scheduler      │ │  · WSL2 + Ubuntu 22.04        │
│  · 全部经 :3001 internal API          │ │  · Isolate 沙箱               │
│  · SSE 桥接 :3001 事件流              │ │  · 心跳内存化                 │
└──────────────────────────────────────┘ └───────────────────────────────┘
```

**核心原则**（指导文档 §1/§2）：
- **数据一致性**：唯一 DB Owner（:3001），所有写入统一经 :3001。
- **正式判题公平性**：`server_received_at` 权威时间；隐藏测试点仅授权可信 Worker；正式排名仅采信可信结果。
- **单 Scheduler**：只有 :3001 有调度器实例与定时器；:3002 重判/抽查经 internal API 由 :3001 创建新 attempt。
- **单 DB Owner**：:3002 / Worker / Contestant 均禁止直连 SQLite。

---

## 2. 修改文件清单

| 文件 | 改动 |
|---|---|
| `server/src/config.js` | 定时参数全部集中（§19）；双入口端口；internalApiSecret/coreBaseUrl |
| `server/src/app.js` | 双入口独立挂载；`/internal/admin` 仅 :3001 暴露 |
| `server/src/middleware/internalAuth.js` | :3002→:3001 internal API HMAC 鉴权（新） |
| `server/src/routes/internal-admin.js` | :3001 内部管理 API（overview/nodes/certs/queue/audit/problems/rejudge/spotcheck/events）（新） |
| `server/src/routes/admin-v2.js` | 改为 HTTP 代理到 :3001；SSE 桥接（无 DB/Scheduler 直连） |
| `server/src/routes/worker.js` | 心跳内存化（worker-registry）；环境信息仅首次/变化写 DB |
| `server/src/routes/contest.js` | server_received_at + clientRequestId 幂等；sync/bootstrap + cache lease + rate limit；SSE batch+delta |
| `server/src/services/scheduler.js` | 事件驱动 + watchdog(10s/5s)；定向调度；rejudge/spotcheck；judge_attempts 历史 |
| `server/src/services/worker-registry.js` | 内存 Worker Registry（ONLINE/SUSPECT/OFFLINE，心跳不写 DB）（新） |
| `server/src/services/scoreboard.js` | 内存榜单 + dirty + 10s batch + delta（新） |
| `server/src/store/sqliteStore.js` | 增加 `judge_attempts` 表 |
| `scripts/stress/fake-worker.js` | Fake Worker 压测模拟器（新） |
| `scripts/stress/fake-contestant.js` | Fake Contestant 压测模拟器（新） |
| `scripts/stress/metrics.js` | 性能指标采样（新） |

---

## 3. 数据库

### PRAGMA
```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
```
> 所有事务为短事务（BEGIN → 快速变更 → COMMIT），禁止事务内网络调用/等待 Worker。

### 表（JSON 文档存储，Collection 抽象）
- `users` / `problems`（含 `version` + `testdataHash`）/ `submissions`（含 `serverReceivedAt`、`currentAttemptId`、`clientRequestId`）
- `judge_attempts`（**保留每次 attempt 历史**：attempt、problemVersion、testdataHash、workerId、lease、status[LEASED/RUNNING/FINISHED/EXPIRE]、result、cases）
- `workers`（静态字段：credential_hash 相关、环境版本；**不存心跳**）
- `register_codes` / `audit` / `meta`

### 迁移说明
新增 `judge_attempts` 集合自动建表（Collection 初始化即建表）。历史 JSON 数据不再需要迁移（正式版从零起）。

---

## 4. API 变化

### 选手端（:3001 /api/contest）
| 端点 | 说明 |
|---|---|
| POST /submissions | 新增 `clientRequestId`（幂等）；服务端记 `serverReceivedAt` |
| GET /sync/bootstrap | 首次加载：serverTime + scoreboardSnapshot + mySubmissions + **nextSyncAt(cache lease)** |
| GET /sync | 增量同步 `?scoreboardVersion=&submissionCursor=`；**rate limit 10s→429** |
| GET /events | SSE batch+delta（`?token=` 支持非浏览器客户端） |

### Worker（:3001 /api/worker）
| 端点 | 变化 |
|---|---|
| POST /heartbeat | **只更新内存 Registry**（cpu/memory/slots 内存态）；环境变化才写 DB |
| POST /report | 验签/幂等/attempt 历史/榜单 delta 触发 |

### 管理端（:3002 /api/admin → 代理 :3001 /internal/admin）
| 端点 | 说明 |
|---|---|
| POST /rejudge | 代理到 `POST :3001/internal/admin/rejudge/:id`（:3001 创建新 attempt 并调度） |
| POST /spotcheck | 代理到 `:3001/internal/admin/spotcheck/:id` |
| GET /events/stream | :3002 桥接 :3001 internal SSE |

---

## 5. 配置项（config.js）

| 键 | 默认 | 说明 |
|---|---|---|
| WORKER_HEARTBEAT_INTERVAL | 15000 | 心跳间隔 |
| WORKER_HEARTBEAT_JITTER | 3000 | 心跳 jitter（防同频） |
| WORKER_SUSPECT_AFTER | 30000 | ≤30s ONLINE |
| WORKER_OFFLINE_AFTER | 45000 | >45s OFFLINE |
| SCHEDULER_FALLBACK_SCAN | 10000 | pending fallback scan |
| LEASE_SWEEP_INTERVAL | 5000 | lease expiry sweep |
| CONTESTANT_BATCH_INTERVAL | 10000 | SSE batch window |
| CONTESTANT_FALLBACK_POLL_MIN/JITTER | 10000/3000 | SSE 断线 fallback polling |
| SSE_KEEPALIVE | 25000 | SSE 心跳 |
| PROGRESS_MIN_INTERVAL / MIN_PERCENT_DELTA | 5000/10 | Worker progress 节流 |
| leaseTtlMs / maxAttempt | 120000 / 3 | 租约与重试 |
| SYNC_MIN_INTERVAL | 10000 | 选手同步 rate limit |
| MAX_SSE_PER_USER | 5 | SSE 连接上限（P1） |

---

## 6. 关键状态机

```
提交：SUBMITTED → PENDING（server_received_at 定稿）
调度：PENDING → (选 Worker) → LEASED（attempt+1, lease_id/nonce/expires_at）
评测：LEASED → COMPILING → RUNNING → VERIFYING
终态：AC|WA|TLE|MLE|RE|CE|SE
租约过期：LEASED → PENDING(attempt+1) | SE(达 maxAttempt)
重判：任一终态 → PENDING（新 attempt，旧结果保留于 judge_attempts）
抽查：终态 → PENDING（spotCheckMeta 记录原结果，复测比对）
```

---

## 7. 压测方式

见 `scripts/stress/README.md`。核心：
- `fake-worker.js --workers 100 --codes "..."`：模拟 100~1000 Worker（SSE/心跳/收任务/回传）
- `fake-contestant.js --users 500`：模拟选手（登录/SSE/提交/榜单 delta）
- `metrics.js`：采样 judge throughput / queue / online / sqlite 错误

**本机实测**：8 Fake Worker + 10 Fake Contestant，15 提交全部评测完成（11 AC + 4 TLE），judge_attempts 完整记录。

---

## 8. 尚未完成 / P1

- [ ] Worker 控制面从 SSE 升级为 WebSocket（控制面消息：HEARTBEAT/TASK_ASSIGNED/TASK_ACK/...）
- [ ] 选手端多 Tab 单主 SSE（BroadcastChannel leader election）
- [ ] 客户端缓存从 localStorage 升级为 CacheRepository（IndexedDB）
- [ ] scoreboard 快照从内存扩展为可持久化恢复
- [ ] 正式/练习榜单分流（当前 practice 全量、formal 采信 trusted）
- [ ] 提交源码/testdata 大文件经 HTTPS 下载/上传（当前内嵌任务 JSON）
