# Mini-OJ HTTP 与 Browser Runtime API

本文描述当前主线：浏览器负责 Local Run，OJ Core 的 JudgeAdapter 负责正式提交。除特别说明外，JSON 请求使用 `Content-Type: application/json`，时间使用 ISO 8601 字符串。

## 1. 服务、鉴权与通用约束

| 服务 | 生产默认端口 | 对外路径 | 数据职责 |
|---|---:|---|---|
| Contestant / OJ Core | 3001 | `/contest/*`、`/api/contest/*`、`/api/public/*` | SQLite 唯一 Owner、正式提交、JudgeAdapter、榜单、SSE |
| Admin | 3002 | `/admin/*`、`/api/admin/*` | 验证管理员 JWT 并代理 OJ Core；不直连 SQLite |
| Internal Admin | OJ Core 回环地址 | `/internal/admin/*` | 仅供 Admin 访问，不得由 Nginx 暴露 |

端口取决于启动方式：`APP_ENTRY=contest` 默认 3001，`APP_ENTRY=admin` 默认 3002；本地 `APP_ENTRY=all` 默认 3000。`/api/contest` 和 `/internal/admin` 只在 `all/contest` 模式挂载，`/api/admin` 只在 `all/admin` 模式挂载，`/api/public` 始终挂载。

`GET /healthz` 返回进程存活状态；`GET /readyz` 只在数据库、恢复扫描和内存服务初始化完成后返回 HTTP 200。两个入口都提供这两个探针。

选手和管理员登录后会收到 JWT，同时服务端写入 HttpOnly、`SameSite=Lax` 的 `token` Cookie。普通 API 也接受：

```http
Authorization: Bearer <JWT>
```

生产环境必须使用 HTTPS、同源调用和独立随机密钥。SSE 无法设置自定义 Header，因此比赛事件流也兼容 `?token=<JWT>`；URL token 可能进入代理日志，同源 Cookie 可用时应优先使用 Cookie。

通用限制：

- 正式源码最大 256 KiB，按 UTF-8 字节计算；
- 同一用户正式提交最多 1 次/秒，幂等命中在限流前返回；
- 同一用户、同一比赛最多 5 条比赛 SSE 连接；
- Full Scoreboard 同一 `(user, IP)` 在 30 秒窗口最多 20 次；
- `/sync` 最短间隔为 10 秒，Scoreboard delta 默认按 10 秒批量推送；
- `clientSubmittedAt` 只作为诊断 `createdAt` 保存，`serverReceivedAt` 才是正式时间；
- Browser stdout、Local PASS 和 Local execution time 都不是正式判定依据。

## 2. 公开接口

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/healthz` | `{ "status": "ok" }` |
| GET | `/readyz` | 200 `{ "status": "ready" }`；初始化中为 503 |
| GET | `/api/public/runtime-profiles` | `{profiles,generatedAt}`，全部脱敏 Language Profile |
| GET | `/api/public/runtime-profiles/:id` | `{profile}`，单个脱敏 Profile |
| GET | `/api/public/faq` | `{faq,generatedAt}`，由 Profile 派生的 FAQ |

公开 Runtime 接口使用 `Cache-Control: public, max-age=10, s-maxage=60, stale-while-revalidate=300`，不返回密钥、数据库路径、隐藏测试或内部命令占位符。

## 3. 选手接口

### 3.1 认证

| 方法 | 路径 | 请求/说明 |
|---|---|---|
| POST | `/api/contest/auth/login` | `{username,password}`；仅普通选手 |
| POST | `/api/contest/auth/register` | `{username,password,nickname?}`；用户名 3–20 位字母/数字/下划线，密码至少 6 位 |
| POST | `/api/contest/auth/logout` | 清除 Cookie |
| GET | `/api/contest/auth/me` | 当前用户；需登录 |

登录/注册成功返回 `{token,user}`。管理员账号不能从选手入口登录。

### 3.2 比赛、题目与榜单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/contest/contests` | 可选 | 可见比赛列表 |
| GET | `/api/contest/contests/:id` | 登录 | 比赛详情 |
| GET | `/api/contest/contests/:id/problems` | 登录、比赛开放 | 题目列表 |
| GET | `/api/contest/contests/:id/problems/:problemId` | 登录、比赛开放 | 题面和公开 samples；不返回隐藏测试 |
| GET | `/api/contest/contests/:id/rank` | 登录、比赛开放 | 兼容榜单端点，返回 `{snapshot}` |
| GET | `/api/contest/contests/:id/scoreboard` | 登录、比赛开放 | Full Snapshot；限流时返回 429 和 `Retry-After` |
| GET | `/api/contest/contests/:id/scoreboard/version` | 登录、比赛开放 | 轻量版本检查 |
| GET | `/api/contest/contests/:id/bootstrap` | 登录、比赛开放 | 榜单、我的提交和同步元数据 |
| GET | `/api/contest/contests/:id/sync` | 登录、比赛开放 | SSE 断线后的同步兜底；过快返回 429 |

### 3.3 正式提交

`POST /api/contest/contests/:contestId/submissions`

```json
{
  "problemId": "problem-id",
  "language": "cpp17",
  "source": "#include <iostream>\nint main(){std::cout << 42;}",
  "clientRequestId": "browser-generated-uuid",
  "clientSubmittedAt": "2026-08-23T00:00:00.000Z"
}
```

当前语言值：

```text
c11 | cpp11 | c17 | cpp17 | python3 | java21
```

`source` 是规范字段，`code` 是旧客户端兼容别名。`clientRequestId` 建议使用 UUID；同一用户用相同键重试时返回原提交，不重复入队。C17/C++17 在配置 `FORMAL_SUBMIT_CANARY_CONTEST_IDS` 时只允许指定比赛；C++20/C++23 当前不可提交。

