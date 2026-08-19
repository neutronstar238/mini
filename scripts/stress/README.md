# 压测模拟器（Fake Worker / Fake Contestant）

依据指导文档 §20，通过 Fake Worker / Fake Contestant 模拟器进行压力测试，**不启动真实 WSL**。

## 准备

1. 启动 OJ Core（:3001）：
   ```bash
   cd server
   APP_ENTRY=contest PORT=3001 INTERNAL_API_SECRET=xxx node src/app.js
   ```
2. 生成 Worker 注册码（经 :3001 internal API）：
   ```bash
   cd scripts/stress
   node _prep-codes.js 8     # 生成 8 个注册码，逗号分隔输出
   ```

## Fake Worker（模拟 100~1000 个可信评测机）

```bash
node fake-worker.js \
  --workers 100 \
  --server http://127.0.0.1:3001 \
  --codes "OJ-XXX,OJ-YYY,..."    # 注册码轮换
```

行为：每个 Fake Worker 注册 → SSE 连接 → 心跳(15s±3s jitter) → 收到任务后模拟评测（随机 AC/WA/TLE）→ 签名回传。
统计：`connected / failed / dispatched / reported`。

> 注册码为一次性，模拟 N 个 Worker 需 ≥ ceil(N/codes) 组注册码轮换（或每次启动新生成）。
> Fake Worker 默认 `trust_status=pending`，需先用管理端审批为 approved+trusted 才能接任务：
> ```bash
> node _approve.js
> ```

## Fake Contestant（模拟 100~1000 个选手）

```bash
node fake-contestant.js \
  --users 500 \
  --server http://127.0.0.1:3001
```

行为：每个选手注册/登录 → SSE 连接 → bootstrap 快照 → 周期提交(10s+随机) → 接收 scoreboard_delta。
统计：`connected / submitted / gotDelta / errors`。

## 观察指标

| 指标 | 来源 |
|---|---|
| HTTP request/s | `_metrics.js` 采样（见下） |
| SSE 连接数 | Admin 页面 / `_metrics.js` |
| SQLite write/s | `_metrics.js` |
| SQLite busy/error | 服务端日志 |
| Scheduler dispatch latency | Admin SSE `task_dispatch` 事件时间戳 |
| 队列深度 | `/internal/admin/queue` |
| Judge throughput | judge_attempts 表增长速率 |
| Scoreboard batch payload | SSE `scoreboard_delta` 的 changes 数组长度 |

## 清理

```bash
node _cleanup-workers.js    # 删除 FakeWorker 测试记录
```

> `_prep-codes.js` / `_approve.js` / `_cleanup-workers.js` 为辅助脚本。
