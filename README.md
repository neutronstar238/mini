# Mini-OJ —— Chrome 浏览器多语言编译运行与在线评测

Mini-OJ 是一个面向课程与程序设计竞赛的零安装 OJ。选手可直接在桌面 Chrome 的 Web IDE 中运行 C11、C++11、C17、C++17、Python 3.12 和 Java 21；正式提交则由服务器 `JudgeAdapter` 在隔离沙箱中使用隐藏测试，生成唯一有效的 Official Verdict。

项目主线：**Browser Local Run + Server Authoritative Judge**。浏览器结果只用于调试，不上传 Local PASS，不接触隐藏测试，也不参与正式排名。

当前生产环境的六种语言均已开放正式提交；C17/C++17 的 sandbox、GCC 14 编译器证据、真实浏览器、SSE、榜单和旧语言回归已经通过[最终启用验收](./docs/C17_CPP17_FORMAL_SUBMIT_ENABLEMENT.md)。

研究计划见 [plan.md](./plan.md)，接口见 [docs/api.md](./docs/api.md)。

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
| C++11 | Clang 8.0.1 + wasm-ld + WASI libc++ | `cpp11-gcc11-compat-v5` | `g++-11 -O2 -std=c++11` |
| C17 | Modern C/C++ Engine v2 · Clang/LLD 19.1.7 | `c17-gcc14-compat-v2` → `cpp-modern-engine-v2` | `/usr/bin/gcc-14 -std=c17 -O2 -Wall -Wextra -DONLINE_JUDGE ... -lm` |
| C++17 | Modern C/C++ Engine v2 · Clang/LLD 19.1.7 | `cpp17-gcc14-compat-v2` → `cpp-modern-engine-v2` | `/usr/bin/g++-14 -std=c++17 -O2 -Wall -Wextra -DONLINE_JUDGE` |
| Python 3.12 | Pyodide 0.26.4 / CPython 3.12.1 | `py312-cpython-compat-v1` | CPython 3.12 |
| Java 21 | BrowserJDK / OpenJDK 21.0.10+7 (Zero) | `java21-browserjdk-compat-v2` | OpenJDK 21 (`javac` / `java`) |

关键边界：

- C11 使用冻结的 v3 profile；C++11 使用 v5 profile，显式 `-std=c++11`、保留普通 warning、兼容 Codeforces 常见 `%I64*` 格式，C++14 语法不得被本地预检误放行；
- C17/C++17 浏览器编译固定 `-O2`，C++17 禁用 PCH；正式 Judge 只接受精确的 `/usr/bin/gcc-14`、`/usr/bin/g++-14`，没有 GCC 11、通用 `gcc`/`g++` 或 Clang 回退；
- C/C++ stdin 按 UTF-8 字节动态分配，最大 4 MiB，不再受旧 8 KiB 缓冲截断；
- 浏览器本地 stdout/stderr 受限，超限会明确提示；各语言本地运行均在 Web Worker 中执行，超时后中断或终止 Worker，不冻结页面；
- Runtime 使用 self-host、内容版本化 URL、SHA-256 manifest 和 HTTP `immutable` 缓存；
- COOP/COEP 保证比赛页面 `crossOriginIsolated === true`。

冻结基线中，C++11 为 75/75 正向编译、13/13 负向 CE、72/72 确定性输出匹配，C11 共 82 例、Python 共 87 例回归通过。现代 Runtime 的 C17 Compatibility 91/91、Correctness 66/66；C++17 Compatibility 105/105、Correctness 80/80，`bits/stdc++.h` 通过。完整结果见 [兼容性总表](./docs/compatibility.md)、[C11 冻结报告](./docs/runtime-c11-final-freeze-report.md)、[Python 冻结报告](./docs/runtime-python-final-freeze-report.md)、[Java 21 冻结报告](./docs/runtime-freeze-java21-v2.md)、[Modern Runtime Checkpoint 2](./docs/MODERN_CPP_PHASE8_CHECKPOINT_2.md)、[C17 兼容性报告](./docs/c17-gcc14-compatibility-report.md)、[C++17 兼容性报告](./docs/cpp17-gcc14-compatibility-report.md)和 [C17/C++17 正式提交验收](./docs/C17_CPP17_FORMAL_SUBMIT_ENABLEMENT.md)。

