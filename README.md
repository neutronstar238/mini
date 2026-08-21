# Mini-OJ —— Chrome 浏览器多语言编译运行与在线评测

Mini-OJ 是一个面向课程与程序设计竞赛的零安装 OJ。选手可直接在桌面 Chrome 的 Web IDE 中编译、运行 C11/C++11，或运行 Python 3；正式提交则由服务器 `JudgeAdapter` 使用隐藏测试生成唯一有效的 Official Verdict。

项目主线：**Browser Local Run + Server Authoritative Judge**。浏览器结果只用于调试，不上传 Local PASS，不接触隐藏测试，也不参与正式排名。

研究计划见 [plan.md](./plan.md)，接口见 [docs/api.md](./docs/api.md)，正式立项书见 [paper/项目申请书.pdf](./paper/项目申请书.pdf)。

## 架构

```text
Contestant Chrome
  ├─ 自定义输入 / 公开样例 ──> Browser Runtime（Web Worker，本地）
  ├─ 登录设备心跳 ──────────> OJ Core（设备状态 / Admin SSE）
  └─ 正式提交源码 ──────────> OJ Core :3001
                                  ├─ SQLite（唯一 Owner）
                                  ├─ JudgeAdapter（权威判题）
                                  ├─ SSE / Scoreboard
                                  └─ Internal Admin API

Admin Web :3002 ─────────────> OJ Core Internal API
```

| 入口 | 默认端口 | 职责 |
|---|---:|---|
| Contestant / OJ Core | 3001 | 题目、Web IDE、提交、JudgeAdapter、SSE、榜单、SQLite |
| Admin | 3002 | 比赛/题目/提交/重判管理；不直连 SQLite |

客户端设备管理以登录后的 Chrome 浏览器为对象：浏览器本地保存匿名设备 ID，定时向 OJ Core 上报心跳与运行环境；OJ Core 持久化首次/最后在线时间并判定在线、离线，通过 `client_device_update` SSE 事件实时更新 `/admin/devices`。设备信息仅用于运维诊断，不参与正式 Judge，也不改变浏览器不可信的安全边界。

## Browser Runtime

| 语言 | 浏览器 Runtime | 冻结 ID | 正式 Judge 参考 |
|---|---|---|---|
| C++11 | Clang 8.0.1 + wasm-ld + WASI libc++ | `cpp11-gcc11-compat-v4` | `g++-11 -std=c++11` |
| C11 | Clang 8.0.1 + wasm-ld + WASI libc | `c11-gcc11-compat-v3` | `gcc-11 -std=c11 -lm` |
| Python 3 | Pyodide 0.26.4 / CPython 3.12.1 | `py312-cpython-compat-v1` | CPython 3.12 |

关键边界：

- C++ 编译显式使用 `-std=c++11`，C++14 语法不得被本地预检误放行；
- C/C++ stdin 按 UTF-8 字节动态分配，最大 4 MiB，不再受旧 8 KiB 缓冲截断；
- C/C++ 与 Python 的 stdout/stderr 各限制为 1 MiB，超限会明确提示；
- 两条运行链都在 Web Worker 中执行，超时后中断或终止 Worker，不冻结页面；
- Runtime 使用 self-host、内容版本化 URL、SHA-256 manifest 和 HTTP `immutable` 缓存；
- COOP/COEP 保证比赛页面 `crossOriginIsolated === true`。

C++ 兼容性基线：75/75 正向编译、13/13 负向 CE、72/72 确定性输出匹配。C11 共 82 例、Python 共 87 例回归通过。完整结果见 [docs/compatibility.md](./docs/compatibility.md)、[docs/runtime-c11-final-freeze-report.md](./docs/runtime-c11-final-freeze-report.md) 和 [docs/runtime-python-final-freeze-report.md](./docs/runtime-python-final-freeze-report.md)。

## 本地启动

要求：Node.js 16+；正式提交 C/C++ 还需要服务器本机可用的 `gcc`/`g++`（生产部署固定为 `gcc-11`/`g++-11`）。

