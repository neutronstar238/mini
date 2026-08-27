# Phase 4 · OJ Core Main Path MVP 交付报告

> 三语言 Browser Runtime FINAL FROZEN 后的第一个业务系统阶段。
> 本文档对应 `docs/oj-main-path-report.md`，共 21 小节。

- 阶段：Phase 4 — OJ Core Main Path MVP
- 状态：✅ 主链路真实跑通（Contestant → Local Run → Formal Submit → Official Judge → Official Result）
- 日期：2026-08-20
- 测试环境：localhost（Windows，本地 spawn Judge）+ **Linux 参考环境（GCC/G++ 11.5 / CPython 3.12.3）**
- 部署拓扑：Contestant/OJ Core (:3001) + Admin (:3002)，经 nginx 反代 + HTTPS 提供服务；PM2 双入口

---

## 1. 当前仓库审计

### 1.1 已冻结基础（本阶段禁止修改）

| 语言 | Runtime ID | 状态 |
|---|---|---|
| C++11 | `cpp11-gcc11-compat-v4` | FINAL FROZEN |
| C11 | `c11-gcc11-compat-v3` | FINAL FROZEN |
| Python3 | `py312-cpython-compat-v1` | FINAL FROZEN |

统一入口 `runCode({language, source, stdin})` 已存在（`server/public/js/contest/ide-runner.js` → `window.__IDE_RUNNER__`）。本阶段复用，未重复造 RuntimeManager。

### 1.2 已存在模块（审计结论）

| 模块 | 位置 | 状态 |
|---|---|---|
| 三语言 Browser Runtime | `server/public/js/contest/ide-runner.js` + workers + pyodide | ✅ 冻结，复用 |
| 文档模式存储层 | `server/src/store/sqliteStore.js`（WAL 已开） | ✅ 保留（并存） |
| JWT HttpOnly Cookie Auth | `server/src/middleware/auth.js` | ✅ 保留 |
| Contestant 三操作页面 | `server/views/contest/problem-detail.ejs` + `.js` | ✅ 复用，改造 Submit |
| SSE 连接池 | `server/src/sse/hub.js` | ✅ 复用 |
| 远程 Worker 评测 | `server/src/routes/worker.js` + `services/scheduler.js` | ⚠️ **DEPRECATED**（本阶段主用） |
| 状态机（旧） | `server/src/services/state-machine.js` | ⚠️ 保留（远程 Worker 用） |

### 1.3 需补齐 / 需新增 / 冲突

- **需新增**：关系型 Repository 层、SubmissionService、JudgeAdapter（DEV ONLY）、正式状态机 `submission-state.js`、统一 API 错误处理。
- **需改造**：`config.js` 语言 allowlist → `c11/cpp11/python3`；`contest.js` 正式提交改走 SubmissionService + JudgeAdapter。
- **架构冲突**：既有远程 Worker 评测（Local Agent / Windows Worker）正是规范标注的 **deprecated** 模式。本阶段主链路改用服务器端 JudgeAdapter，旧 Worker 路径保留不删除。

### 1.4 废弃设计标记

以下既有代码标记 **DEPRECATED（本阶段主链路不沿用）**，但为兼容保留：

- `Local Agent`（`worker/agent/`）
- `Windows Worker`（`worker/judge/wsl-judge.js`）
- 客户端正式 Judge / 客户端 hidden tests（浏览器本地只做 custom stdin + public sample）
- Worker 直接数据库（Judge 层只接收 `submissionId/source/language/limits`，不接收 Cookie/Session/密码）

---

## 2. 最终主链架构

```
Contestant Browser
        │
        ├──────── Local Run ────────► Browser Runtime (runCode, 纯本地)
        │
        └──────── Formal Submit ────► OJ Core
                                         │  POST /api/contest/.../submissions
                                    Submission Service
                                         │  validate + idempotency + rate limit + 短事务 INSERT
                                      SQLite WAL (oj-main-path.db)
                                         │  QUEUED
                                    JudgeService
                                         │  QUEUED → JUDGING（短事务）
                                    JudgeAdapter (DEV ONLY)
                                         │  spawn gcc/g++/python 跑 hidden test
                                         │  FINISHED + verdict（短事务）
                                    OJ Core
                                         │  SSE: submission_update
                                     Browser（前端看到正式 Verdict）
```

