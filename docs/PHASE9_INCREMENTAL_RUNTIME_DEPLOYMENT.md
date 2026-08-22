# Phase 9 — Existing Production Server Incremental Runtime Update

## 结论

- 状态：`PRODUCTION_RUNTIME_UPDATE = PASS`
- 生产地址：<https://contest.mini.nstarzx.cn>
- 管理端：<https://admin.mini.nstarzx.cn>
- 现有部署：已识别并原地增量更新；未创建平行 OJ
- 最终 Release：`20260822T021555Z-b6e04e8-phase9r5`
- Git 基线：`b6e04e89bec4cf3e1ac80023a673ab4d1dc27700`
- 数据库迁移：`NO`
- Rollback：`READY`

## Existing deployment detected

生产服务原先由 PM2 管理，而不是 systemd：

- `mini-oj-contest`：`/www/wwwroot/contest.mini.nstarzx.cn`，端口 3001
- `mini-oj-admin`：`/www/wwwroot/admin.mini.nstarzx.cn`，端口 3002
- 文档库：`/www/wwwroot/contest.mini.nstarzx.cn/data/mini-oj.db`
- OJ Core 关系库：`/www/wwwroot/contest.mini.nstarzx.cn/data/oj-main-path.db`
- Nginx：`/www/server/panel/vhost/nginx`
- 日志：`/root/.pm2/logs`、`/www/wwwlogs`

部署沿用既有 PM2 流程，没有引入 Docker、Kubernetes、systemd 或新的代理层。

## Backup

首次生产写入前完成最小备份：

`/www/backups/mini-oj/pre-runtime-update-backup-20260822T013803Z`

备份包含：

- contest/admin 当前应用包
- PM2 dump 与生产进程环境证据
- production profile 与 runtime manifests
- Nginx 配置
- 两个 SQLite 数据库的在线 `.backup`
- SHA-256 清单

备份共 58 个文件，79,163,244 bytes。两个 SQLite 备份均通过 `PRAGMA integrity_check`。清单内容文件全部通过校验；清单文件自身未作为自校验目标。

## Release history and rollback

保留的 Phase 9 release 包括：

- `20260822T013719Z-b6e04e8-phase9`
- `20260822T014601Z-b6e04e8-phase9r1`
- `20260822T015104Z-b6e04e8-phase9r2`
- `20260822T015205Z-b6e04e8-phase9r3`
- `20260822T020900Z-b6e04e8-phase9r4`
- `20260822T021555Z-b6e04e8-phase9r5`（当前）

每次修复都生成新的不可变 release 快照；同步时排除生产 `data/`、`node_modules/`、Legacy Runno/Pyodide 目录和已单独发布的版本化 runtime 目录。旧 release、生产配置、数据库备份和历史 runtime 均仍可用于回滚。

## Updated files

本轮只推送 Runtime/Profile/Judge/Web IDE 所需文件，主要包括：

- `server/src/language-profiles.js`
- `server/src/judge/judge-adapter.js`
- `server/src/app.js`
- `server/src/routes/contest.js`
- `server/src/routes/internal-admin.js`
- `server/public/js/contest/ide-runner.js`
- `server/public/js/contest/ide-wasi-worker-modern.js`
- `server/public/js/contest/ide-wasi-execution-worker-modern.js`
- `server/public/js/contest/gcc14-header-check.js`
- `server/public/js/contest/runtime-assets.js`
- `server/public/js/contest/runtime-info.js`
- `server/public/js/contest/problem-detail.js`
- `server/views/contest/problem-detail.ejs`
- `server/public/js/runtime/java21-browserjdk-compat-v2/*`
- `server/public/js/runtime/cpp-modern-engine-v2/*`

生产 Chrome 发现并修复了两项小范围集成问题：

1. Modern 自动超时同时带 `aborted` 标志时，UI 曾错误显示为手动中断；r4 改为优先展示真实 Local Timeout。
2. Java/Python 异步状态曾覆盖其他语言的顶部环境文字；r5 将状态按语言隔离保存，并在 selector 变更时渲染当前语言的真实环境/加载阶段。

没有更改冻结 Runtime binary、Worker ABI、Loader protocol 或资产 hash。

## Preserved files and configuration