Codeforces 真实源码回放另外覆盖多种语言与提交结果。已接受语料为 40/40 份源码、515/515 个公开测试输出匹配；扩展语料包含 AC、WA、CE、RE、TLE、MLE 各 10 份。非 AC 的原始 verdict 可能由隐藏测试、时间抖动或 Codeforces 内存计量触发，所以报告只记录浏览器在公开测试上可观测的 `compile_error`、`runtime_error`、`timeout`、`output_mismatch` 或 `all_pass`，不把“未复现”误写成兼容性通过。详见 [Codeforces 兼容性报告](./docs/codeforces-browser-compatibility-report.md)与[混合 Verdict 回放报告](./docs/codeforces-mixed-verdict-browser-report.md)。

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

每次提交必须运行不依赖已启动服务的正式门禁：

```powershell
cd server
npm test
npm run test:runtime-catalog
```

`npm test` 只发现 `*.test.js` 与 `*.test.mjs`，不会误把需要服务进程的 `*.e2e.js` 当成单元测试。涉及 HTTP 路由、正式提交、浏览器 Runtime、SSE 或榜单时，先启动本地 Contestant/OJ Core，再按变更范围执行：

```powershell
cd server

# 健康、就绪、Contest HTML 与六种公开 Runtime profile
npm run test:release-smoke -- http://localhost:3001

# C11/C++11/Python 3.12 正式提交主链路
npm run test:e2e -- http://localhost:3001

# Scoreboard / SSE / Cache Lease / Rejudge
npm run test:scoreboard -- http://localhost:3001

# 真实 Chrome Browser Runtime 边界与 C++11 warning 兼容
npm run test:web-runtime -- http://localhost:3001
npm run test:cpp11-browser -- http://localhost:3001
```

兼容性语料、冻结证据生成器和压力测试不属于普通提交门禁，但必须保留以复现已发布的 Runtime 能力结论。脚本分类规则与长期入口见 [scripts/README.md](./scripts/README.md)。C17/C++17 正式提交验收器默认只做只读预检；仅在明确准备创建测试提交时附加 `--execute`。语料下载或重建属于研究流程，不应放进普通部署门禁。

## API 快速索引

所有正式 HTTP 接口、请求字段、响应示例、鉴权和限流均以 [API 文档](./docs/api.md)为准。常用入口如下：

| 范围 | 基础路径 | 鉴权 | 说明 |
|---|---|---|---|
| 健康检查 | `/healthz`、`/readyz` | 无 | 分别表示进程存活、初始化完成 |
| 公开 Runtime 信息 | `/api/public/*` | 无 | 仅返回脱敏的语言与编译器资料 |
| 选手 API | `/api/contest/*` | HttpOnly `token` Cookie 或 Bearer JWT | 登录、比赛、题目、提交、榜单、设备心跳 |
| 选手 SSE | `/api/contest/contests/:id/events` | Cookie；也兼容 `?token=<JWT>` | 榜单 delta、同步提示和队列状态 |
| Admin API | `/api/admin/*` | 管理员 Cookie 或 Bearer JWT | `:3002` 代理到 OJ Core，不直接访问 SQLite |
| Internal Admin | `/internal/admin/*` | HMAC 内部头 | 仅限 `:3002 → :3001`，不得暴露到公网 |

正式提交端点为 `POST /api/contest/contests/:contestId/submissions`，当前语言值为 `c11`、`cpp11`、`c17`、`cpp17`、`python3`、`java21`。请求只需 `problemId`、`language`、`source`、可选幂等键 `clientRequestId` 和诊断时间 `clientSubmittedAt`；源码上限为 256 KiB UTF-8，同一用户最多 1 次/秒。浏览器本地输出、耗时和 verdict 不属于该请求，也不会被服务器采信。

## 生产部署

### 拓扑与前置条件

生产采用 PM2 双进程与 Nginx 双入口：Contestant/OJ Core 使用 3001，Admin 使用 3002，Nginx 通过 `127.0.0.1` 连接上游；防火墙不应把这两个应用端口直接暴露到公网，外部只开放 HTTPS。OJ Core 是 SQLite 唯一 Owner，Admin 只能通过回环地址上的 Internal Admin API 访问它。

目标服务器需要 Ubuntu 24.04、Node.js 16+、PM2、Nginx、`rsync`、`tar`、`curl`、`openssl`、`sqlite3`、systemd、GCC/G++ 11、GCC/G++ 14、Python 3.12 和 OpenJDK 21。部署账户还需能写入应用/备份/密钥目录、管理 PM2，并有权启动 JudgeAdapter 的 transient systemd units。缺少沙箱或指定编译器时正式 Judge 会 fail closed。

Nginx 必须保留真实 `Host` 与 `X-Forwarded-*`，对 SSE 关闭 `proxy_buffering` 并设置足够长的 `proxy_read_timeout`。Contest 页面及 Runtime 资产必须保留应用返回的 COOP/COEP/CORP 头；`.wasm` 应使用 `application/wasm`，版本化 `/runtime/<engine>/<version>/...` 可长缓存，未版本化兼容路径不可设置 immutable。

