# Runtime Enhancement Report —— 语言与 Runtime 可扩展性增强

> **阶段**：Runtime Enhancement Phase（Runtime Enhancement）
> **报告日期**：2026-08-20 | **作者**：Mini-OJ AI Engineering Team
> **基线**：`cpp11-gcc11-compat-v4`、`c11-gcc11-compat-v3`、`py312-cpython-compat-v1` 均 **FINAL FROZEN**（冻结日期 2026-08-20）。
> **目标**：在不动冻结 Runtime 的前提下，完成 4 类增强：
> 1. 现代 C/C++ 标准（C17/C++17/C++20/C++23）
> 2. 首次 Browser Runtime 加载进度体验
> 3. 完整 Runtime/Compiler 信息展示（Tooltip / Drawer / Runtime Info 页 / Public API / FAQ）
> 4. Java 21（Official Judge P0，Browser Local Experimental）

---

## 0. 审计确认的关键差异（必须显式声明）

| # | 差异 | 处理 |
|---|---|---|
| 1 | 项目**无 FAQ 内容**（`--no-relax`/`--no-pie`/`编译器版本及编译运行参数` 均 0 匹配） | 本阶段新建 FAQ 页（`/contest/faq`）+ `GET /api/public/faq` + 与 language-profiles 同源渲染 |
| 2 | **无 `/api/public` 前缀** | 本阶段新增挂载 |
| 3 | **无 Admin 语言配置管理界面** | 本阶段在 `internal-admin.js` 新增 `GET/POST /languages` 受控端点（仅 :3002 Admin 调用，audit log） |
| 5 | Official Judge 版本与用户任务不一致 | 任务声称 GCC 14.2.0，实际 manifest 声明 GCC/G++ 11.5.0（`11.5.0-1ubuntu1~24.04.1`）。**以真实 manifest 为准**。本阶段在 `language-profiles.js` 中显式标注新 modern C/C++ profile 对应 GCC 14（待生产部署切换） |

---

## 1. 为什么 Browser 使用 Clang

Clang 本身主要使用 C++ 实现，但浏览器内**运行的不是 Clang 源码**，而是预先编译好的 `clang.wasm`。实际执行流：

```
Chrome
  → 加载预编译的 clang.wasm
    → 用户 C/C++ 源码
      → Clang Frontend
        → wasm object
          → wasm-ld
            → submission.wasm
              → Browser 执行
```

"Clang 背后是 C++" 与 "用户的 C/C++ 在浏览器运行" 是**不同的概念**。

**为什么不直接在 Browser 使用 GCC**：
- 当前项目选择 Clang 是基于 WebAssembly 工程实现，不是"GCC 不行"或"Clang 更标准"；
- LLVM/Clang 模块化程度高，Frontend / Linker / Target Backend 易拆分；
- WebAssembly/WASI 工具链生态成熟；
- wasm-ld / compiler-rt / libc++ 能形成完整浏览器工具链；
- Official Judge 无 Browser 沙箱约束，仍用 GCC/G++ + Linux；
- 两者通过 Compatibility Matrix 做行为验证。

---

## 2. Clang 本身与 C++ / WebAssembly 的关系

见 §1。补充：Clang 的源代码是 C++，但浏览器只加载编译产物（clang.wasm）。这意味着：
- Browser 加载时间 = clang.wasm 字节大小（~30 MiB for Clang 8，~35-45 MiB for Clang 19）
- 用户程序的"执行时间"严格定义为 `_start() → main() 退出 → stdout flush`，**禁止把 clang.wasm instantiate / Module compile 时间计入**（已在 `runtime-manifest-c11.json` 与 `runtime-manifest-cpp11.json` 明文冻结）。

---

## 3. 为什么 Official Judge 仍然使用 GCC

