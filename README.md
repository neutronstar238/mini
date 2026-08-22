# Mini-OJ —— Chrome 浏览器多语言编译运行与在线评测

Mini-OJ 是一个面向课程与程序设计竞赛的零安装 OJ。选手可直接在桌面 Chrome 的 Web IDE 中运行 C11、C++11、C17、C++17、Python 3.12 和 Java 21；正式提交则由服务器 `JudgeAdapter` 在隔离沙箱中使用隐藏测试，生成唯一有效的 Official Verdict。

项目主线：**Browser Local Run + Server Authoritative Judge**。浏览器结果只用于调试，不上传 Local PASS，不接触隐藏测试，也不参与正式排名。

当前生产环境的六种语言均已开放正式提交；C17/C++17 的 sandbox、GCC 14 编译器证据、真实浏览器、SSE、榜单和旧语言回归已经通过[最终启用验收](./docs/C17_CPP17_FORMAL_SUBMIT_ENABLEMENT.md)。

研究计划见 [plan.md](./plan.md)，接口见 [docs/api.md](./docs/api.md)，正式立项书见 [paper/项目申请书.pdf](./paper/项目申请书.pdf)。

## 架构

```text
Contestant Chrome
  ├─ 自定义输入 / 公开样例 ──> Browser Runtime（Web Worker，本地）
  ├─ 登录设备心跳 ──────────> OJ Core（设备状态 / Admin SSE）
  └─ 正式提交源码 ──────────> OJ Core :3001
                                  ├─ SQLite（唯一 Owner）
                                  ├─ JudgeAdapter（systemd 沙箱权威判题）
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

| 语言 | 浏览器 Runtime | Runtime / Profile ID | 正式 Judge |
|---|---|---|---|
| C11 | Clang 8.0.1 + wasm-ld + WASI libc | `c11-gcc11-compat-v3` | `gcc-11 -O2 -std=c11 ... -lm` |
| C++11 | Clang 8.0.1 + wasm-ld + WASI libc++ | `cpp11-gcc11-compat-v4` | `g++-11 -O2 -std=c++11` |
| C17 | Modern C/C++ Engine v2 · Clang/LLD 19.1.7 | `c17-gcc14-compat-v2` → `cpp-modern-engine-v2` | `/usr/bin/gcc-14 -std=c17 -O2 -Wall -Wextra -DONLINE_JUDGE ... -lm` |
| C++17 | Modern C/C++ Engine v2 · Clang/LLD 19.1.7 | `cpp17-gcc14-compat-v2` → `cpp-modern-engine-v2` | `/usr/bin/g++-14 -std=c++17 -O2 -Wall -Wextra -DONLINE_JUDGE` |
| Python 3.12 | Pyodide 0.26.4 / CPython 3.12.1 | `py312-cpython-compat-v1` | CPython 3.12 |
| Java 21 | BrowserJDK / OpenJDK 21.0.10+7 (Zero) | `java21-browserjdk-compat-v2` | OpenJDK 21 (`javac` / `java`) |

关键边界：

- C11/C++11 与既有冻结 profile 保持不变；C++11 显式使用 `-std=c++11`，C++14 语法不得被本地预检误放行；
- C17/C++17 浏览器编译固定 `-O2`，C++17 禁用 PCH；正式 Judge 只接受精确的 `/usr/bin/gcc-14`、`/usr/bin/g++-14`，没有 GCC 11、通用 `gcc`/`g++` 或 Clang 回退；
- C/C++ stdin 按 UTF-8 字节动态分配，最大 4 MiB，不再受旧 8 KiB 缓冲截断；
- 浏览器本地 stdout/stderr 受限，超限会明确提示；各语言本地运行均在 Web Worker 中执行，超时后中断或终止 Worker，不冻结页面；
- Runtime 使用 self-host、内容版本化 URL、SHA-256 manifest 和 HTTP `immutable` 缓存；
- COOP/COEP 保证比赛页面 `crossOriginIsolated === true`。

冻结基线中，C++11 为 75/75 正向编译、13/13 负向 CE、72/72 确定性输出匹配，C11 共 82 例、Python 共 87 例回归通过。现代 Runtime 的 C17 Compatibility 91/91、Correctness 66/66；C++17 Compatibility 105/105、Correctness 80/80，`bits/stdc++.h` 通过。完整结果见 [兼容性总表](./docs/compatibility.md)、[C11 冻结报告](./docs/runtime-c11-final-freeze-report.md)、[Python 冻结报告](./docs/runtime-python-final-freeze-report.md)、[Java 21 冻结报告](./docs/runtime-freeze-java21-v2.md)、[Modern Runtime Checkpoint 2](./docs/MODERN_CPP_PHASE8_CHECKPOINT_2.md)、[C17 兼容性报告](./docs/c17-gcc14-compatibility-report.md)、[C++17 兼容性报告](./docs/cpp17-gcc14-compatibility-report.md)和 [C17/C++17 正式提交验收](./docs/C17_CPP17_FORMAL_SUBMIT_ENABLEMENT.md)。

## 本地启动

要求：Node.js 16+。浏览器本地运行依赖仓库内的自托管 Runtime 资产；正式 Judge 还需要 Linux、systemd、GCC/G++ 11、精确路径 `/usr/bin/gcc-14` 与 `/usr/bin/g++-14`、CPython 3.12 和 OpenJDK 21。

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
$env:JUDGE_SANDBOX_MODE="direct-test"
node src/app.js
```