### 发布步骤

发布脚本只接受已经提交的 `server/` 工作区。它会生成带 Git 短 SHA 的精确归档，上传到服务器 staging，在重启前使用 SQLite 在线备份两个数据库并分别备份 Contest/Admin 代码，保留 `data/`、`node_modules/` 和站点 `.env`，同步两套应用目录，按 lockfile 安装生产依赖，重启 PM2，最后验证两个进程的 liveness/readiness 和公开 Runtime API。Runtime 发布包必须同时包含 Runno、Pyodide、Java v2、Modern v2 以及 PBDS overlay。

先在仓库根目录完成测试、提交并推送，再执行：

```powershell
git status --short
git push origin main
pwsh -File .\deploy\deploy-server.ps1 `
  -ServerHost <your-ssh-host> `
  -DomainContest contest.example.com `
  -DomainAdmin admin.example.com
```

默认远端布局为 `/var/www/mini-oj/<domain>`、`/var/backups/mini-oj`、`/etc/mini-oj`，Node/PM2 从 `/usr/local/bin` 查找。若服务器布局不同，显式传入 `-RemoteWebRoot`、`-RemoteBackupRoot`、`-RemoteSecretsDir` 和 `-RemoteNodeBin`；这些值只属于部署者自己的命令或 CI Secret，不应提交到仓库。`-ServerHost` 可以是部署者 `~/.ssh/config` 中的别名，也可以是 `user@host`。

脚本首次运行会在 `<RemoteSecretsDir>/mini-oj.env`（默认 `/etc/mini-oj/mini-oj.env`）创建权限为 `0600` 的密钥文件，保存随机生成的 `JWT_SECRET`、`HMAC_SECRET` 和 `INTERNAL_API_SECRET`；密钥不会上传或写入 Git。Contest 与 Admin 必须加载同一组 JWT/Internal 密钥。若此前使用开发默认密钥，首次安全发布会使既有登录 Cookie 失效，用户重新登录即可。

生产 Contestant 进程的关键环境如下；域名和密钥也必须通过环境注入，不能写回源码：

```text
NODE_ENV=production
APP_ENTRY=contest
PORT=3001
DB_FILE=<Contestant 数据目录>/mini-oj.db
C_COMPILER=/usr/bin/gcc-11
CPP_COMPILER=/usr/bin/g++-11
JAVA_JAVAC_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/javac
JAVA_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/java
JUDGE_SANDBOX_MODE=systemd
JUDGE_SANDBOX_REQUIRED=1
```

Admin 使用同一个 `DB_FILE` 值仅为兼容配置，代码不会直接打开它；它还需要 `APP_ENTRY=admin`、`PORT=3002`、`CORE_BASE_URL=http://127.0.0.1:3001`。C17/C++17 的 JudgeAdapter 固定要求 `/usr/bin/gcc-14` 与 `/usr/bin/g++-14`。

### 发布后验证与回滚

服务器本机至少执行：

```bash
curl -fsS http://127.0.0.1:3001/healthz
curl -fsS http://127.0.0.1:3001/readyz
curl -fsS http://127.0.0.1:3002/healthz
curl -fsS http://127.0.0.1:3002/readyz
curl -fsS http://127.0.0.1:3001/api/public/runtime-profiles >/dev/null
pm2 list
```

外部还应检查 HTTPS 登录页、Runtime `.wasm` 的 MIME/cache/COOP/COEP 响应头、一次真实 Chrome Local Run，以及 Admin SSE。脚本成功时输出 `release=<时间>-<Git SHA>` 和备份目录；记录这两项便于审计。

首选回滚方式是在一个干净工作区检出目标提交，重新运行同一发布脚本，保证运行代码与 Git 提交完全一致。紧急情况下可使用脚本输出的 `<RemoteBackupRoot>/<release>/` 代码归档恢复 Contest/Admin；同一目录还包含部署前两个 SQLite 数据库的一致性快照。代码回滚不得覆盖 `data/`；只有 schema 或数据确实需要回退时，才停止 OJ Core、再次备份现状、恢复指定数据库并执行 `PRAGMA integrity_check`。回滚后重复全部 health/readiness 检查。

Runtime 资产、版本升级与 COOP/COEP 细节见 [deploy/RUNNO-RUNTIME.md](./deploy/RUNNO-RUNTIME.md)。`deploy/deploy-remote.sh` 是服务器初始化参考；日常增量发布使用 `deploy/deploy-server.ps1`。真实域名、主机别名、远端目录和发布记录只保存在部署环境，不进入仓库。

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