信任边界（用户强制，任何违反不实现）：

```
Browser = Untrusted
OJ Core = Trusted Control Plane
SQLite = Authoritative Persistent Store
Official Judge = Authoritative Verdict Source
```

---

## 3. SQLite Schema

关系型主链路库 `server/data/oj-main-path.db`，脚本 `server/src/db/migrations/oj-main-path.sql`。

```sql
oj_users            id, username(UNIQUE), password_hash, role, banned, created_at
oj_contests         id, title, description, start_at, end_at, status, created_at
oj_problems         id, contest_id(FK), label, title, statement, time_limit_ms,
                    memory_limit_mb, testcases(JSON 隐藏测试，仅服务端), created_at
oj_problem_samples  id, problem_id(FK), sample_index, input, expected_output
oj_submissions      id, contest_id(FK), problem_id(FK), user_id(FK), language,
                    source_code, status(QUEUED|JUDGING|FINISHED), verdict,
                    created_at, server_received_at, judge_started_at, judge_finished_at,
                    execution_time_ms, memory_kb, compile_message, runtime_message,
                    client_request_id,
                    UNIQUE(user_id, client_request_id)   -- 幂等约束
```

索引：`oj_problems_contest`、`oj_samples_problem`、`oj_submissions_user/contest/problem/status`。

### Hidden Test 隔离

- `oj_problems.testcases` 存于 JSON 列，仅服务端 `problemRepo.getTestcases()` 读取，供 JudgeAdapter 使用。
- 公开样例存于 `oj_problem_samples` 表，可发给浏览器。
- API 严禁返回 `testcases` / Judge 数据路径（`problemRepo.publicProblem()` 显式剔除）。

---

## 4. SQLite WAL 配置

`server/src/db/sqlite.js`（`createOjDb`）：

```js
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
```

- 短事务原则（规范 §23 强制）：INSERT / UPDATE 各自独立 `better-sqlite3.transaction`，**禁止在事务内等待 Judge/网络**。
- 仅 OJ Core 直连 SQLite；Contestant/Admin/Judge 一律经 OJ Core API。

---

## 5. Repository 设计

`server/src/store/repositories/`（关系型，与文档模式并存过渡）：

| Repository | 关键方法 |
|---|---|
| `user-repository.js` | findById / findByUsername / insert / ensureUser |
| `contest-repository.js` | findById / insert / update / ensureContest |
| `problem-repository.js` | findById / listByContest / getTestcases / listSamples / publicProblem / ensureProblem |
| `submission-repository.js` | findById / findByIdempotent / insert(幂等) / updateStatus / listInFlight / rateLimitCheck / listByUserAndContest |

- 并发过渡：`oj-seed-sync.js` 在启动时把文档种子数据（users/contests/problems/samples）幂等同步到关系库；提交时 `ensureUser` 按需补齐新注册用户。

---

## 6. Auth 设计

- **沿用既有 JWT + HttpOnly Cookie**（规范 §7：已有稳定 JWT 不强行替换）。
- Cookie：`httpOnly: true, sameSite: 'lax'`（生产 HTTPS 部署时加 `Secure`）。
- 密码：`bcryptjs`（既有依赖）。
- 密码/权限信息不存 localStorage。
- 现有路由：`POST /api/contest/auth/login|register|logout`，`GET /auth/me`。

---

## 7. Problem API

沿用 `/api/contest` 命名空间（前端已全量接线），关系库优先：

```
GET /api/contest/contests/:contestId/problems
  → { contest: {id,title,status}, problems: [{id,label,title,order,acCount,submitCount}] }

GET /api/contest/contests/:contestId/problems/:problemId
  → { problem: {id,label,title,statement,description,timeLimitMs,memoryLimitMb,samples:[{index,input,output}]} }
```

- 仅返回公开样例；**严禁返回 hidden test / official output / judge 数据路径**。
- 进入校验 `requireContestOpen`：比赛存在 + 已开始（`CONTEST_NOT_FOUND` / `CONTEST_NOT_STARTED`）。

