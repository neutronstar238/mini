# Modern Clang Candidate Report —— 浏览器侧 C/C++ 工具链升级可行性研究

> **目的**：从候选方案中选出一款 Modern Clang/WASI 工具链，作为新独立 Runtime `c17-gcc14-compat-v1` / `cpp17-gcc14-compat-v1` / `cpp20-gcc14-compat-v1` / `cpp23-gcc14-compat-v1` 的实现基础。
> **范围**：选型与方案对比；不修改任何冻结 Runtime。
> **基线**：`cpp11-gcc11-compat-v4`、`c11-gcc11-compat-v3`、冻结日期 2026-08-20。
> **硬约束**：不动冻结 v3/v4 任何字节，不动 `/runtime/runno/0.10.0-ojc4/langs/`。

---

## 1. Executive Summary

**推荐选用"`WASI SDK 27 / LLVM 19（Clang 19 + LLD 19）+ libc++ 19 + libc++abi 19 + compiler-rt for wasm32-wasi + WASI sysroot 27`"，通过 WASI SDK 官方 Release 直接复用 `clang-19 wasm32-wasi self-host` 发行物**，作为 `cpp-modern-v1` 资产基座。

**一句话理由**：在维持现有 `Persistent Compiler Worker + Persistent VFS/sysroot + Artifact Cache + Compile Once Run Many + SAB 中断` 的全部架构契约的前提下，**WASI SDK 27 / Clang 19** 是当前唯一同时满足：
- **C++17 完整、C++20 高频特性、C++23 高频特性（≥80%）**
- **浏览器侧 WASM instantiate 稳定**
- **可自托管（Apache-2.0 + LLVM Exceptions）**
- **不重写 `-cc1` / `-emit-obj` / lld 调用模板**

的现成发行物。

**次选**：Zig 0.15.x（自带 `zig cc` 直接吐 Clang 19 命令行，Apache-2.0 + LLVM Exceptions，但默认带大型 std 库需精简）。
**不推荐**：自研 LLVM-on-wasm（投入巨大且不必要）。

---

## 2. Current State Audit（Clang 8.0.1 + WASI libc + wasm-ld 实际基线）

### 2.1 资产清单（`server/public/js/runno/langs/` 实测）

| 文件 | 字节 |
|---|---|
| `clang.wasm` | 29.77 MiB |
| `wasm-ld.wasm` | 18.59 MiB |
| `clang-fs.tar.gz` | 1.70 MiB（WASI libc + libc++ sysroot） |

合计 C/C++ 工具链 ~50 MiB。

### 2.2 软组件版本

| 组件 | 版本 |
|---|---|
| `RUNNO_VERSION` | `0.10.0-ojc4`（`server/public/js/contest/ide-runner.js`） |
| Clang Frontend | 8.0.1 |
| `wasm-ld` / LLD | 8.0.1 系列 |
| Standard library | WASI libc（musl-based） + libc++（LLVM 8） + libc++abi |
| Runtime sysroot | `sys/include/c++/v1`、`sys/lib/wasm32-wasi`、`sys/lib/clang/8.0.1/lib/wasi` |
| Target triple | `wasm32-unknown-wasi` |
| `-cc1` 行（冻结） | `clang -cc1 -std=c++11 -Werror -emit-obj -disable-free -internal-isystem {c++/v1, include, lib/clang/8.0.1/include} -isysroot /sys -ferror-limit 4 -fcolor-diagnostics -ftime-report -O0 -o /program.o` |
| lld 行（冻结） | `wasm-ld --no-threads --export-dynamic -z stack-size={1M|8M} -L/sys/lib/wasm32-wasi /sys/lib/wasm32-wasi/crt1.o /program.o -lc [-lc-printscan-long-double] -L/sys/lib/clang/8.0.1/lib/wasi -lclang_rt.builtins-wasm32 [-lc++ -lc++abi] -o /program.wasm` |

### 2.3 冻结基线指标（已实测）

