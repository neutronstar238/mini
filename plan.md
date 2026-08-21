# 在线评测系统（OJ）——Chrome 浏览器多语言编译运行与服务器权威判题

## 项目研究计划 / 实现总纲

> 项目周期：8 天，单人项目。项目主线为 **Browser Local Run + Server JudgeAdapter**。
> Windows Judge Worker、WSL2 Worker、客户端可信判题不属于本期验收范围，仅保留为后续实验方向。

## 1. 立项问题

传统 OJ 即使只运行公开样例或测试自定义输入，也要把源码发送到服务器编译执行，带来排队等待、服务端计算开销和本地环境不一致三个问题。本项目把高频调试下沉到浏览器：选手只需桌面 Chrome，即可在 Web IDE 内完成 C11、C++11、Python 3 的编译或解释执行。

浏览器完全不可信，因此本地结果只用于调试。正式提交仍将源码发往 OJ Core，由服务器 `JudgeAdapter` 在隐藏测试上生成唯一有效的 AC、WA、TLE、MLE、RE 或 CE。

## 2. 本期目标

完成以下可演示闭环：

```text
登录 → 进入比赛 → 打开题目 → Web IDE 编写代码
  ├─ 运行代码：自定义 stdin，浏览器本地执行
  ├─ 运行样例：公开样例，浏览器本地逐项比较
  └─ 正式提交：源码发送服务器 → JudgeAdapter → Official Verdict
                                      └─ SSE / 轮询 → 提交记录与榜单
```

本期优先级：

1. Web 端 C11、C++11、Python 3 编译运行正确、快速且不冻结 UI；
2. Local 与 Official 的信任边界明确，隐藏测试永不进入浏览器；
3. 选手端、管理端、提交、判题、榜单构成可部署的完整 MVP；
4. 运行时版本可冻结、可校验、可在新机器复现。

## 3. 明确不做

- 不把选手电脑或浏览器作为正式 Judge；
- 不下发隐藏测试，不上传或采信 Local PASS；
- 不开发 Windows Judge Worker、WSL2 bootstrap 或 Local Agent；
- 不把 Docker、nsjail、分布式 Worker 集群列为本期验收条件；
- 不实现 PostgreSQL、Redis、消息队列或 Kubernetes；
- 不承诺 Browser Runtime 与服务器 GCC/CPython 在所有系统 API 上完全一致。

## 4. 总体架构

### 4.1 Contestant Web（Chrome）

- 题面、代码编辑器、语言选择、自定义输入、公开样例；
- C/C++ 与 Python 均运行在独立 Web Worker；
- 本地草稿按用户、比赛、题目隔离；
- 本地运行不发源码请求，正式提交才上传源码；
- 本地耗时仅作参考，不用于正式 TLE。

### 4.2 OJ Core（`:3001`）

- 唯一 SQLite Owner；
- 用户、比赛、题目、Submission 与权威 `server_received_at`；
- `JudgeAdapter` 正式判题，状态机为 `QUEUED → JUDGING → FINISHED`；
- SSE 提交更新、榜单内存快照、10 秒批量更新和轮询兜底；
- Internal Admin API、限流和审计。

### 4.3 Admin（`:3002`）

- 管理比赛、题目、提交与重判；
- 通过 OJ Core 的 Internal API 改变正式状态；
- 不直接打开 SQLite，不创建第二个 Scheduler。

## 5. Browser Runtime 冻结方案

| 语言 | 浏览器实现 | 冻结版本 | 正式参考 |
|---|---|---|---|
| C++11 | 自托管 Clang 8.0.1 + wasm-ld + WASI libc++ | `cpp11-gcc11-compat-v4`，显式 `-std=c++11` | `g++-11 -std=c++11` |
| C11 | 自托管 Clang 8.0.1 + wasm-ld + WASI libc | `c11-gcc11-compat-v3`，显式 `-std=c11` | `gcc-11 -std=c11 -lm` |
| Python 3 | Pyodide 0.26.4 / CPython 3.12.1 | `py312-cpython-compat-v1` | CPython 3.12 |

核心实现：

- C/C++ 使用常驻 Compiler Worker、常驻 VFS/sysroot、Compile Once Run Many；
- 仅显式包含 `bits/stdc++.h` 时使用 PCH，避免 PCH 改变声明可见性；
- C++ 增加 GCC11 Header Strict Check，减少浏览器误放行漏头代码；
- Python 使用常驻 Pyodide Worker、源码编译缓存和每次运行状态重置；
- 运行时资源 self-host，通过版本化 URL 和 HTTP `immutable` 缓存；
- 页面启用 COOP/COEP，保证 SharedArrayBuffer 超时中断能力；
- C/C++ stdin 按 UTF-8 动态分配，最大 4 MiB；C/C++ 与 Python 的 stdout/stderr 各限制 1 MiB，并明确提示截断；
- C/C++ 和 Python 超时均终止执行 Worker，不能冻结主 UI。