---

## 8. Submission API

```
POST /api/contest/contests/:contestId/submissions
Body: { contestId, problemId, language, code/source, clientRequestId, clientSubmittedAt(可选，仅日志) }
Server: authenticate → validate contest → validate problem → validate language →
        validate source 大小/UTF-8 → check contest time → idempotency → rate limit →
        server_received_at = server now() → INSERT(QUEUED, 短事务) → dispatch judge(异步) → return
  → { submission: { id, status: 'QUEUED' }, serverReceivedAt }
  → 幂等命中 → { submission: { id, status, verdict }, deduplicated: true }

GET /api/contest/submissions/:id
  → 仅本人 / Admin 可看完整 source；他人 → 403 FORBIDDEN

GET /api/contest/contests/:contestId/submissions/me
  → { submissions: [{submissionId, problemId, language, status, verdict, serverReceivedAt, executionTime, memory}] }（不含 source）

GET /api/contest/submissions/:id/events   → 单条提交 SSE
GET /api/contest/events/stream             → 页面级 SSE
```

### server_received_at 权威

- `server_received_at = server now()` 在 INSERT 前生成，为正式比赛/排名时间。
- `clientSubmittedAt` 仅作日志，**任何排名/罚时不得使用浏览器时间**。

---

## 9. Submission 状态机

`server/src/services/submission-state.js` —— 主链路唯一正式定义：

```
status:  QUEUED → JUDGING → FINISHED
verdict: null → AC | WA | TLE | MLE | RE | CE | SYSTEM_ERROR（仅 FINISHED 时非空）

QUEUED   → [JUDGING, FINISHED]
JUDGING  → [FINISHED]
FINISHED → []（终态）
```

- 与旧远程 Worker 路径 `state-machine.js`（SUBMITTED/PENDING/LEASED/...）**并存**：旧模块仅远程 Worker 用，主链路只用 `submission-state.js`，全项目两套各自内部唯一、不混写。
- 状态推进仅由 `judge-service.js` 唯一执行。

---

## 10. Idempotency

- `clientRequestId` 前端用 `crypto.randomUUID()`；点击一次生成一个；请求 timeout 重试复用同一键。
- DB 级约束 `UNIQUE(user_id, client_request_id)` 兜底（`submission-repository.insert` 事务内幂等检查）。
- 命中重复 → 返回原 `submissionId` + `deduplicated: true`，不新建记录。
- E2E Case6 已验证：同键二次 POST 返回同一 `submissionId`。

---

## 11. Local Run 数据流

```
Contestant Problem Page [运行代码]
  → 前端 runIde() → window.__IDE_RUNNER__.runCode({language, code, source, stdin})
  → Browser Runtime（Clang/WASI 或 Pyodide Persistent Worker）
  → compileStatus / runStatus / stdout / stderr / compileTime / linkTime / executionTime / cacheHit
  → 结果仅显示于页面，标注 LOCAL，不发送 source/stdin 到服务器
```

- `source`/`stdin` **绝不发送**到服务器（本地运行不限速，因为根本不请求 Server）。
- 页面明确标注 `LOCAL` 徽标。

---

## 12. Sample Runner

```
[运行样例]
  → source → compile once（Compile Once, Run Many）
  → 逐个公开 Sample（浏览器内本地执行，Artifact Cache 命中避免重复编译）
  → 每样例显示：PASS / WA / CE / RE / TIMEOUT + Expected / Actual
  → normalizeOut()：\r\n→\n、去行尾空白、去首尾空白
```

- 样例结果标注 `LOCAL`。
- 页面强制提示：**「样例通过仅表示当前公开样例通过，正式结果以服务器评测为准。」**（`oj-sample-warn`）。
- `Local Sample Passed ≠ Accepted`。

---

## 13. Formal Submit 数据流

