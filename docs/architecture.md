# Mini-OJ 当前架构

当前主线为 **Browser Local Run + Server JudgeAdapter**。浏览器承担高频调试，服务器承担正式判题；早期 Trusted Worker 协议仍保留在仓库中，但不属于本期核心流程。

## 1. 两条执行路径

```text
Contestant Chrome
  │
  ├─ 运行代码 / 运行样例
  │      └─ Browser Web Worker
  │           ├─ C/C++: Clang + wasm-ld + WASI
  │           └─ Python: Pyodide / CPython Wasm
  │
  └─ 正式提交 source + language + clientRequestId
         └─ OJ Core :3001
              ├─ SQLite 权威记录
              ├─ JudgeService
              ├─ JudgeAdapter（gcc-11 / g++-11 / python3）
              └─ Official Verdict → SSE → 提交记录 / 榜单

Admin :3002 ── authenticated internal API ──> OJ Core :3001
```

Browser Local 的 stdout、耗时、Sample Passed 全部不可信，仅供选手调试。隐藏测试、正式时间和 Official Verdict 只存在于服务器。

## 2. 组件职责

### Contestant Web

- 题面、编辑器、语言选择、自定义 stdin 和公开样例；
- C/C++ 与 Python 分别在独立 Worker 中运行；
- 代码草稿按 user + contest + problem 隔离；
- 本地运行不发送源码，正式提交才发往服务器；
- 本地执行时间只显示为 Local Runtime。

### OJ Core（`:3001`）

- 唯一关系型 SQLite Owner；
- 用户、比赛、题目、Submission、隐藏测试；
- `server_received_at` 权威时间与 `clientRequestId` 幂等；
- `JudgeService` 与 `JudgeAdapter` 正式判题；
- SSE、内存榜单、10 秒 Batch/Delta、轮询兜底；
- Internal Admin API、限流、审计和恢复。

### Admin（`:3002`）

- 独立管理页面与管理员认证；
- 比赛/题目/提交/重判操作通过 `:3001/internal/admin/*`；
- 不直接打开关系型 SQLite，不创建第二个 JudgeService/Scheduler。

## 3. Browser Runtime

| 语言 | Runtime ID | 浏览器实现 |
|---|---|---|
| C++11 | `cpp11-gcc11-compat-v4` | Clang 8.0.1 + wasm-ld + WASI libc++，显式 `-std=c++11` |
| C11 | `c11-gcc11-compat-v3` | Clang 8.0.1 + wasm-ld + WASI libc，显式 `-std=c11` |
| Python 3 | `py312-cpython-compat-v1` | Pyodide 0.26.4 / CPython 3.12.1 |

实现约束：

- Runtime 大文件 self-host；
- 稳定版本 URL 使用一年 `immutable`，旧兼容 URL 强制重新验证；
- COOP/COEP 使比赛页面 cross-origin isolated；
- C/C++ stdin 最大 4 MiB，按 UTF-8 字节动态分配；
- stdout/stderr 各最大 1 MiB，超限明确标记；
- 执行超时中断或 terminate Worker，主线程不运行用户代码；
- Runtime manifest 记录版本、参数和 SHA-256，版本不可静默覆盖。

## 4. 正式提交状态机

```text
QUEUED → JUDGING → FINISHED
                      ├─ AC
                      ├─ WA
                      ├─ TLE / MLE
                      ├─ RE / CE
                      └─ SYSTEM_ERROR
```

提交服务依次校验：登录用户、比赛状态、题目归属、语言 allowlist、源码 UTF-8 大小、每用户限速与幂等键。数据库短事务提交后才开始编译运行，Judge 调用不进入数据库事务。

当前 `JudgeAdapter` 直接调用服务器本机编译器/解释器，足以完成课程项目和核心功能验收。若用于公网对抗环境，应保持 Adapter 接口不变，将执行层替换为容器/cgroup/nsjail；这不会改变 Browser Runtime 或 Submission API。

## 5. 数据与恢复

关系型主链路数据库使用 SQLite WAL：

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

核心表包括 users、contests、problems、oj_submissions。`(user_id, client_request_id)` 唯一约束避免网络重试重复建单。OJ Core 启动后恢复 QUEUED/JUDGING 项，并从关系库重建榜单快照。

仓库仍保留早期文档模式数据库和 Worker 表，供旧页面/实验协议兼容；它们不是正式 Submission 的权威来源。新功能不得继续把两套存储混为一条主链路。

## 6. SSE 与榜单

- 单条 Submission SSE 立即推送当前状态，完成时广播 `submission_update`；
- 比赛榜单由内存快照提供，完成事件标记 dirty participant；
- 10 秒窗口合并变化并生成版本号；
- 客户端以 IndexedDB/localStorage 保存 snapshot 与 lease 元数据；
- SSE 断线时以 10～13 秒 jitter polling 兜底；版本缺口要求 full sync；
- OJ Core 重启后从 SQLite 重建，内存缓存不作为权威存储。

## 7. 部署

- PM2 运行 Contestant/OJ Core `:3001` 与 Admin `:3002`；
- Nginx 双域名反代并关闭 SSE buffering；
- Contestant 进程配置 `C_COMPILER=gcc-11`、`CPP_COMPILER=g++-11`；
- Nginx 对 Runtime 资产启用 gzip；
- Runtime 二进制通过 `deploy/fetch-runno-runtime.ps1` 与 `deploy/fetch-pyodide-runtime.ps1` 恢复/校验。

## 8. 非主线遗留模块

`server/src/routes/worker.js`、`worker/` 与相应 lease/HMAC 协议是早期 Trusted Worker 实验。它们可以保留用于研究，但 README、立项书、UI 与核心验收不得再宣称正式判题依赖这些模块。