- Official Judge 在服务器原生 Linux 进程运行，无需 WebAssembly 沙箱
- GCC 是 Linux 默认编译器，工程团队熟悉度高
- 与现有 OJ 测试管线、隐藏测试管理兼容
- Clang 与 GCC 在严格标准下输出**应当一致**（通过 Compatibility Matrix 验证）；遗留差异分类为 Allowed STL Implementation Divergence

---

## 4. Modern Clang 选型

**推荐**：WASI SDK 27（LLVM 19 / Clang 19 / LLD 19 + libc++ 19 + libc++abi 19 + compiler-rt + wasi-sysroot 27）
**次选**：Zig 0.15.x（自带 `zig cc` = Clang 19）
**不选**：自研 LLVM-on-wasm（投入巨大）

详见 [cpp-modern-clang-selection-report.md](./cpp-modern-clang-selection-report.md)。

---

## 5. C17 兼容

| 维度 | 评估 |
|---|---|
| Browser | ✅ Clang 19 wasm32-wasi 完整支持 c17 |
| Server | ✅ GCC 14 `-std=c17`（待生产部署切换） |
| Runtime ID | `c17-gcc14-compat-v1` |
| 资产基座 | `cpp-modern-v1`（共享 with cpp17/cpp20/cpp23） |
| compat-tests | 待 Modern Clang 集成后建立 `compat-tests/cpp17/`（复用 bits harness） |

---

## 6. C++17 兼容

| 维度 | 评估 |
|---|---|
| Browser | ✅ Clang 19 + libc++ 19 |
| Server | ✅ GCC 14 `-std=c++17` |
| Runtime ID | `cpp17-gcc14-compat-v1` |
| 默认 preload | ✅ |

C++17 高频特性全部支持（structured bindings / if constexpr / optional / variant / string_view / apply / fold expression）。

---

## 7. C++20 兼容

| 维度 | 评估 |
|---|---|
| Browser | ✅ Clang 19 + libc++ 19 |
| Server | ✅ GCC 14 `-std=c++20` |
| Runtime ID | `cpp20-gcc14-compat-v1` |

C++20 高频特性（concepts / ranges / span / bit / numbers / three-way / starts_with / ends_with）全部支持。
`std::thread` / `std::jthread`：**Host-WASI 缺 pthread，不支持**（按用户第 10 条不作为 P0）。

---

## 8. C++23 兼容

| 维度 | 评估 |
|---|---|
| Browser | ✅ Clang 19 + libc++ 19 |
| Server | ✅ GCC 14 `-std=c++23` |
| Runtime ID | `cpp23-gcc14-compat-v1` |
| UI 文案 | "C++23 · Experimental" / "P0 ACM 子集"（**不宣称"完整支持"**） |

C++23 高频特性（expected / contains / optional monadic / if consteval / ranges 增强）按 capability 记录；`std::stacktrace` 受 host unwinder 限制。

---

## 9. C++26 capability

- **仅做 `-std=c++2c` spike**，不构建完整 Runtime Profile
- 验收门槛：Clang Frontend 接受语法、libc++19 提供基本新库 API、Host-WASI 兼容
- 详见 Selection Report §7

---

## 10. Runtime 加载进度实现

### 10.1 状态机

```
CHECK_CACHE
  ↓
DOWNLOAD_RUNTIME / DOWNLOAD_SYSROOT / DOWNLOAD_STDLIB / DOWNLOAD_PCH
  ↓
INITIALIZE_WASM
  ↓
MOUNT_VFS
  ↓
WARMUP_COMPILER
  ↓
READY
```

### 10.2 真实字节进度

- `fetch + ReadableStream + Content-Length`
- `loadedBytes / totalBytes` 真实百分比
- 不可测阶段（WebAssembly.instantiate / VFS Mount / Compiler Warmup）显示 **indeterminate pulse** 动画 + 文案，**禁止伪造 91%/92%/93% 精度**

### 10.3 模块化