- production `.env`、Session Secret、Admin credentials：保留
- 生产数据库：保留，未覆盖、未重建
- Nginx/HTTPS/domain/ports：保留
- Nginx contest 配置 SHA-256：`ff586e7e0f754c175bd45e230b3c4d6f37cd2ab270728580dd2b0b60d5aa92cf`
- Nginx admin 配置 SHA-256：`705e1b0920b1107c4477c59e8e56b441cf3da13f48af650196fc096ea17c2241`
- C11/C++11/Python Legacy Runtime binary：部署前后 SHA-256 不变
- `cpp-modern-engine-v1`：保留为历史证据/回滚，不再作为 Profile 默认引擎

## Database

- Migration：`NO`
- `mini-oj.db` integrity：`ok`
- `oj-main-path.db` integrity：`ok`
- users：6 → 6
- contests：4 → 4
- problems：6 → 6
- submissions：53 → 69

提交数的增加仅来自既有测试比赛 `Browser OJ E2E Test` 的正式判题回归；用户、比赛、题目数量无下降，未修改正式比赛成绩。

## Runtime IDs and profiles

| Language | Status | Browser Runtime | Formal Submit |
|---|---|---|---|
| C11 | FINAL_FROZEN | `c11-gcc11-compat-v3` | enabled |
| C++11 | FINAL_FROZEN | `cpp11-gcc11-compat-v4` | enabled |
| Python 3.12 | FINAL_FROZEN | `py312-cpython-compat-v1` | enabled |
| Java 21 | BETA_FROZEN | `java21-browserjdk-compat-v2` | enabled |
| C17 | BETA | `c17-gcc14-compat-v2` → `cpp-modern-engine-v2` | disabled |
| C++17 | BETA | `cpp17-gcc14-compat-v2` → `cpp-modern-engine-v2` | disabled |

`cpp20` 与 `cpp23` 未出现在生产 Profile API 或 UI，直接 Profile API 返回 404。

## Runtime asset verification

### Java 21 v2

- Manifest/runtime asset hash：`eee8298d267c2ba781cc6db4d587e6a8a2a39ff8aac5692f1c3a3d01daee5878`
- 验证资产：7/7
- `browserjdk.wasm`、`browserjdk.data`、`browserjdk.mjs`、`loader.mjs`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`LINKED_COMPONENTS.json` 均按 bytes + SHA-256 验证
- Browser Runtime：OpenJDK 21.0.10+7 (Zero)，self-built BrowserJDK
- Server Official Judge：OpenJDK 21.0.11 / javac 21.0.11
- Legal Review：PENDING；`redistributable=false` 保持不变

### Modern C/C++ v2

- Engine：`cpp-modern-engine-v2`
- Canonical manifest hash：`8abec83e8375d5bd985f9c6fef62b2a3b3799bc7be52a89133c2689a19908419`
- Clang/LLD：19.1.7，WASI，固定 `-O2`
- v2 overlay、execution worker、bits header、manifest/evidence 通过 deterministic 验证
- v2 manifest 声明的 v1 immutable compiler/sysroot 继承资产保持原版本路径和 hash；这是已验收的 manifest 继承，不是 Profile 默认回退

### Production HTTP

- Manifest assets：34/34 HTTP 200
- WASM 检查：5/5 `application/wasm`
- bytes：全部匹配
- SHA-256：全部匹配
- versioned runtime：`Cache-Control: public, max-age=31536000, immutable`
- COOP：`same-origin`
- COEP：`require-corp`

## Production Browser E2E

测试使用真实 Chrome 151 和真实线上域名，不使用 localhost harness。

### Legacy regression

- C11 A+B：PASS
- C++11 A+B：PASS
- Python 3.12 A+B：PASS
- C11 CE：PASS
- Python RE：PASS
- C11 Sample 1：PASS
- C++11 artifact cache：PASS

### Java 21 browser

12/12：

- HelloWorld
- A+B BufferedReader
- A+B Scanner
- FastScanner
- EOF input
- CE
- ArithmeticException
- 6000ms Local Timeout
- timeout recovery (`ALIVE`)
- source cache hit（第二次未重新编译）
- Sample 1 Passed
- Custom Input

标准 `public class Main` 路径全部通过。冻结 BrowserJDK 对 package-private `class Main` 的反射访问会报 `IllegalAccessException`；本轮没有为此修改冻结 binary/ABI。

### C17 browser