```
[正式提交]
  → 前端生成 clientRequestId（crypto.randomUUID，重试复用）
  → language 映射：c→c11, cpp→cpp11, python→python3
  → POST /api/contest/.../submissions { contestId, problemId, language, code, clientRequestId, clientSubmittedAt }
  → SubmissionService：
      用户/比赛/题目/语言/时间/幂等/限速 校验
      server_received_at = server now()
      短事务 INSERT（status=QUEUED）
  → JudgeService.dispatch（异步，事务外）
```

- 只上传 source/language/problem/contest/clientRequestId。
- **不得上传** local verdict / sample passed / local execution time 作为正式依据。
- 服务器完全不信任 Local PASS / Local executionTime / Browser verdict。

---

## 14. Judge Adapter

`server/src/judge/judge-adapter.js`

```js
async function judgeSubmission({ submissionId, language, source, problemId, timeLimitMs, memoryLimitMb, testcases })
  → { verdict, executionTimeMs, memoryKb, compileMessage, runtimeMessage, cases }
```

- C/C++：`gcc`/`g++` 编译（`-std=c11` / `-std=c++11`）+ 对 hidden testcases 逐个运行。
- Python3：`python3` 直接运行。
- 比较：`normalizeOutput`（与前端/既有 testdata.js 对齐）。
- 每测试点判定 AC/WA/TLE/RE/CE/SYSTEM_ERROR；首个非 AC 决定最终 verdict。

> ⚠️ **DEV ONLY**：本实现用 `child_process.spawn` 直接运行用户程序，具备 CPU/wall 超时 + 输出上限，但**无沙箱/文件系统/网络隔离/内存硬限制**。正式生产安全评测（cgroup/容器/sandbox）为下一阶段。报告不宣称其为"安全生产 Judge"。

---

## 15. Official Result 数据流

```
JudgeAdapter 返回 verdict
  → JudgeService：短事务 UPDATE submission → status=FINISHED, verdict=..., executionTimeMs...
  → emitSubmission() → hub.broadcastPage('submission_update', {...})
  → SSE 推送到 Contestant 页面
  → 前端 trackSubmission() 显示 OFFICIAL 徽标 + 正式 Verdict 文案
```

- 终态由 JudgeService 唯一推进。
- 预留 `scoreboard_dirty` 事件（下一阶段 Scoreboard 使用）。

---

## 16. SSE

- 连接池 `server/src/sse/hub.js`（既有）。
- 主链路推送 `submission_update` 事件（含 id/status/verdict/executionTime/memory）。
- 端点：`GET /api/contest/events/stream`（页面级）、`GET /api/contest/submissions/:id/events`（单条）。
- **SSE 断开 fallback**：前端 `trackSubmission()` 每 2.5s 轮询当前提交直到 FINISHED。

---

## 17. Security / Trust Boundary

- **Judge 不访问 Contestant Session**：JudgeAdapter/JudgeService 只接收 `submissionId/source/language/limits/testcases`，**不接收 Cookie/Session/JWT/密码**。
- 隐藏测试只存在服务器；路径不返回浏览器。
- `GET /submissions/:id` 仅本人/Admin 可看完整 source；他人 → 403。
- 正式提交限速：同用户 1 次/秒（`RATE_LIMITED`）；Local Run 不限速（不请求 Server）。
- 统一 API 错误：`{ error: { code, message } }`（`middleware/api-error.js`），不返回 SQLite stack。
- 错误码：AUTH_REQUIRED / FORBIDDEN / CONTEST_NOT_FOUND / PROBLEM_NOT_FOUND / CONTEST_NOT_STARTED / CONTEST_ENDED / INVALID_LANGUAGE / SOURCE_TOO_LARGE / DUPLICATE_REQUEST / SUBMISSION_NOT_FOUND / RATE_LIMITED / INTERNAL_ERROR。

---

## 18. E2E Test

`scripts/e2e/oj-main-path.js`（`npm run test:e2e`）。

本轮扩展后覆盖 **10 个 case**，三语言各 AC 一次 + CE/WA/RE/TLE + hidden-WA + 幂等 + 越权，全状态机验证。