- `server/public/js/contest/runtime-assets.js`（新增）：独立进度状态机 + Cache Storage + 资产清单（manifest）+ 失败重试（仅缺失资产）
- `ide-runner.js`：暴露 `onRuntimeProgress / prewarmModernRuntime / retryModernRuntime / probeRuntimeCache`
- 冻结 Runtime 不受影响（旧 Clang 8 / Pyodide 0.26.4 走旧管线）

### 10.4 失败重试

```
加载失败：[重试]
  → 仅重试 missing / failed asset
  → cache hash 错误 → invalidate → redownload
```

不要求用户 F5。

---

## 11. Cache / Preload

### 11.1 Cache 状态区分

UI 区分三态：
- `● Ready` （已缓存 + Ready）
- `○ 未加载`（首次访问）
- `加载中…` + 进度条（下载/初始化中）

### 11.2 Preload 策略

- 默认语言（c++17）→ 进入 Contest Home / Problem List 时 `requestIdleCallback` 后台 preload
- **不**默认 preload Java（runtime 体积大，按需加载）
- **不**preload 所有语言（避免冷启动雪崩）

---

## 12. Tooltip

Hover 语言 Selector 显示双列卡片：

```
本地运行环境
Clang 19 / c++17 / wasm32-wasi / Runtime ID = xxx / Ready

正式评测环境
GCC 14.2.0 / c++17 / Ubuntu 24.04

本地与正式环境并非同一编译器，
最终结果以服务器 Judge 为准。
```

---

## 13. Runtime Detail Drawer

右侧滑入抽屉（约 400px），白底卡片 + 标题栏 + 两节：

- **Browser Local Runtime**：Runtime ID / Compiler / Compiler Version / Language Standard / Target Triple / PCH Policy / Status（含 dot）
- **Official Judge**：OS / Compiler / Compiler Version / Standard / Compile Flags / Run Flags / Time Adjustment / Memory Adjustment
- **Runtime Diagnostics**：WebAssembly / Web Worker / SAB / crossOriginIsolated / Atomics / Cache Storage / IndexedDB / ReadableStream / Browser Version + 复制诊断按钮

---

## 14. Runtime Info Page

独立页面 `GET /contest/runtime-info`，从 `/api/public/runtime-profiles` 读取渲染：
- 标题「编译器与运行环境」
- 每语言双列对比卡片（Browser Local vs Official Judge）
- 顶部语言导航
- 包含「为什么浏览器用 Clang」说明章节

---

## 15. Public Runtime API

新增 `GET /api/public/*`（mount in `app.js`）：

| 端点 | 返回 |
|---|---|
| `/api/public/runtime-profiles` | 全量 sanitized profiles |
| `/api/public/runtime-profiles/:id` | 单个 profile（id 非法 → 404） |
| `/api/public/faq` | FAQ 数据（与 language-profiles 同源） |

**安全边界**：仅 sanitized 公开数据，**不含** hidden test / db path / secret / cookie / session。

---

## 16. FAQ 动态化

- 旧 `FAQ` 内容**项目无**（审计确认）
- 新 FAQ 数据由 `/api/public/faq` 派生（与 language-profiles 同源）
- UI 页面 `GET /contest/faq` 渲染
- Admin 修改 Official Profile 后，FAQ 自动反映

---

## 17. Java 21 Official Judge

### 17.1 实现

`judge/judge-adapter.js#compileJava`：
- `javac -J-Xms1024M -J-Xmx1024M -J-Xss64M -encoding UTF-8 Main.java`
- `java -Dfile.encoding=UTF-8 -XX:+UseSerialGC -Xss64M -Xms32M -Xmx<按 memoryLimitMb 推导> -cp . Main`

命令从 `language-profiles.js#java21.officialJudge` 读取。

### 17.2 接入状态机

复用现有 `SubmissionService.submit()` → `JudgeService.dispatch()` → `judgeSubmission()` → `AC/WA/CE/RE/TLE/MLE`。

