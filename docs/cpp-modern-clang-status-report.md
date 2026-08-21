# Modern Clang (C17/C++17/C++20/C++23) — Activation Status Report

> **Status (2026-08-21)**: **PENDING** — Modern Clang browser-runnable binary 不可获取
> **Profile IDs**: `c17-gcc14-compat-v1`, `cpp17-gcc14-compat-v1`, `cpp20-gcc14-compat-v1`, `cpp23-gcc14-compat-v1`
> **目标 Runtime ID**: `cpp-modern-v1`
> **目标 Milestone**: `CPP17_BROWSER_OK` → `BETA` → `STABLE`
> **关联文档**: `docs/cpp-modern-clang-selection-report.md`（选型），`scripts/cpp-modern-poc-driver.mjs`（PoC 驱动）

---

## 1. 真实 PoC 尝试与失败证据

### 1.1 下载尝试

下载 `binji/wasm-clang` 资产（**当前唯一浏览器可运行的 Clang WASM**）：

| 文件 | 来源 | 字节 |
|---|---|---|
| clang | `https://raw.githubusercontent.com/binji/wasm-clang/master/clang` | 31,214,472 (~31.2 MB) |
| lld | `https://raw.githubusercontent.com/binji/wasm-clang/master/lld` | 19,490,094 (~19.5 MB) |
| sysroot.tar | `https://raw.githubusercontent.com/binji/wasm-clang/master/sysroot.tar` | 9,297,920 (~9.3 MB) |

Magic bytes 校验：clang/lld 都是 `\0asm`（WASM）；sysroot.tar 是合法 tar 归档（offset 0 = `include/`, offset 257 = `ustar`）。

### 1.2 BLOCKING FAILURE

`binji/wasm-clang` 的 `clang.wasm` **必须**有 `memfs.tar` sibling（预先 baked WASI sysroot + libc + clang driver）。未下载 memfs.tar → clang.wasm instantiate 失败。

```
[BLOCKING] binji/wasm-clang clang.wasm requires memfs.tar sibling
  - We have sysroot.tar (raw 9.3 MB tarball of /include /lib)
  - binji clang.wasm does NOT unpack sysroot.tar at runtime
  - It expects a pre-baked memfs.tar with the same contents
```

### 1.3 第二条现实路径评估

| 候选 | 状态 |
|---|---|
| binji/wasm-clang fallback | memfs.tar 未发布，单独 sysroot.tar 不可直接被 clang.wasm 消费 |
| WASI SDK 27 (native) | **不是** browser-runnable，是 native 工具链；不能直接当 browser clang.wasm |
| WASI SDK 27 → Self-host + browser loader | 需要 native toolchain + Emscripten runtime + 自写 adapter，multi-week |
| 自建 llvm-project wasm-emscripten port | 标准路径，需 cross-compile LLVM 19 → WASM，multi-week |
| Wasmer.js (wasmer-clang) | 商业 wasmer runtime 自带 clang-in-browser，**但**依赖 wasmer-js license 路径复杂；非 self-host |

### 1.4 NODE LIMITATION（额外证据）

即使 memfs.tar 可获取，`binji/wasm-clang` 的 `clang.wasm` 是 Emscripten-emitted，在 Node 缺少 Emscripten JS runtime 胶水（FS / ENV / MEMORY 等），无法 instantiate。真实 PoC 必须 Chrome + COOP/COEP + binji `web.js` / `shared_web.js` 加载器。

详见 `scripts/cpp-modern-poc-driver.mjs` 输出与 `.codebuddy/tmp/cpp-modern-poc/cpp-modern-poc-evidence.jsonl`。

---

## 2. 状态门控（按用户 §37 严格定义）

| 维度 | 当前状态 | 备注 |
|---|---|---|
| 设计 | ✅ 完成 | `c17-gcc14-compat-v1` / `cpp17-gcc14-compat-v1` / `cpp20-gcc14-compat-v1` / `cpp23-gcc14-compat-v1` profile 完整 |
| 真实 PoC | ❌ 失败 | binji/wasm-clang 缺 memfs.tar；WASI SDK 27 非 browser-runnable；自建未执行 |
| Compatibility Matrix | n/a | PoC 未通过无法做 Compatibility |
| **Profile status** | **PENDING** | **禁止报告 "C++20 已支持"**——本轮严格按 §34 执行 |
| **`cpp-modern-v1` 资产** | **PENDING**（assets: []） | runtime-assets.js 已标记 |
| **`ide-wasi-worker-modern.js`** | **scaffold** | 状态机 + 消息协议完整；init/run 路径占位等待 self-built 资产 |
| **app.js `/runtime/cpp-modern-v1/` 路由** | **就位**（404 待 self-build） | immutable 静态路由已配 |
| **fetch-modern-clang.ps1** | **就位**（占位） | 哈希校验模式同 fetch-runno-runtime.ps1；实际下载源待 self-build 完成 |

---

## 3. 已经就位（Phase 6 真实落地）

### 3.1 `server/public/js/contest/ide-wasi-worker-modern.js`（NEW）

完整架构（即使 runtime 不在也可安全 init → 返回 PENDING 状态）：

- 状态机：`NOT_LOADED → CHECK_CACHE → DOWNLOAD_RUNTIME → INITIALIZING_WASM → WARMUP_COMPILER → READY → COMPILING → LINKING → RUNNING → FAILED`
- 消息协议（与 `ide-wasi-worker.js` 一致）：
  - `{type:'init'}` → `{type:'inited', ok, runtimeId, clangVersion, target, libcxxVersion, runtimeSource}`
  - `{type:'compile', source, language, optLevel}` → `{type:'compile-result', ok, ...}`
  - `{type:'run', source, language, stdin}` → `{type:'run-result', result}`