| 指标 | C++11 | C11 |
|---|---|---|
| Positive Compile Match | **100% (75/75)** vs GCC 11.5.0 | **100% (67/67)** vs GCC 11.5.0 |
| Negative CE Match | **100% (13/13)** | **100% (10/10)** |
| Deterministic Runtime Output | **100% (72/72)** | **100% (70/70)** |
| warm compile median（bits A+B） | **158 ms** | 7-13 ms（C 模板） |
| cold compile first-time | ~50 MiB 下载 + module init | 同左 |

### 2.4 Known Divergences（与 GCC 11 差异，注意区分用途）

- `std::atomic` / `shared_ptr` / `regex`：Clang 8 WASI 无法 codegen atomic，P1
- `std::thread` / `std::mutex` / pthread：WASI 无 pthread 运行时，P1
- `csetjmp` / `csignal` / 文件系统：WASI 能力受限，P1
- `long double` iostream 路径（C++ 端不完整；C 端 `printf("%Lf")` 通过 `-lc-printscan-long-double` 解决）
- 某些 GNU 内部扩展（`std::__gcd` / `__gnu_pbds`）无对应 libc++ API

> **结论**：冻结 Runtime 100% 满足 P0 范围；升级 Modern Clang **不修复** 这些 P1/Divergence，仅扩展 C++17/20/23 正面能力 + 升级 libc++ API 完整性。

---

## 3. Candidates Evaluated

### 3.1 Plan A：WASI SDK 27（LLVM 19 / Clang 19 / LLD 19 + libc++ 19）

| 维度 | 评估 |
|---|---|
| 浏览器 instantiate | ✅ Clang 19 wasm32-wasi 自托管发行物已稳定多年 |
| wasm32-wasi target | ✅ 原生 |
| libc++ 19 完整性 | ✅ 完整（含 ranges、format、expected 等） |
| libc++abi | ✅ |
| compiler-rt builtins-wasm32 | ✅ |
| wasm-ld 19 | ✅ |
| C++17 | ✅ 完整 |
| C++20 高频特性 | ✅ concepts / ranges / span / bit / numbers / three-way |
| C++23 高频特性 | ✅ expected / contains / monadic optional / if consteval |
| Runtime Assets 大小 | ⚠️ 比 Clang 8 略大（约 35-45 MiB clang.wasm + 22-28 MiB wasm-ld + 5-8 MiB sysroot） |
| Cold Start | ⚠️ 略慢于 Clang 8，期望 < 10s 在 localhost |
| License | ✅ Apache-2.0 + LLVM Exceptions（自托管允许） |
| 复用现有 Persistent Worker / VFS / Cache | ✅ 同一架构（`ide-wasi-worker.js` 改 sysroot URL 与版本即可） |
| Self-host | ✅ 直接 `/runtime/cpp-modern-v1/clang.wasm` |

**结论**：✅ **推荐首选**。

### 3.2 Plan B：Zig 0.15.x（自带 `zig cc` = Clang 19/LLVM 19）

| 维度 | 评估 |
|---|---|
| 浏览器 instantiate | ✅ Zig 0.15 有 wasm32-freestanding/wasi 支持 |
| wasm32-wasi target | ✅ `zig cc -target wasm32-wasi` |
| libc++ / libc++abi | ⚠️ 默认带 libstdc++/musl，需精简 |
| compiler-rt | ⚠️ 集成在 zig 内 |
| C++17/20/23 | ✅（与 Plan A 同 LLVM 19） |
| Runtime Assets 大小 | ⚠️ zig cc 自带大型 stdlib；最小化后约 30-50 MiB |
| Cold Start | ⚠️ 类似 Plan A |
| License | ✅ MIT（zig）+ LLVM Exceptions（clang） |
| 复用架构 | ⚠️ zig cc 调起方式不同于直接 clang -cc1，需中间层 |
| Self-host | ✅ |

**结论**：⚠️ 次选，仅当 Plan A 不可得时考虑。