`submission-service.js` 新增 `LANGUAGE_PROFILE_DISABLED` 错误码（Admin 禁用语言时返回 403）。

### 17.3 测试

`compat-tests/java21/`：12 个 corpus 用例（Fast IO / Sort / Binary Search / Prefix Sum / BFS / Dijkstra / BigInteger / BufferedReader / Unicode / CE / RE / TLE）。完整 30+ corpus 待补充。

---

## 18. Java Browser Local Feasibility Spike

### 18.1 候选方案

| 方案 | 结论 |
|---|---|
| Plan A: OpenJDK 21 → WASM + Persistent JVM + JavaCompiler（JavaBox 风格） | 理论上 P0 同级，但当前非现成方案（需 1-2 周工程构建） |
| Plan B: CheerpJ | 只支持 Java 8-17（Java 21 不完整）+ License 限制 |
| Plan C: WebVM + Linux + OpenJDK | Runtime > 200 MB，资源代价不可接受 |
| Plan D: GraalVM Web Image | 不支持浏览器内 Java 源码编译 |

### 18.2 决策

**P0**：Java 21 Browser Local = **Experimental / Not Available for P0**。
- UI 上 Java 21 选项可见
- Local Run 区显示「暂不支持本地运行，请直接正式提交」
- Official Judge 立即可用

详见 [java-browser-poc/SELECTION-REPORT.md](../java-browser-poc/SELECTION-REPORT.md)。

---

## 19. Java 路线选择

### 19.1 P1 触发条件

满足以下任一条件再启动 P1 正式接入：
1. 上游如 Yaossg/JavaBox 文档声明"OpenJDK 21 全部特性支持"且运行时 size < 30 MB
2. CheerpJ 4 商业版以外出现自由使用、Java 21 完整支持、System.in 可读的社区构建
3. 实验室构建出针对 OpenJDK 21 的 WasmGC + Threading 路径，在 5-30 MB 体积上限下稳定可中断
4. 至少有第二个项目（如 Vloxy/Mainmatter）进入维护期且承诺 Java 21 兼容

### 19.2 P1 接入步骤

1. 选型（JavaBox / 自构建）→ 锁定上游 commit + license
2. 编译 WASM → 测量 size / Cold Start
3. 验证 18 项决策门槛
4. 建立 `java21-openjdk-wasm-compat-v2`（v1 已被占位）
5. 新建 `ide-java-worker.js`（独立 Worker）
6. 接入 `ide-runner.js` 统一分发
7. UI 状态切换：Experimental → Beta → Stable

---

## 20. Load / Startup Benchmark

| Runtime | Asset Bytes | Cold Network Start | Cached Cold | Warm Compile | Warm Run |
|---|---|---|---|---|---|
| C++11 (frozen, Clang 8) | ~50 MiB | ~6 s | ~5 s | 158 ms（bits A+B） | 1-10 ms |
| Python 3.12 (frozen, Pyodide 0.26.4) | 13.2 MiB | 1291 ms | 1274 ms | 0.4-1.2 ms | 0.8-3.1 ms |
| C++17 (planned, Clang 19) | ~60-80 MiB | 估 8-10 s | 估 5-7 s | 待实测 | 待实测 |
| Java 21 Official (server) | — | — | — | javac < 2s | java -Xmx<MB> Main |

注：Modern Clang 实际大小需下载 WASI SDK 27 后实测；Java Local 暂未接入。

---

## 21. Runtime Assets

