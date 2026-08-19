# Mini-OJ 接口说明文档（三域架构）

三域：**不可信域**（选手 Chrome WASM 预检）→ **中心控制域**（server）→ **可信执行域**（Worker）。

- 基础地址：`http://<服务器>:3000`
- 选手端：`/api/contest/**`（域名 `contest.example.com`）
- 管理端：`/api/admin/**`（域名 `admin.example.com`）
- Worker 协议：`/api/worker/**`（证书身份 + HMAC 签名）
- 用户鉴权：`Authorization: Bearer <JWT>`（登录获取，同时写入 HttpOnly Cookie）
- 存储：SQLite（better-sqlite3，`server/data/mini-oj.db`）；`DB_DRIVER=postgres + DB_URL` 可切换 PostgreSQL

---

## 1. 选手端（/api/contest）

### 1.1 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/contest/auth/login | `{username,password}` → `{token,user}` |
| POST | /api/contest/auth/register | 选手注册 |
| POST | /api/contest/auth/logout | 登出 |
| GET | /api/contest/auth/me | 当前用户 |

### 1.2 题目（隐藏测试点不出）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/contest/problems | 列表 `?q=&difficulty=`，附通过率 |
| GET | /api/contest/problems/:id | 详情（**仅 samples，隐藏 testcases 不暴露**） |

### 1.3 提交

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/contest/submissions | `{problemId, language, code, localVerification}` → SUBMITTED 并调度 |
| GET | /api/contest/submissions | 记录 `?status=&page=&pageSize=`（选手仅见自己） |
| GET | /api/contest/submissions/:id | 明细（含 cases/message/env/localVerification） |
| GET | /api/contest/events/stream | SSE 实时流：`submission_update`、`queue_status` |

### 1.4 榜单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/contest/rank | `?mode=formal\|practice`；**formal 仅采信可信 Worker 结果** |

### 1.5 提交状态机

```
SUBMITTED → PENDING → LEASED → COMPILING → RUNNING → VERIFYING → AC|WA|TLE|MLE|RE|CE|SE
   └ 租约超时/异常 → PENDING(attempt+1)，达 maxAttempt=3 判 SE
```

---

## 2. 管理端（/api/admin，仅 admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/admin/overview | 总览统计 |
| GET | /api/admin/nodes | Worker 节点列表（含 trust_status/tier/在线） |
| POST | /api/admin/nodes/:id/tier | `{tier:"trusted"\|"sink"}` 认证可信/降级 |
| POST | /api/admin/nodes/:id/approve | `{approved:true\|false}` 审批/撤销（未审批无法领任务） |
| POST | /api/admin/nodes/:id/suspend | 挂起/恢复 |
| GET | /api/admin/certs | 注册码列表 |
| POST | /api/admin/certs | 生成 Worker 注册码 |
| GET | /api/admin/queue | 任务队列（非终态提交） |
| GET | /api/admin/audit | 审计日志（最近 200 条） |
| GET/POST/PUT/DELETE | /api/admin/problems[/:id] | 题目 CRUD（含隐藏测试数据） |
| POST | /api/admin/rejudge | `{submissionId}` 重判 |
| POST | /api/admin/spotcheck | `{submissionId}` 跨节点抽查（第二 Worker 复测比对） |
| GET | /api/admin/events/stream | 管理端 SSE：snapshot/task_dispatch/task_report/lease_expired/worker_anomaly/spotcheck_mismatch |

---

## 3. Worker 评测协议（/api/worker，可信执行域）

### 3.1 注册

`POST /api/worker/register`

```json
{ "code": "OJ-DEMO-WORKER-2024", "name": "WSL-JUDGE-01", "hostname": "PC-01", "os": "windows-wsl" }
// 响应（secret 仅此一次）
{ "worker_id": "uuid", "cert_id": "WKR-XXXXXX", "secret": "64hex", "trust_status": "pending", "heartbeat_interval_ms": 15000 }
```

新注册 `trust_status=pending`，**需管理员 approve 后才能领取隐藏测试点**。

### 3.2 SSE 任务流