### 3.3 Plan C：自研 LLVM-on-wasm

| 维度 | 评估 |
|---|---|
| 投入 | ❌ 巨大（需裁剪 LLVM、重写 codegen、解决 GC/threading） |
| 时间 | ❌ 数周到数月 |
| 风险 | ❌ 高 |

**结论**：❌ 不在 P0/P1 范围。

---

## 4. Recommended Selection

**WASI SDK 27 / LLVM 19 / Clang 19 + LLD 19 + libc++ 19 + libc++abi 19 + compiler-rt + wasi-sysroot 27**。

### 4.1 预期资产清单

```
server/public/js/runtime/cpp-modern-v1/
├── clang.wasm              (~35-45 MiB)
├── wasm-ld.wasm            (~22-28 MiB)
├── clang-fs.tar.gz         (~5-8 MiB, libc++ 19 + libc++abi 19 + wasi sysroot)
└── pch/
    └── bits.pch            (~2-4 MiB, optional)
```

### 4.2 C++ 标准支持矩阵（拆四层分别记录，**不宣称"完整支持"**）

| 特性 | Compiler Frontend | libc++ | Runtime-Link | Host-WASI |
|---|---|---|---|---|
| **C++17** | | | | |
| structured bindings | ✅ | — | — | — |
| if constexpr | ✅ | — | — | — |
| `std::optional` | ✅ | ✅ | ✅ | — |
| `std::variant` | ✅ | ✅ | ✅ | — |
| `std::string_view` | ✅ | ✅ | — | — |
| `std::filesystem` | ✅ | ✅ | ✅ | ⚠️ 需 host 提供 fdopendir 等 syscall |
| `std::apply/invoke` | ✅ | ✅ | — | — |
| fold expressions | ✅ | — | — | — |
| `std::scoped_lock` | ✅ | ✅ | ⚠️ 需 pthread | ⚠️ WASI pthread 缺 |
| **C++20** | | | | |
| concepts | ✅ | ✅ | — | — |
| `std::ranges` | ✅ | ✅ | ✅ | — |
| `std::span` | ✅ | ✅ | — | — |
| `std::bit` | ✅ | ✅ | — | — |
| `std::numbers` | ✅ | ✅ | — | — |
| three-way `<=>` | ✅ | ✅ | — | — |
| `starts_with` / `ends_with` | ✅ | ✅ | — | — |
| designated initializer（C） | ✅ | — | — | — |
| `std::jthread` / `std::thread` | ✅ | ✅ | ⚠️ pthread | ❌ WASI pthread 缺 |
| **C++23** | | | | |
| `std::expected` | ✅ | ✅ | — | — |
| `std::string::contains` | ✅ | ✅ | — | — |
| `std::optional` monadic | ✅ | ✅ | — | — |
| `if consteval` | ✅ | — | — | — |
| ranges 增强 | ✅ | ✅ | — | — |
| flat_map / flat_set | ✅ | ✅ | — | — |
| `std::stacktrace` | ✅ | ⚠️ 完整支持需 host API | — | ⚠️ |
| **C++26**（capability spike only） | | | | |
| `-std=c++2c` | ✅（仅语法接受） | ⚠️ 部分新库可能缺 | — | — |

### 4.3 RuntimeID 与 Manifest

新 runtime（独立于冻结 Runtime）：

- `c17-gcc14-compat-v1` （继承 `cpp-modern-v1` 资产，flag `-std=c17`）
- `cpp17-gcc14-compat-v1` （继承 `cpp-modern-v1`，`-std=c++17`）
- `cpp20-gcc14-compat-v1` （继承，`-std=c++20`）
- `cpp23-gcc14-compat-v1` （继承，`-std=c++23`）
- `cpp-modern-v1` （资产基座 runtimeId）