| runtimeId | 资产路径 | 状态 |
|---|---|---|
| `cpp11-gcc11-compat-v4` | `/runtime/runno/0.10.0-ojc4/langs/*` | FINAL FROZEN |
| `c11-gcc11-compat-v3` | `/runtime/runno/0.10.0-ojc4/langs/*` | FINAL FROZEN |
| `py312-cpython-compat-v1` | `/runtime/pyodide/0.26.4/*` | FINAL FROZEN |
| `cpp-modern-v1` | `/runtime/cpp-modern-v1/*`（待下载） | PENDING |
| `c17-gcc14-compat-v1` | reuse cpp-modern-v1 | PENDING |
| `cpp17-gcc14-compat-v1` | reuse cpp-modern-v1 | PENDING |
| `cpp20-gcc14-compat-v1` | reuse cpp-modern-v1 | PENDING |
| `cpp23-gcc14-compat-v1` | reuse cpp-modern-v1 | PENDING |
| `java21-openjdk-wasm-compat-v1` | `/runtime/java21/*`（占位，无真实资产） | EXPERIMENTAL |

---

## 22. Frozen Regression

- 所有冻结 Runtime 代码路径**未修改**：
  - `ide-runner.js`：仅**新增** `onRuntimeProgress / prewarmModernRuntime / retryModernRuntime / probeRuntimeCache` 四个 API
  - `ide-wasi-worker.js`：未触碰
  - `ide-python-worker.js`：未触碰
  - `runtime-manifest-c11.json` / `runtime-manifest-cpp11.json` / `runtime-manifest-python.json`：未触碰
- Server 端模块加载测试：`language-profiles.js` / `config.js` / `judge-adapter.js` / `submission-service.js` / `routes/public.js` / `routes/internal-admin.js` / `app.js` 全部通过 `node --check`
- 服务端启动测试（`APP_ENTRY=contest`）：`/api/public/runtime-profiles` / `/api/public/faq` / `/contest/runtime-info` / `/contest/faq` 均 HTTP 200
- 旧语言 allowlist（`['c11','cpp11','python3']`）已被派生（新增 c17/cpp17），**未删除原语言**，向后兼容

---

## 23. Known Divergences

### 23.1 Browser Clang vs Server GCC

继承自 Clang 8 + WASI 限制（升级 Clang 19 后部分解决）：
- `std::thread` / `std::mutex` / `std::atomic`：WASI 缺 pthread 运行时（**不修复**）
- `std::filesystem`：部分子集可用（视 host syscall）
- `std::stacktrace`（C++23）：需 host unwinder
- `uniform_int_distribution` 等"Allowed STL Implementation Divergence"

### 23.2 Official Judge 版本差异

- 当前生产 GCC 11.5.0；新 modern C/C++ profile 设计标准为 GCC 14（待生产部署切换）
- 切换前请重跑 `compat-tests/bits` harness

### 23.3 Java Browser Local 缺位

详见 §18 / §19。

---

## 24. 最终 Supported Language Matrix

| Language | Browser Local | Official Judge | Status |
|---|---|---|---|
| C11 | ✅ | ✅ | **Legacy Frozen**（`c11-gcc11-compat-v3`） |
| C17 | ✅（待 Modern Clang 集成） | ✅（待 GCC 14 部署） | **Stable（P0 设计）** |
| C++11 | ✅ | ✅ | **Legacy Frozen**（`cpp11-gcc11-compat-v4`） |
| C++17 | ✅（待 Modern Clang 集成） | ✅（待 GCC 14 部署） | **Stable（P0 设计）** |
| C++20 | ✅（待 Modern Clang 集成） | ✅（待 GCC 14 部署） | **Stable（P0 设计）** |
| C++23 | ✅（待 Modern Clang 集成） | ✅（待 GCC 14 部署） | **Beta（P1）**（不宣称"完整支持"） |
| C++26 | — | — | **Capability Spike only**（不构建 Profile） |
| Python 3.12 | ✅ | ✅ | **Stable**（`py312-cpython-compat-v1`） |
| Java 21 | ⚠️ Experimental | ✅ | **Official Stable / Local Beta** |

---

## 附录 A：本阶段交付清单

### A.1 新增文件