`direct-test` 仅用于非生产本地开发，并会在 `NODE_ENV=production` 下被拒绝；Windows 本地无法复现生产 systemd 沙箱，且 C17/C++17 Official Judge 仍要求上述 Linux GCC 14 精确路径。生产环境必须使用 `JUDGE_SANDBOX_MODE=systemd` 与 `JUDGE_SANDBOX_REQUIRED=1`。

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

1. 选手打开题目，选择 C11、C++11、C17、C++17、Python 3.12 或 Java 21；语言切换会同步更新顶部 Runtime 环境状态；
2. “运行代码”使用自定义 stdin，纯浏览器本地执行；
3. “运行样例”本地逐项对比公开输入输出；
4. “正式提交”只上传源码、语言和幂等键；
5. OJ Core 写入权威 `server_received_at`，由 `JudgeAdapter` 在 fail-closed systemd 沙箱中执行隐藏测试；
6. 状态经 SSE 推送，断线时使用轮询兜底；正式结果进入提交记录和榜单。

## 测试

服务器运行后执行：

```powershell
cd server

# 旧语言正式提交主链路：含 C11/C++11/Python 3.12 的 AC、WA、CE、RE、TLE 等
npm run test:e2e -- http://localhost:3001

# 真实 Chrome Browser Runtime 边界：C++11、长 stdin、大输出、缓存头
npm run test:web-runtime -- http://localhost:3001

# Scoreboard / SSE / Cache Lease / Rejudge
node ..\scripts\e2e\phase5-scoreboard-sse.js http://localhost:3001
```

仓库根目录还可执行关键静态/回归门禁：

```powershell
node server/test/language-preview.test.js
node server/test/judge-sandbox.test.js
node server/test/gcc14-header-check.test.mjs
node scripts/verify-modern-runtime-v2-overlay.mjs
node scripts/verify-modern-runtime-evidence.mjs
```

C17/C++17 正式提交验收器默认只做只读预检；仅在明确准备创建测试提交时附加 `--execute`。用法和生产验收证据见 [C17/C++17 正式提交启用报告](./docs/C17_CPP17_FORMAL_SUBMIT_ENABLEMENT.md)。能力矩阵脚本与冻结数据位于 `compat-tests/`，压力测试位于 `scripts/stress/`。

## 生产部署

部署采用 PM2 双进程 + Nginx 双域名。脚本会把 Contestant 指向 3001、Admin 指向 3002，并为 Runtime 大文件启用 gzip 与版本化长缓存。

```powershell
powershell -ExecutionPolicy Bypass -File deploy/deploy-server.ps1
```

生产 Contestant 进程应配置：

```text
APP_ENTRY=contest
PORT=3001
C_COMPILER=/usr/bin/gcc-11
CPP_COMPILER=/usr/bin/g++-11
JAVA_JAVAC_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/javac
JAVA_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/java
JUDGE_SANDBOX_MODE=systemd
JUDGE_SANDBOX_REQUIRED=1
```

C17/C++17 的 JudgeAdapter 会另外强制使用 `/usr/bin/gcc-14` 与 `/usr/bin/g++-14`。承载 OJ Core 的服务账户必须具备启动 transient systemd unit 及准备隔离工作目录的权限；缺少沙箱或精确编译器时判题 fail closed，不会回退到裸 `child_process`。Runtime 资产、版本升级与 COOP/COEP 要求详见 [deploy/RUNNO-RUNTIME.md](./deploy/RUNNO-RUNTIME.md)，增量发布与回滚记录见 [Phase 9 部署报告](./docs/PHASE9_INCREMENTAL_RUNTIME_DEPLOYMENT.md)。

## 信任边界

| 内容 | 权威性 |
|---|---|
| Local stdout、Local Sample Passed、浏览器耗时 | 仅调试，不可信 |
| 浏览器 Runtime ID / hash | 仅诊断，不可信 |
| `server_received_at`、隐藏测试、JudgeAdapter verdict | 正式权威 |

生产 `JudgeAdapter` 强制经过 transient systemd unit：非特权用户、私有 network/IPC/tmp/devices、只读受保护系统路径、隐藏部署目录、环境变量白名单、空 capabilities、`NoNewPrivileges`、系统调用限制，以及 cgroup memory/swap/task、CPU/runtime/file/output 限制。沙箱不可用时返回系统错误并停止判题，不存在生产裸进程回退。浏览器本地结果始终不可信，隐藏测试只在服务器隔离边界内读取。

## 目录

```text
├─ server/                 OJ Core、Admin、Web IDE、JudgeAdapter、SQLite
├─ compat-tests/           Browser/GCC/CPython/OpenJDK 兼容矩阵与基线
├─ scripts/e2e/            正式提交、SSE、榜单 E2E
├─ scripts/stress/         负载测试
├─ deploy/                 PM2、Nginx、运行时资产恢复脚本
├─ docs/                   架构、接口与 Runtime 冻结报告
├─ paper/                  项目立项书与实践报告
└─ worker/                 早期实验实现；不属于本期主链路
```