新建成功：

```json
{
  "submission": { "id": "submission-uuid", "status": "QUEUED" },
  "serverReceivedAt": "2026-08-23T00:00:00.123Z"
}
```

幂等命中：

```json
{
  "submission": { "id": "submission-uuid", "status": "FINISHED", "verdict": "AC" },
  "deduplicated": true
}
```

状态为 `QUEUED → JUDGING → FINISHED`；终态 verdict 为 `AC | WA | TLE | MLE | RE | CE | SYSTEM_ERROR`。比赛未开始/结束、语言关闭、源码非法和限流均会在入队前返回错误。

### 3.4 提交查询与 SSE

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contest/contests/:id/submissions/me` | 当前用户最近 50 条；不返回源码 |
| GET | `/api/contest/contests/:id/submissions` | `status,page,pageSize,username,problemId` 查询，`pageSize ≤ 100` |
| GET | `/api/contest/submissions/:submissionId` | 仅提交拥有者或管理员；含源码和正式结果 |
| GET | `/api/contest/submissions/:submissionId/events` | 单条提交 SSE，初始事件 `submission_update` |
| GET | `/api/contest/contests/:id/events?lastVersion=N` | 比赛榜单 SSE |
| GET | `/api/contest/events` | 旧全局 SSE，保留兼容 |
| GET | `/api/contest/events/stream` | 旧 page SSE，保留兼容 |

比赛 SSE 主要事件：`scoreboard_snapshot`、`scoreboard-delta`、`scoreboard_sync`、`queue_status`。服务端不保存可完整重放的 delta 历史；`lastVersion` 与服务器版本不一致时，客户端必须请求 Full Snapshot。SSE 响应为 `text/event-stream`，Nginx 必须关闭代理缓冲。

### 3.5 设备与指标

- `POST /api/contest/devices/heartbeat`：登录设备心跳，推荐间隔 20 秒，60 秒未上报判离线；只用于运维。
- `GET /api/contest/_metrics`：仅管理员，用于 Contest 内部指标诊断。

## 4. Admin 接口

Admin 浏览器只访问 `:3002/api/admin/*`。除登录外全部端点要求管理员身份；Admin 随后通过回环网络和 HMAC 调用 OJ Core。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/auth/login` | `{username,password}`，仅管理员 |
| GET | `/api/admin/overview` | 系统总览 |
| GET | `/api/admin/devices` | 浏览器设备与在线状态 |
| GET | `/api/admin/audit` | 最近审计事件 |
| GET | `/api/admin/compiler` | 编译器探活 |
| GET/POST | `/api/admin/contests` | 比赛列表/新建 |
| GET/PUT/DELETE | `/api/admin/contests/:id` | 比赛详情/修改/删除 |
| GET/POST | `/api/admin/problems` | 题目列表/新建，管理端可见隐藏测试 |
| GET/PUT/DELETE | `/api/admin/problems/:id` | 题目详情/修改/删除 |
| GET | `/api/admin/contests/:id/submissions` | `page,pageSize,problemId,userId,language,verdict` 查询 |
| GET | `/api/admin/submissions/:id` | 源码、编译/运行信息和结果 |
| POST | `/api/admin/submissions/:id/rejudge` | 正式重判，仅 FINISHED 提交 |
| POST | `/api/admin/rejudge` | `{submissionId}`，遗留重判入口 |
| GET | `/api/admin/contests/:id/scoreboard` | 管理员真实榜单 |
| GET | `/api/admin/users` | `username,page,pageSize` 查询 |
| POST | `/api/admin/spotcheck` | `{submissionId}`，遗留抽查 |
| GET | `/api/admin/events/stream` | 管理事件 SSE |

Admin 不得在 `:3002` 创建第二个 SQLite Owner、JudgeService 或 Scheduler。

## 5. Internal Admin 契约

`/internal/admin/*` 不是公网 API。普通请求包含：

```http
X-Internal-Ts: <Unix milliseconds>
X-Internal-Token: HMAC-SHA256(INTERNAL_API_SECRET, "<timestamp>:<path-without-query>")
```

时间戳允许误差 60 秒。管理 SSE 使用同一 HMAC 作为 query token。内部端点与 `/api/admin/*` 基本一一对应，另有 `GET /internal/admin/languages`、`POST /internal/admin/languages/:id/status` 和 `GET /internal/admin/metrics`；语言 status override 只在内存生效，重启后恢复代码默认值。

## 6. Browser Runtime JavaScript API

Local Run 不经过 HTTP：

```js
const result = await window.__IDE_RUNNER__.runCode({
  language: 'cpp17',
  source: '#include <iostream>\nint main(){std::cout << 42;}',
  stdin: ''
});
```

`language` 接受 `c11 | cpp11 | c17 | cpp17 | python3 | java21`。结果可能包含 `compileStatus`、`compileTime`、`runStatus`、`executionTime`、`stdout`、`stderr`、`cacheHit`、`timedOut`、`outputTruncated` 和 `runtimeId`；全部只用于浏览器诊断。

## 7. 错误响应

正式提交链路使用：

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "提交过于频繁，请稍后再试"
  }
}
```

常见状态为 400、401、403、404、409、429、500；Admin 无法访问 OJ Core 时返回 502。部分历史路由仍返回 `{ "error": "文本" }` 或 `{ "error": "CODE", "message": "文本" }`，客户端在迁移完成前应兼容三种形态。

## 8. 遗留 Worker 协议

`/api/worker/register|events|pull|heartbeat|report` 与 lease/HMAC 逻辑只为早期 Trusted Worker 实验保留，并且仅在 `all/contest` 模式挂载。它们不参与当前 Contestant 正式提交主链路。
