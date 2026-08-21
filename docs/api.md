# Mini-OJ 当前接口说明

本文只把 **Browser Local Run + Server JudgeAdapter** 主链路作为正式接口。早期 `/api/worker/*` 协议仍可用于实验，但不属于本期核心验收。

## 1. 入口与鉴权

| 服务 | 默认地址 | 说明 |
|---|---|---|
| Contestant / OJ Core | `http://localhost:3001` | `/contest/*` 页面与 `/api/contest/*` |
| Admin | `http://localhost:3002` | `/admin/*` 页面与 `/api/admin/*` 代理 |
| Internal Admin | `http://127.0.0.1:3001/internal/admin/*` | 仅 Admin 服务使用共享密钥访问 |

登录成功后服务端写入 HttpOnly `token` Cookie，同时返回 JWT，API 也兼容 `Authorization: Bearer <JWT>`。

## 2. 选手接口

### 2.1 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/contest/auth/login` | `{username,password}` |
| POST | `/api/contest/auth/register` | 注册选手 |
| POST | `/api/contest/auth/logout` | 清除登录 Cookie |
| GET | `/api/contest/auth/me` | 当前用户 |

### 2.2 比赛与题目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contest/contests` | 可见比赛列表 |
| GET | `/api/contest/contests/:id` | 比赛详情 |
| GET | `/api/contest/contests/:id/problems` | 比赛题目列表 |
| GET | `/api/contest/contests/:id/problems/:problemId` | 题面与公开 samples；不返回隐藏测试 |

### 2.3 正式提交

`POST /api/contest/contests/:contestId/submissions`

```json
{
  "problemId": "problem-id",
  "language": "c11 | cpp11 | python3",
  "source": "source code",
  "clientRequestId": "browser-generated UUID",
  "clientSubmittedAt": "2026-08-20T00:00:00.000Z"
}
```

服务器只采信登录身份、源码、语言和服务端生成的 `serverReceivedAt`。`clientSubmittedAt` 仅用于诊断；Browser Local PASS、耗时与 stdout 不得上传为正式判定依据。

新建成功：

```json
{
  "submission": { "id": "uuid", "status": "QUEUED" },
  "serverReceivedAt": "2026-08-20T00:00:00.123Z"
}
```

相同 `(user_id, clientRequestId)` 重试返回原 submission，并带 `deduplicated: true`。

约束：

- 语言 allowlist：`c11`、`cpp11`、`python3`；
- 源码最大 256 KiB（按 UTF-8 字节）；
- 同一用户正式提交限速 1 次/秒；
- 隐藏测试始终只在服务器；
- Official Verdict 只由 JudgeAdapter 产生。

### 2.4 提交查询与事件

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contest/contests/:id/submissions/me` | 当前用户最近提交，不返回源码 |
| GET | `/api/contest/submissions/:submissionId` | 本人/Admin 查看详情；含源码与正式结果 |
| GET | `/api/contest/submissions/:submissionId/events` | 单条提交 SSE |
| GET | `/api/contest/contests/:id/events` | 比赛 SSE：submission/scoreboard 事件 |

关系型主链路状态：

```text
QUEUED → JUDGING → FINISHED + AC|WA|TLE|MLE|RE|CE|SYSTEM_ERROR
```

### 2.5 榜单与同步

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contest/contests/:id/scoreboard` | Full Snapshot，含 version/serverTime/nextSyncAt |
| GET | `/api/contest/contests/:id/scoreboard/version` | 轻量版本检查 |
| GET | `/api/contest/contests/:id/bootstrap` | 榜单 + 我的提交初始数据 |
| GET | `/api/contest/contests/:id/sync` | SSE 断线增量/全量同步兜底 |

正式榜单只读取关系库中已完成的 JudgeAdapter 结果，以 `server_received_at` 计算罚时。

### 2.6 客户端设备心跳

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/contest/devices/heartbeat` | 登录选手的 Chrome 设备心跳；保存设备 ID、运行环境、当前页面和最后在线时间 |

设备 ID 由浏览器生成并保存在 `localStorage`。OJ Core 超过 60 秒未收到心跳即标记离线，并向管理端广播 `client_device_update` SSE 事件。设备状态只用于运维监控，不参与正式判题或可信设备认证。

## 3. 管理接口

浏览器访问 `/api/admin/*`；Admin `:3002` 将产生正式状态变化的请求代理到 OJ Core `:3001/internal/admin/*`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/auth/login` | 管理员登录 |
| GET | `/api/admin/overview` | 系统总览 |
| GET | `/api/admin/devices` | Chrome 客户端设备列表与在线/离线统计 |
| GET/POST | `/api/admin/contests` | 比赛列表/新建 |
| GET/PUT/DELETE | `/api/admin/contests/:id` | 比赛详情/修改/删除 |
| GET/POST | `/api/admin/problems` | 题目列表/新建，隐藏测试仅管理端可见 |
| GET/PUT/DELETE | `/api/admin/problems/:id` | 题目详情/修改/删除 |
| GET | `/api/admin/contests/:id/submissions` | 比赛提交 |
| GET | `/api/admin/submissions/:id` | 提交源码与判题详情 |
| POST | `/api/admin/submissions/:id/rejudge` | 通过 JudgeAdapter 重判 |
| GET | `/api/admin/contests/:id/scoreboard` | 管理员榜单视图 |
| GET | `/api/admin/users` | 用户列表 |
| GET | `/api/admin/compiler` | 服务器编译器检查 |
| GET | `/api/admin/events/stream` | 管理事件 SSE |

Admin 不得直接打开关系型 SQLite，不得在 `:3002` 启动第二个 JudgeService。

## 4. Browser Runtime 接口

本地运行不经过 HTTP API。题目页加载后通过：

```js
await window.__IDE_RUNNER__.runCode({
  language: 'c11 | cpp11 | python3',
  source: '...',
  stdin: '...'
});
```

统一结果包含 `compileStatus`、`compileTime`、`runStatus`、`executionTime`、`stdout`、`stderr`、`cacheHit`、`timedOut`、`outputTruncated` 与 `runtimeId`。这些字段全部是 Local 诊断信息，服务器不接受它们作为正式结果。

## 5. 错误格式

主链路错误使用：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "用户可读说明"
  }
}
```

常见 HTTP 状态：400 参数或源码非法；401 未登录；403 无权限；404 资源不存在；409 幂等/状态冲突；429 限流；500 服务器异常。

## 6. 遗留 Worker 协议

`/api/worker/register|events|pull|heartbeat|report` 与 lease/HMAC 代码仍保留，用于早期 Trusted Worker 实验。它不参与当前 Contestant 正式提交链，不能作为本期“已完成的正式判题架构”写入 UI 或验收结论。