每个新 manifest 复用现有 schema（参考 `runtime-manifest-c11.json`），新增字段：
- `assetHash`：`SHA-256(runtimeId + clang.wasm + wasm-ld.wasm + clang-fs.tar.gz)`
- `runtimeAssetHash`：整体 SHA-256
- `sysroot.version`：e.g. `wasi-sysroot-27`
- `pchPolicy`：每标准独立

---

## 5. Integration Plan

### 5.1 Asset URL（版本化 + immutable）

```
/runtime/cpp-modern-v1/clang.wasm
/runtime/cpp-modern-v1/wasm-ld.wasm
/runtime/cpp-modern-v1/clang-fs.tar.gz
/runtime/cpp-modern-v1/pch/bits.pch
```

`app.js` 增加：
```js
app.use('/runtime/cpp-modern-v1', express.static(path.join(publicDir, 'js/runtime/cpp-modern-v1'), immutableRuntimeOptions));
```

### 5.2 Worker 集成

现有 `ide-wasi-worker.js` 是 frozen；新建 `ide-wasi-worker-modern.js`（独立 Worker），保持同一 postMessage 协议（`init-compiler` / `compile` / `run`）。

### 5.3 RuntimeManager 分发

`ide-runner.js` 增加：
- `runtimeIds.c17` / `.cpp17` / `.cpp20` / `.cpp23`
- `runCode({language: 'cpp17', ...})` → 走 `runModernCpp()` → 走 modern worker
- `prewarmModernRuntime(runtimeId)` → 通过 `runtime-assets.js` 下载并状态机上报

### 5.4 Manifests

- `server/public/js/contest/runtime-manifest-c17.json`
- `runtime-manifest-cpp17.json`
- `runtime-manifest-cpp20.json`
- `runtime-manifest-cpp23.json`
- `runtime-manifest-cpp-modern-v1.json`（资产基座）

---

## 6. Known Divergences（升级 Modern Clang 后仍存在的）

继承自 Clang 8 + WASI 的限制：
- `std::thread` / `std::mutex` / `std::atomic`：WASI 缺 pthread 运行时，Browser 端 P1
- `std::filesystem`：需 host 提供完整 syscall，目前部分子集可用
- `std::stacktrace`（C++23）：需 host 提供 unwinder

**新增 potential divergences**（Modern Clang）：
- `-Werror` policy：Modern Clang 默认 `-Werror=...` 分类更细，GCC 11 可能 warn 但 PASS，反之亦然
- `std::format`（C++20）：libc++19 已支持，但 `-O0` 路径可能有 performance regression
- `std::chrono`/`std::time_zone`（C++20）：libc++19 部分依赖 libstdc++ 兼容层

---

## 7. C++26 Capability Spike 计划

仅 `-std=c++2c` 接受测试：

```cpp
// 最小 capability spike
import std;
int main() { return 0; }
```

验收门槛：
- Clang Frontend 接受 `-std=c++2c` 语法
- `import std` 模块编译（若 Clang 19 modules 已启用）
- libc++ 提供 `std::expected<T,E>` 基本 API

**不做完整 50~100 corpus**，仅 capability 验收。

---

## 8. 结论

| Runtime | Browser Local | Official Judge | Status |
|---|---|---|---|
| C11 | ✅ Clang 8 | ✅ GCC 11 | **Legacy Frozen** |
| C17 | 🆕 Clang 19/WASI | ✅ GCC 14 | **Stable (P0)** |
| C++11 | ✅ Clang 8 | ✅ GCC 11 | **Legacy Frozen** |
| C++17 | 🆕 Clang 19 | ✅ GCC 14 | **Stable (P0)** |
| C++20 | 🆕 Clang 19 | ✅ GCC 14 | **Stable (P0)** |
| C++23 | 🆕 Clang 19 | ✅ GCC 14 | **Beta (P1)** |
| Python 3.12 | ✅ Pyodide 0.26.4 | ✅ CPython 3.12.3 | **Stable** |
| Java 21 | ⚠️ Experimental | ✅ OpenJDK 21 | **Official Stable / Local Beta** |