4/4：A+B、Local Timeout、timeout recovery (`ALIVE-C17`)、Sample 1 Passed。编译/链接/执行均走 `cpp-modern-engine-v2`，`-std=c17 -O2`。

### C++17 browser

12/12：iostream A+B、`bits/stdc++.h`、structured bindings、`if constexpr`、`optional`、`variant`、`string_view`、`priority_queue`、cache hit、Local Timeout、timeout recovery (`ALIVE-CPP17`)、Sample 1 Passed。

Modern 第二次同源码运行显示“使用已编译缓存（未重新编译）”，输出从 8 正确变为 30。

## Runtime status UI verification

Java 初始化为 Ready 后，真实 Chrome 中逐项切换 selector：

- C11 → `C11 Browser Runtime: Ready (Runno 0.10.0)`
- C++11 → `C++11 Browser Runtime: Ready (Runno 0.10.0)`
- C17 → `C17 Browser Runtime: Ready (Modern C/C++ Engine v2 · Clang/LLD 19.1.7)`
- C++17 → `C++17 Browser Runtime: Ready (Modern C/C++ Engine v2 · Clang/LLD 19.1.7)`
- Python → Python 自身 Preparing/Ready 状态与 Interrupt capability
- Java → `Java 21 Runtime: Ready (OpenJDK 21.0.10+7 (Zero)) · Interrupt READY`

异步 Java/Python callback 不再覆盖当前选中的其他语言。

## Official Judge E2E

既有测试比赛内完成：

- C11 AC：PASS
- C++11 AC：PASS
- Python AC：PASS
- Java AC/WA/CE/RE：PASS
- 状态链：QUEUED/JUDGING → FINISHED：PASS
- Submission SSE：JUDGING → FINISHED，无刷新更新：PASS
- Java Browser A+B 与 Server OpenJDK21 stdout：一致

Java 编译命令参数中曾发现重复 `javac`，已在 judge adapter 修正并重测。

## GCC14 Judge smoke

- `/usr/bin/gcc-14`：14.2.0
- `/usr/bin/g++-14`：14.2.0
- Legacy `/usr/bin/gcc-11`、`/usr/bin/g++-11` 保持 11.5.0
- 未修改系统 gcc/g++ alternatives
- C17 JudgeAdapter direct smoke：AC
- C++17 JudgeAdapter direct smoke：AC
- C++17 `bits/stdc++.h` JudgeAdapter direct smoke：AC
- Production Formal Submit gate：C17/C++17 均保持 disabled，因此没有经生产 Submit API 创建 Beta submission

## Network isolation and cache behavior

在一次真实 C++17 Local Run + 同源码 cache run 前后截取 Nginx access log：

- `/api/contest/.../submissions` POST：0
- source/stdin/stdout/stderr 上传：0
- 大型 runtime `.wasm/.data/.tar` 重新下载：0
- 仅出现允许的 device heartbeat，以及 disposable execution worker GET
- 第二次运行：`cacheHit=true`，未重新编译，输出 42

Java/Python Runtime Details 在真实 Chrome 显示：

- WebAssembly ✓
- Web Worker ✓
- SharedArrayBuffer ✓
- `crossOriginIsolated` ✓
- `Atomics.store` ✓
- Cache Storage ✓
- IndexedDB ✓

## Runtime Info and existing features

- `/contest/runtime-info`：6 个生产 Profile，版本/状态真实
- C++20/C++23：未显示
- Login：PASS
- Contest：PASS
- Problem list：PASS
- Problem detail：PASS
- Submission list：PASS
- Scoreboard：PASS；页面显示 SSE 与 lease 有效
- Admin login/health：PASS
- contest/admin `/healthz`、`/readyz`：PASS

## Verification commands/results

- Node tests：14/14 PASS
- Java v2 asset verifier：7/7 PASS
- Modern v1 immutable inventory：18/18 PASS
- Modern v2 overlay deterministic/evidence：PASS
- Production HTTP runtime verifier：34 assets / 5 WASM PASS
- `git diff --check`：PASS

## Logs

部署及完整自测后扫描：

- PM2 contest error tail suspicious matches：0
- PM2 admin error tail suspicious matches：0
- Nginx contest error tail suspicious matches：0
- Nginx admin error tail suspicious matches：0

未发现 uncaught exception、runtime asset 404、WASM MIME/COEP 错误、uncontrolled SQLite busy、missing compiler 或 migration failure。

## Blocking failures

无。