- 当 runtime 不在时（当前状态）：init 快速失败返回 `{ok: false, status: 'PENDING', message: 'Modern Clang browser-runnable runtime 资产未发布'}`

### 3.2 `server/src/language-profiles.js`（MODIFIED）

`c17/cpp17/cpp20/cpp23` profile 的 `localRuntime.status` 维持 `PENDING`，`assetHash = 'PENDING-MODERN-CLANG'`，**禁止** `ready`/`enabled`/`stable`。与上一轮 Runtime Enhancement Phase 保持一致。

### 3.3 `server/src/app.js`（MODIFIED earlier）

```js
app.use('/runtime/cpp-modern-v1', express.static(path.join(publicDir, 'js', 'runtime', 'cpp-modern-v1'), immutableRuntimeOptions));
```

正式资产就位后该路由生效；当前 SCAFFOLD → 404 预期。

### 3.4 `runtime-assets.js`

`cpp-modern-v1` manifest 已注册（assets:[]，status:PENDING）；`prewarmRuntime` 在检测到时走 SCAFFOLD 路径返回 `UNAVAILABLE`。

---

## 5. 正式进入 EXPERIMENTAL 状态的条件

按 Phase 6 §37 严格定义：

1. **真实 PoC 跑通**：`CPP17_BROWSER_OK`（`#include <iostream>\nint main(){std::cout<<"CPP17_BROWSER_OK\\n";}`）
2. **完整链路**：Chrome → clang.wasm → object → wasm-ld.wasm → submission.wasm → run → `CPP17_BROWSER_OK`
3. **Pipeline**：c17/cpp17/cpp20/cpp23 共用同一套 Modern Clang assets，通过 `-std=` 切换
4. **Profile status** 自动从 `PENDING` 升级 `EXPERIMENTAL`

---

## 6. 正式进入 BETA 状态的条件

按 Phase 6 §37：

1. **Compatibility Matrix 通过**：每个标准至少 6 个 case（C/C++17/20/23 各自覆盖 hello/sort/algorithm/CE/RE/io）
2. **License Audit 完成**：`browsercxx-oj/` 工程 + `THIRD_PARTY_LICENSE_MATRIX.md` + 自建 WASM 资产
3. **Profile status** 从 `EXPERIMENTAL` 升级 `BETA`

---

## 7. 正式进入 STABLE 状态的条件

按 Phase 6 §37：

1. **完整 P0**：所有 ACM 主流 C++ 算法 case 跑通
2. **Self-host**：`/runtime/cpp-modern-v1/` immutable 路由 + Cache Storage
3. **Frozen Regression**：cpp11/c11/python 100% 兼容（已 frozen，本轮不动）
4. **Profile status** 从 `BETA` 升级 `STABLE`

---

## 8. 资源汇总

| 类别 | 路径 | 状态 |
|---|---|---|
| Modern C++ Worker | `server/public/js/contest/ide-wasi-worker-modern.js` | ✅ scaffold |
| Modern C++ profiles | `server/src/language-profiles.js` c17/cpp17/cpp20/cpp23 | ✅ PENDING |
| Runtime route | `server/src/app.js` `/runtime/cpp-modern-v1/` | ✅ immutable |
| Runtime manifest | `server/public/js/contest/runtime-assets.js` `cpp-modern-v1` entry | ✅ PENDING |
| Fetch script | `deploy/fetch-modern-clang.ps1` (scaffold) | 🔧 待 self-build commit 锁定 |
| PoC driver | `scripts/cpp-modern-poc-driver.mjs` | ✅ 真实 blocker 记录 |
| PoC evidence | `.codebuddy/tmp/cpp-modern-poc/cpp-modern-poc-evidence.jsonl` | ✅ 落盘 |
| 选型报告 | `docs/cpp-modern-clang-selection-report.md`（上一轮） | ✅ |
| 状态报告 | `docs/cpp-modern-clang-status-report.md`（本轮） | ✅ |

---

## 9. 结论

| 维度 | 状态 |
|---|---|
| Modern C++ Profile 已设计 | ✅（上一轮 Runtime Enhancement Phase） |
| Modern C++ Profile 真实状态 | **PENDING**（诚实） |
| Modern Clang 浏览器 binary 可获取性 | ❌ **阻塞**（binji/wasm-clang 缺 memfs.tar；WASI SDK 27 非 browser-runnable） |
| Modern C++ Worker 架构就位 | ✅（`ide-wasi-worker-modern.js` scaffold） |
| Modern C++ Runtime 路由就位 | ✅（`/runtime/cpp-modern-v1/` immutable） |
| `CPP17_BROWSER_OK` Milestone-1 | ❌ **未跑通** |
| Profile status | **PENDING** |
| 严格按 Phase 6 §34 | **不**宣称 "C++20 已支持" |

**下一步（在外部 Linux 构建机上）**：

1. 构建 self-hosted Modern Clang WASM（llvm-project wasm-emscripten port，multi-week）
2. 产出 `cpp-modern-v1` 资产：`clang.wasm` / `lld.wasm` / `sysroot.wasif` / `loader.mjs`
3. 跑 `scripts/cpp-modern-poc-driver.mjs` Milestone-1（需要 Chrome 部署）
4. 通过后 Profile status `PENDING → EXPERIMENTAL`
5. 跑 12-case Compatibility Matrix → `BETA`
6. Frozen Regression → `STABLE`

**本轮交付**：架构完整 + 真实 PoC blocker 证据 + 三态门控 + 不欺骗 UI（profile 状态如实显示 PENDING）。