## 6. 信任与数据边界

| 数据或结果 | 是否可信 | 用途 |
|---|---:|---|
| Browser Local stdout / elapsed time / Sample Passed | 否 | 仅选手调试 |
| Browser Runtime ID / artifact hash | 否 | 诊断和复现 |
| 服务器 `server_received_at` | 是 | 截止时间、罚时、排序 |
| 服务器隐藏测试 | 是 | 仅正式判题 |
| `JudgeAdapter` Official Verdict | 是 | 提交记录与榜单 |

正式提交以 `(user_id, client_request_id)` 唯一约束保证网络重试幂等。源码最大 256 KiB，同一用户正式提交限速 1 次/秒。Local Run 不请求服务器，因此不占用正式判题队列。

## 7. 功能范围

### 7.1 选手端

- 登录与比赛列表；
- 题目浏览与用户隔离的本地草稿；
- C11、C++11、Python 3 本地运行和公开样例；
- 正式提交、提交记录、状态更新；
- ICPC 榜单、Solved/Penalty 和逐题统计。

### 7.2 管理端

- 管理员登录、比赛与题目维护；
- 隐藏测试仅服务器保存；
- 提交查看、重判与审计；
- 系统与队列状态展示。

## 8. 8 天实施计划

| 日期 | 工作 | 验收 |
|---|---|---|
| D1 | 范围与信任边界冻结，Runno/Pyodide 技术验证 | Chrome 中三语言 Hello World 与 stdin/stdout 成功 |
| D2 | C++11 Compiler Worker、WASI、PCH、缓存 | 自定义输入、公开样例、超时终止可用 |
| D3 | GCC11 兼容矩阵与严格头文件检查 | 正向、负向、确定性输出回归通过 |
| D4 | C11 独立语言配置与数学库验证 | C11 能力矩阵全通过，不破坏 C++ |
| D5 | Pyodide Worker、状态重置、缓存和中断 | Python 正向、异常、隔离和内存压力通过 |
| D6 | Web IDE 与三语言统一接口 | 运行代码、运行样例、正式提交明确分离 |
| D7 | OJ Core、JudgeAdapter、SSE、榜单、Admin | 选手和管理员主链路贯通 |
| D8 | 部署、E2E、边界回归与文档 | 空白 Chrome 完成三语言运行和正式 AC |

## 9. 验收标准

| 验收项 | 标准 |
|---|---|
| 零安装 | 客户端仅需支持版本的桌面 Chrome |
| 三语言 | C11、C++11、Python 3 可直接在 Web IDE 编译/运行 |
| 标准约束 | C++14 泛型 lambda 在 C++11 模式必须 CE |
| 输入边界 | 10,000 字节回归完整，最大支持 4 MiB，不静默截断 |
| 输出边界 | 每个输出通道超过 1 MiB 时截断并提示，页面不失去响应 |
| 兼容性 | C++ 75/75 正向、13/13 负向、72/72 确定性输出；C11 82 例；Python 87 例全部通过 |
| 超时 | 无限循环可中断或终止 Worker，主页面继续可用 |
| 正式判题 | C、C++、Python 提交均由服务器 JudgeAdapter 正常返回 Official Verdict |
| 隐藏测试 | 浏览器 Network、Cache 和 Bundle 中均不存在隐藏测试 |
| 幂等与时间 | `clientRequestId` 防重复提交，`server_received_at` 为权威时间 |
| 实时状态 | SSE 正常更新，断线时轮询兜底 |
| 部署复现 | Runno/Pyodide 资产可校验；版本化资源使用 immutable 缓存 |

## 10. 已知限制与后续优化

- 浏览器 Clang/WASI 与服务器 GCC/Linux 的 ABI、系统调用和极端浮点行为可能不同；正式结果始终以服务器为准；
- 首次加载 C/C++ 工具链约 50 MiB、Python Runtime 约 13.2 MiB，需依赖 gzip、版本化缓存与赛前预热；
- 当前 `JudgeAdapter` 适合课程项目与功能验收，若进入公网对抗环境，应在保持接口不变的前提下替换为容器/cgroup/nsjail 沙箱；
- Windows Judge Worker、分布式 Scheduler、PostgreSQL/Redis 和更多语言均为 P2，不影响本期核心验收。

## 11. 交付物

- 可部署的 Contestant Web、Admin Web 与 OJ Core；
- C11、C++11、Python 3 Browser Runtime 与冻结 manifest；
- 服务器 `JudgeAdapter` 正式判题链路；
- Runtime 能力矩阵、边界 E2E、提交判题 E2E、SSE/榜单回归；
- Nginx/PM2 部署脚本、运行时资产恢复与校验脚本；
- README、架构/接口/Runtime 报告与项目立项申请书。