```powershell
cd server
npm install
```

若运行时资产尚不存在，在仓库根目录恢复并校验：

```powershell
.\deploy\fetch-runno-runtime.ps1 -Source "D:\已有的Runno运行时\langs"
.\deploy\fetch-pyodide-runtime.ps1

.\deploy\fetch-runno-runtime.ps1 -VerifyOnly
.\deploy\fetch-pyodide-runtime.ps1 -VerifyOnly
```

启动 OJ Core：

```powershell
cd server
$env:APP_ENTRY="contest"
$env:PORT="3001"
$env:C_COMPILER="gcc"
$env:CPP_COMPILER="g++"
node src/app.js
```

另开终端启动 Admin：

```powershell
cd server
$env:APP_ENTRY="admin"
$env:PORT="3002"
$env:CORE_BASE_URL="http://127.0.0.1:3001"
$env:INTERNAL_API_SECRET="dev-secret"
node src/app.js
```

访问 `http://localhost:3001` 与 `http://localhost:3002`。开发种子账号：选手 `user1/user123`，管理员 `admin/admin123`。

## 核心流程

1. 选手打开题目，选择 C11、C++11 或 Python 3；
2. “运行代码”使用自定义 stdin，纯浏览器本地执行；
3. “运行样例”本地逐项对比公开输入输出；
4. “正式提交”只上传源码、语言和幂等键；
5. OJ Core 写入权威 `server_received_at`，由 `JudgeAdapter` 执行隐藏测试；
6. 状态经 SSE 推送，断线时使用轮询兜底；正式结果进入提交记录和榜单。

## 测试

服务器运行后执行：

```powershell
cd server

# 正式提交主链路：含 C/C++/Python 的 AC、WA、CE、RE、TLE 等
npm run test:e2e -- http://localhost:3001

# 真实 Chrome Browser Runtime 边界：C++11、长 stdin、大输出、缓存头
npm run test:web-runtime -- http://localhost:3001

# Scoreboard / SSE / Cache Lease / Rejudge
node ..\scripts\e2e\phase5-scoreboard-sse.js http://localhost:3001
```

能力矩阵脚本与冻结数据位于 `compat-tests/`；压力测试位于 `scripts/stress/`。

## 生产部署

部署采用 PM2 双进程 + Nginx 双域名。脚本会把 Contestant 指向 3001、Admin 指向 3002，并为 Runtime 大文件启用 gzip 与版本化长缓存。

```powershell
powershell -ExecutionPolicy Bypass -File deploy/deploy-server.ps1
```

生产 Contestant 进程应配置：

```text
APP_ENTRY=contest
PORT=3001
C_COMPILER=gcc-11
CPP_COMPILER=g++-11
```

Runtime 资产、版本升级与 COOP/COEP 要求详见 [deploy/RUNNO-RUNTIME.md](./deploy/RUNNO-RUNTIME.md)。

## 信任边界

| 内容 | 权威性 |
|---|---|
| Local stdout、Local Sample Passed、浏览器耗时 | 仅调试，不可信 |
| 浏览器 Runtime ID / hash | 仅诊断，不可信 |
| `server_received_at`、隐藏测试、JudgeAdapter verdict | 正式权威 |

当前 `JudgeAdapter` 足以完成课程项目和核心功能验收。如果进入公网对抗环境，应保持接口不变，将其执行层替换为容器/cgroup/nsjail 等服务器沙箱；这不是本期 Web 编译运行主线的前置条件。

## 目录

```text
├─ server/                 OJ Core、Admin、Web IDE、JudgeAdapter、SQLite
├─ compat-tests/           Browser/GCC/CPython 兼容矩阵与基线
├─ scripts/e2e/            正式提交、SSE、榜单 E2E
├─ scripts/stress/         负载测试
├─ deploy/                 PM2、Nginx、运行时资产恢复脚本
├─ docs/                   架构、接口与 Runtime 冻结报告
├─ paper/                  项目立项书与实践报告
└─ worker/                 早期实验实现；不属于本期主链路
```