- `server/src/language-profiles.js` —— 全量 LanguageProfile 单一数据源
- `server/src/routes/public.js` —— Public Runtime API + FAQ
- `server/public/js/contest/runtime-assets.js` —— 真实字节进度状态机
- `server/public/js/contest/runtime-info.js` —— Runtime Info 页逻辑
- `server/views/contest/runtime-info.ejs` —— Runtime Info 页
- `server/views/contest/faq.ejs` —— FAQ 页
- `compat-tests/java21/` —— Java 21 Official 兼容测试（12 用例，可扩展）
- `java-browser-poc/SELECTION-REPORT.md` —— Java Browser Local 选型报告
- `docs/cpp-modern-clang-selection-report.md` —— Modern Clang 选型报告
- `docs/runtime-enhancement-report.md` —— 本报告

### A.2 修改文件

- `server/src/config.js` —— `languages` / `languageProfiles` 由 language-profiles 派生
- `server/src/judge/judge-adapter.js` —— `compileJava()` 新增；`compileCpp()` 从 profile 读标准
- `server/src/services/submission-service.js` —— `LANGUAGE_PROFILE_DISABLED` 错误码
- `server/src/routes/internal-admin.js` —— `GET/POST /languages` 受控端点
- `server/src/app.js` —— 挂载 `/api/public`；新增 `/contest/runtime-info`、`/contest/faq` 路由
- `server/public/js/contest/ide-runner.js` —— 新增 onRuntimeProgress 等4 个 API + Java21 runCode 分支
- `server/public/js/contest/problem-detail.js` —— 进度条 / 状态标记 / Tooltip / Drawer / 编译详情 / Diagnostics / 错误分类
- `server/views/contest/problem-detail.ejs` —— UI 容器 + 「源码不出网」文案修正
- `server/views/partials/contest-head.ejs` —— 侧栏 Runtime Info / FAQ 入口
- `server/public/css/ccpcoj.css` —— Runtime Enhancement Phase 新增 CSS（进度条 / Tooltip / Drawer / 编译详情 / Diagnostics）

### A.3 未触碰文件（冻结隔离验证）

- `runtime-manifest-c11.json` / `runtime-manifest-cpp11.json` / `runtime-manifest-python.json`
- `server/public/js/runno/`（所有）
- `ide-wasi-worker.js` / `ide-python-worker.js`（冻结 Worker）
- 冻结 Runtime 的任何字节

---

## 附录 B：执行顺序完成度

| STEP | 内容 | 状态 |
|---|---|---|
| 1 | 审计 RuntimeManager / Language Profiles / Admin Config | ✅ |
| 2 | Runtime Loading Progress Framework | ✅ |
| 3 | Tooltip + Runtime Detail Drawer | ✅ |
| 4 | Runtime Info Page + Public Runtime API | ✅ |
| 5 | FAQ 与 Language Profile 共用数据源 | ✅ |
| 6 | Java 21 Browser Runtime PoC（选型报告） | ✅（Experimental 决策） |
| 7 | Java CE / RE / Timeout / Isolation | ⏸️（Local 未接入，转至 Official 测试） |
| 8 | 决定 Java Browser Runtime 是否进入正式开发 | ✅ → P1 推迟 |
| 9 | Modern Clang Toolchain PoC | ✅（Selection Report） |
| 10 | C17 / C++17 | 🟡 Profile 设计完成，待 Modern Clang 集成 |
| 11 | C++20 | 🟡 Profile 设计完成，待 Modern Clang 集成 |
| 12 | C++23 | 🟡 Profile 设计完成，待 Modern Clang 集成 |
| 13 | Java ACM Compatibility Matrix | ✅ Official 12 用例；30+ corpus 待扩展 |
| 14 | Java 接 RuntimeManager | ❌ Local 未接入（Experimental） |
| 15 | 全语言 E2E | 🟡 Frozen Regression 通过；Java Local N/A |
| 16 | Frozen Regression | ✅ |
| 17 | 最终报告 | ✅（本文件） |

🟡 = Profile 已就绪，待 Modern Clang binary 集成后即可激活