`GET /api/worker/events?worker_id=<id>&token=<streamToken>`

- `streamToken = sha256("<worker_id>:<secret>:<当前分钟>")`
- 事件：`task`（签名任务）、`command`、`blacklist`

### 3.3 轮询拉取兜底

`POST /api/worker/pull`（签名同心跳）→ `{tasks:[...]}`

### 3.4 任务下发契约（server → worker）

```jsonc
{
  "task_id": "uuid", "submission_id": "uuid", "attempt": 1,
  "language": "cpp" | "python",
  "code": "选手代码",
  "problem": { "time_limit_ms": 1000, "memory_limit_mb": 256,
               "testcases": [{ "id":1, "input":"…", "answer":"…" }] },   // 隐藏测试点，仅授权可信 Worker
  "worker_id": "…", "tier": "trusted",
  "lease": { "lease_id": "uuid", "nonce": "…", "expires_at": 1755563947012 },
  "runtime_manifest_hash": "sha256",     // 期望运行时哈希
  "trust_status": "approved",
  "sig": "HMAC-SHA256"
}
```

### 3.5 心跳

`POST /api/worker/heartbeat`

```json
{ "worker_id": "…", "nonce": "…", "ts": 1755563947012, "runtime_manifest_hash": "…", "sig": "HMAC" }
```

服务端比对期望 `runtime_manifest_hash`，不一致触发异常告警。

### 3.6 结果回传

`POST /api/worker/report`

```jsonc
{
  "worker_id": "…", "task_id": "…", "submission_id": "…", "attempt": 1, "lease_id": "…",
  "status": "AC", "cases": [{ "id":1,"status":"AC","time_ms":1000,"memory_kb":0 }],
  "time_ms": 1000, "memory_kb": 0, "message": "",
  "runtime_manifest_hash": "sha256",
  "env": { "wsl": "Ubuntu-24.04", "trusted": true },
  "nonce": "…", "ts": 1755563947012, "sig": "HMAC"
}
```

服务端校验链：**nonce 唯一 → HMAC 验签 → 任务归属/租约匹配 → 幂等(lease_id 去重) → 抽查比对**。

---

## 4. 签名算法（HMAC-SHA256，按 worker secret）

与 `server/src/security/trust.js` ⇔ `worker/security/worker-security.js` 严格一致。

### 任务签名

```
payload = ["task", task_id, submission_id, attempt, worker_id, lease_id, nonce, expires_at, language, runtime_manifest_hash].join("|")
sig     = HMAC_SHA256(worker.secret, payload)
```

### 结果签名

```
cases = cases.map(c => `${c.id}:${c.status}:${c.time_ms}:${c.memory_kb}`).join(",")
payload = ["report", worker_id, task_id, submission_id, attempt, lease_id, status, cases, runtime_manifest_hash, nonce].join("|")
sig = HMAC_SHA256(worker.secret, payload)
```

### 心跳签名

```
payload = ["heartbeat", worker_id, nonce, ts, runtime_manifest_hash].join("|")
```

### 防重放/幂等

- 每个 `nonce` 服务端缓存 10 分钟，重复拒绝；
- `ts` 偏差超 10 分钟拒绝；
- 每个 `lease_id` 只接受一次回传（幂等）。

---

## 5. 错误码

| HTTP | 含义 |
|---|---|
| 400 | 参数缺失/非法 |
| 401 | 未登录 / 签名校验失败 / nonce 重放 |
| 403 | 权限不足 / Worker 挂起 |
| 404 | 资源不存在 |
| 409 | 冲突（重复注册码等） |
| 500 | 服务器内部错误 |

## 6. 部署

### 裸机

```bash
cd server && npm install --registry=https://registry.npmmirror.com && npm start
```

### Docker（双域名 + SSE 透传）

```bash
docker compose -f deploy/docker-compose.yml up -d   # http://localhost:8080
```

Nginx 按 `ServerName` 分发：`contest.*` → 选手端、`admin.*` → 管理端；对 `/api/*/events/stream`
关闭缓冲（`proxy_buffering off`）并放大 `proxy_read_timeout` 保证 SSE 长连接。