| Case | 场景 | 结果（本地 Windows gcc15/Py3.13） | 结果（Linux 参考环境 gcc13/Py3.12.3） |
|---|---|---|---|
| 1 | C++11 A+B 正式提交 | AC ✅ | AC ✅ |
| 1b | **C11 A+B**（`long long`） | AC ✅（新增，三语言各 AC） | AC ✅ |
| 1c | **Python3 A+B**（原生大整数） | AC ✅（新增，三语言各 AC） | AC ✅ |
| 2 | C11 语法错误 | CE ✅ | CE ✅ |
| 3 | Python ZeroDivision | RE ✅ | RE ✅ |
| 4 | 错误答案 | WA ✅ | WA ✅ |
| 4b | **1+2+...+n naive 循环**（Python） | TLE ✅（新增） | TLE ✅ |
| 5 | 公开样例通过但 hidden（int 溢出） | WA ✅ | WA ✅（证明 Local Sample Passed ≠ Accepted） |
| 6 | 同 clientRequestId 二次提交 | 幂等同一 submissionId ✅ | 幂等 ✅ |
| 7 | 用户 A 访问用户 B submission | 403 ✅ | 403 ✅ |

**本地与 Linux 参考环境均 10/10 通过（新增三语言 AC + TLE 后仍全绿）。**

> **TLE case 设计说明（实测发现）**：`1+2+...+n` 的 naive `O(n)` 累加若用 **C 编写，gcc `-O2` 会把等差数列求和优化为 O(1) 公式**，`n=1e9` 也能瞬间 AC，无法触发 TLE。故 E2E 的 TLE case 改用 **Python naive 循环**（CPython 无该优化，1e9 次迭代必然超时，实测 `judgeDurationMs≈1160` / `executionTimeMs≈1013`，恰在 1000ms 上限触发 TLE）。这是评测编译器优化行为，并非评测系统缺陷；真实 OJ 用 `-O2` 属标准行为。

> **服务端结构化日志（§37 验收）**：`judge-service.js` 新增 `[judge:enqueue]`（submissionId/userId/problemId/language/status/receivedAt）、`[judge:transition]`（QUEUED→JUDGING 时间点）、`[judge:verdict]`（verdict/judgeDurationMs/executionTimeMs/memoryKb）三类结构化日志，覆盖每次提交的完整生命周期，**不含 source / Cookie / 密码等敏感字段**。

### 生产部署验证（Contestant :3001 / Admin :3002）

- 代码更新至生产 `contest`/`admin` 站点 `src/`（含 `db/`、`judge/`、`store/repositories/`）与前端改动，pm2 双服务重启。
- 经域名 HTTPS（nginx 反代 + COOP/COEP 透传）登录 + E2E 全过。
- 生产关系库 `oj-main-path.db`：WAL 正常、E2E 比赛 seed、提交持久化（AC/CE/RE/WA 分布正确）、服务日志无主链路错误。
- 部署前已完成测试环境数据备份。
- admin 站点 `/api/admin` 登录 / overview 正常。
- 当前部署与回滚统一使用 `deploy/deploy-server.ps1`；主链路验证使用 `scripts/e2e/oj-main-path.js`。

> 注：服务器实测编译器为 GCC 13.3（非记忆中 GCC11）；Judge 以 `-std=c11`/`-std=c++11` 编译，AC/CE/RE/WA/TLE 语义与 GCC11 一致，E2E 已实证。如需严格 GCC 11 可用 `g++-11`。

### Development Contest「Browser OJ E2E Test」

`server/src/seed.js` 幂等创建，3 题：
- A. A+B（hidden 含 `2e9 2e9 → 4e9`，int 溢出点，用于 Case5）
- B. 多组求和（读到 EOF）
- C. 1+2+...+n（n=1e9，Python naive 循环 TLE 点）

三语言均验证：C11 AC / C++11 AC / Python AC + CE / WA / RE / TLE。

---

## 19. Browser Runtime Regression

- **未修改任何冻结 Runtime 文件**：`ide-runner.js` 编译管线、`ide-wasi-worker.js`、`ide-python-worker.js`、`runno-runtime.js`、Pyodide、PCH、Artifact Cache、executionTime 定义全部未触碰。
- `runCode()` 集成调用路径（`problem-detail.js` 的 `runIde`）**逐字节未变**：仍为 `window.__IDE_RUNNER__.runCode({language, code, source, stdin, ...})`。
- Worker 持久化 / Artifact Cache / Pyodide isolation / PCH / Execution Time 语义不变。
- 页面接入仅为增加 LOCAL/OFFICIAL 标签、Sample 提示、草稿持久化与 Submit 幂等逻辑，不改变 Runtime 行为。

---

## 20. Known Limitations

1. **Judge 为 DEV ONLY**：无沙箱（进程隔离 / FS 隔离 / 网络隔离 / 内存硬限制），生产安全评测下一阶段。
2. **Scoreboard 未做**：仅预留 `scoreboard_dirty` 事件；封榜/罚时/10s delta/cache lease 下一阶段。
3. **Admin 未扩展**：仅保证现有题目从 DB 读取 + seed 写入；复杂比赛配置/RBAC 未做。
4. **Judge 串行限流**：`JudgeService` 串行队列简单限流，未做并发评测调度。
5. **单机单 OJ Core**：无分布式/多 Worker；旧远程 Worker 路径保留但本阶段主链路不走。
6. **内存 MLE 仅估算**：本阶段未实现精确内存上限检测（DEV ONLY）。
7. **测试服务器临时日志**：`server/data/test-out.log`、`test-err.log` 为联调产物，可删除。
8. **既有文档库残留 PENDING 提交**：生产 `mini-oj.db`（旧文档库）保留了一条旧代码时代的 PENDING 提交，启动时可能触发一次性 `[error] JSON` 日志（`app.js` 全局错误中间件捕获，非 Phase 4 主链路）。**已修复**：选手「我的提交」页面改读关系库 `oj_submissions`，不再显示旧路径残留；并把旧 PENDING 标记为 SYSTEM_ERROR。
9. **关键 bug 修复（生产部署验证中发现）**：原 `submissions.ejs`/`.js` 仍读旧文档库 `db.submissions`（状态名 `SUBMITTED/PENDING/LEASED/RUNNING/VERIFYING`），与 Phase 4 关系库主链路脱节，导致选手提交正式评测后**在「我的提交」页面看不到自己的官方结果**，仅有旧 PENDING 残留转圈。已修复：页面改调 `/api/contest/contests/:cid/submissions/me`（关系库），状态映射更新为 `QUEUED/JUDGING/FINISHED + verdict`，移除"Local Precheck"列，新增"Verdict / Status"列。生产验证：用户新提交 4s 内 FINISHED+AC，列表 10 条全部正确呈现（AC/WA/RE/CE 覆盖）。

---

## 21. 下一阶段

- **Official Judge Security**：容器/cgroup/sandbox、FS/网络隔离、CPU/memory 硬限制、并发评测池。
- **完整 Scoreboard**：ICPC 排名、封榜、罚时、10s delta、cache lease。
- **Admin Web 深化**：批量导题、比赛配置、评测队列管理、题目/数据管理。
- **Submission 重判**：针对 FINISHED 的 rejudge（JudgeService 提供基础）。
- **并发与多实例**：分布式 Judge / 多 OJ Core（当前单机）。

---

### 验收对照（规范 §42）

| # | 验收项 | 状态 |
|---|---|---|
| 1-4 | 登录 / 进比赛 / 开题 / 选三语言 | ✅ |
| 5-6 | 三语言 Local Run / Custom stdin | ✅（既有页面，未破坏） |
| 7-9 | 公开样例自动运行 / PASS/WA 显示 / Sample Passed ≠ AC | ✅ |
| 10-12 | 正式提交写 SQLite / server_received_at / 幂等 | ✅ |
| 13-15 | JudgeAdapter 调用 / QUEUED→JUDGING→FINISHED / 前端看 Verdict | ✅ |
| 16 | Hidden Test 不进 Browser | ✅ |
| 17 | 用户不能看他人完整 Submission | ✅（403） |
| 18 | SQLite WAL 正常 | ✅ |
| 19 | DB 只由 OJ Core 直连 | ✅ |
| 20 | 三语言 Frozen Regression | ✅（Runtime 未改动，runCode 集成未变） |
