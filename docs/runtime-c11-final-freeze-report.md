# Browser C11 Runtime — 最终冻结报告（FINAL FROZEN）

> **状态：`P0 FINAL FROZEN`**　冻结日期：2026-08-20
> **Runtime ID：`c11-gcc11-compat-v3`**
> 本文件是 Browser C11 Runtime 的最终冻结基线（经"冻结校正"轮生成）。
> 所有统计数字**由脚本机器生成**（`compat-tests/compare-c11.js` → `capability-matrix-c11.json`），禁止手工填写。
> 机器可读 manifest：`server/public/js/contest/runtime-manifest-c11.json`；Reference：`compat-tests/reference-c11.json`。

---

## 1. Final Runtime ID

**`c11-gcc11-compat-v3`**

版本升级历史：
- `v1`（2026-08-20）：首个冻结基线。
- `v2`：`-lm` 冻结、Browser math 走 WASI libc 内建、ACM expectedStdout 修复、新增 math-runtime、三方 Correctness 指标。
- `v3`（本轮）：**Target Triple 拼写校正**（`wasm32-unkown-wasi` → `wasm32-unknown-wasi`，生产代码实际变更）+ **统计口径修正**（math-runtime 计入 positive）。

## 2. Target Triple（实际值）

**生产代码实际 Target Triple：`wasm32-unknown-wasi`**

| 位置 | 修正前 | 修正后 |
|------|--------|--------|
| `server/public/js/contest/ide-wasi-worker.js`（C 分支 `-triple`） | `wasm32-unkown-wasi` | `wasm32-unknown-wasi` |
| `server/public/js/runno/runno-runtime.js`（内建 clang 工具） | `wasm32-unkown-wasi` | `wasm32-unknown-wasi` |

- 修正前生产代码**确实**使用笔误 `wasm32-unkown-wasi`（属情形 B：代码笔误，非仅文档）。
- Clang 8.0.1 对两者均能解析为 wasm32-wasi target（vendor 组件 `unkown`/`unknown` 不影响 codegen），因此为**语义中性**修正。
- 因 Compiler Target 参数在生产代码中改变，**按冻结规则升级 Runtime 版本为 v3**（不静默覆盖 v2）。
- 修正后已重跑完整 C11 regression 与 C++ frozen regression，结果无变化（见 §15）。

## 3. GCC11 Reference（冻结）

| 项 | 值 |
|----|-----|
| 编译器 | **gcc-11**（`11.5.0-1ubuntu1~24.04.1`，Ubuntu 24.04.4 LTS，参考环境） |
| 语言标准 | `-std=c11` |
| 编译命令 | `gcc-11 -std=c11 <src> -lm -o <out>`（`-lm` 置于源文件后，v2 冻结） |
| 运行命令 | `<out> < <in>`（经配置的 SSH 参考环境） |
| 判定 | **match Server Compile Result（GCC11 实际 exit code）**，不臆断 CE |

## 4. Browser Compile Flags

```
clang -cc1 -std=c11 -fno-common -isysroot /sys -fcolor-diagnostics -ftime-report \
  -triple wasm32-unknown-wasi -internal-isystem /sys/include -internal-isystem /sys/lib/clang/8.0.1/include \
  -O0 -emit-obj -o /program.o /program
```
- **不加 `-Werror`**：以 GCC11 实际 exit code 为准，warning 可展示但不得升级为 CE。
- **`-fno-common`**：规避 clang 8.0.1 wasm32 对 C 暂定定义非 static 全局数组的 codegen 崩溃。
- **`-triple wasm32-unknown-wasi`**：v3 校正后的正确拼写。

## 5. Browser Link Flags

```
wasm-ld --no-threads --export-dynamic -z stack-size=8388608 \
  -L/sys/lib/wasm32-wasi /sys/lib/wasm32-wasi/crt1.o /program.o -lc \
  -lc-printscan-long-double -L/sys/lib/clang/8.0.1/lib/wasi -lclang_rt.builtins-wasm32 \
  -o /program.wasm
```
- **栈 8MB**：容纳 C 局部大数组，对齐 GCC11 Linux 默认栈。
- **`-lc-printscan-long-double`**：C long double 完整支持（v3 维持默认启用）。

## 6. Case 数量统计（机器生成）

来自 `capability-matrix-c11.json` 的 `summary.counts`：

| 指标 | 数值 | 来源 |
|------|------|------|
| total | **82** | 脚本 `tests.length` |
| byCategory | `acm-corpus:37, features:23, features/math-runtime:7, negative:10, warnings:5` | 脚本 `countByCategory` |
| positive | **67** | 脚本 `positive.length` |
| negative | **10** | 脚本 `negative.length` |
| warnings | **5** | 脚本 `warnings.length` |
| deterministic runtime | **70** | 脚本 `deterministicRun.length` |
| correctness withExpected | **48** | 脚本 `withExpected.length` |

**公式**：
```
Positive = features 23 + math-runtime 7 + acm-corpus 37 = 67
Total    = Positive 67 + negative 10 + warnings 5 = 82
```
> 说明：`features/math-runtime` 是独立 Case（`compat-tests/c11/features/math-runtime/` 目录，7 个 .c），
> **不内嵌于 features 23 计数**。`compare-c11.js` 已修正 `positive` 过滤包含 `features/math-runtime`。

## 7. Positive Compile Match

**100%（67/67）** —— Server(GCC11) 能编译的标准 C11 用例，Browser 也能编译（正向零丢失）。
分母 = features 23 + math-runtime 7 + acm-corpus 37。

## 8. Negative CE Match

**100%（10/10）** —— Server(GCC11) 应 CE 的代码，Browser 也应 CE（均按 GCC11 实际 exit code 判定）。

## 9. Warning-No-CE Match

**100%（5/5）** —— GCC11 warning+PASS → Browser PASS，`-Werror` 不误杀。

## 10. Deterministic Runtime Output Match

**100%（70/70）** —— Browser stdout == Server stdout（规范化后逐字一致），含 long double `%Lf`。

## 11. Correctness 三方 Output Match

**100%（48/48）** —— Browser==Server==Expected，全部三方一致。
组成：acm-corpus 37 + features 4（`01_stdio`/`06_inttypes`/`21_vla`/`23_long_double`）+ math-runtime 7。

## 12. math-runtime 统计口径

`features/math-runtime/`（7 个运行时输入数学用例：sqrt/pow/sin/cos/floor/ceil/fabs/hypot/combo）：
- 计入 **positive**（67 分母）与 **correctness**（48 分母）。
- 验证 Browser math 走 WASI libc 内建、Server 走 `-lm`，运行时输入三方一致。

## 13. long double 状态

- **默认启用** `-lc-printscan-long-double`（C11 专属，未反向修改 C++ Runtime）。
- `23_long_double`（`%.2Lf` 加法/乘法/精确比较）三方一致 `3.75/3.38/1`，计入 correctness。
- `printf("%Lf")` / `scanf("%Lf")` A/B 评测：B 方案（+printscan）PASS，A 方案 FAIL，无回退。
- 数学库改动（`-lm` / libc 内建 math）不影响 long double `%Lf` 路径。

## 14. 性能 Benchmark（v3 复测，n=10）

C11 `bench-c11.js`（localhost:3001 + headless Chromium）：

| Case | artifact bytes | cold compile | warm compile median/p90 | link | exec median | total |
|------|----------------|--------------|--------------------------|------|-------------|-------|
| A `int main(){return 0;}` | 13KB | 63ms | **7 / 10ms** | 3ms | 0.23ms | 24ms |
| B stdio A+B | 102KB | 68ms | **13 / 21ms** | 4ms | 1.23ms | 33ms |
| C stdio+stdlib+string | 60KB | 21ms | **13 / 15ms** | 3ms | 1.30ms | 31ms |
| D qsort | 106KB | 16ms | **12 / 13ms** | 3ms | 1.69ms | 31ms |
| E BFS | 132KB | 16ms | **13 / 15ms** | 3ms | 1.43ms | 30ms |

Triple 校正后 **无性能回退**；C 明显轻于 C++（C++ `<bits/stdc++.h>` A+B 约 158-169ms，见 §15）。

## 15. C++ Frozen Regression（无回退）

| 回归项 | 命令 | 结果 |
|--------|------|------|
| PCH 语义中性 | `node verify-pch-neutral.js` | `checked=51 diff=0` ✅ |
| GCC11 Header Strict Check | `node test-header-check.js` | `pass=94 fail=0` ✅ |
| C++ bits A+B 性能 | `bits/bench-ab-final.js`（n=10） | **warm compile median 158ms / p90 169ms**（回到历史 150-206ms 基线内） |

> Triple 拼写校正对共享 Worker/fallback（`runno-runtime.js`）语义中性；C++ 主路径（worker C++ 分支，无显式 triple）未改动。C++ 当前冻结版本为 `cpp11-gcc11-compat-v4`。

## 16. Known Divergences（冻结）

| 差异 | Layer | 处理 |
|------|-------|------|
| `size_t`=4、`long`=32 位 | Host/WASI ABI | 固有，不修改；用例规避平台相关值 |
| glibc `isdigit` 位掩码(2048) vs musl(1) | Runtime/STL | Allowed Divergence；用例布尔化 |
| `strtol("zzz")` EINVAL 设置差异 | Runtime/STL | Allowed Divergence；用例只测确定性 ERANGE |
| ~~`sqrt`/`fabs` 需 `-lm`~~ | ~~Compiler/Runtime~~ | **已解决（v2）**：Server `-lm` 冻结，Browser libc 内建；math-runtime 三方一致 |
| `<signal.h>`/`<setjmp.h>`/`<threads.h>` | Host/WASI | P1，不提供错误空壳 |
| 文件系统（fopen/fread 路径） | Host/WASI | P1，不承诺完整 Linux FS |

## 17. Runtime Manifest / Hash

- **Runtime ID**：`c11-gcc11-compat-v3`
- **Compiler**：Clang 8.0.1（Runno self-host，WASI target）
- **Runner**：`RUNNO_VERSION = 0.10.0-ojc3`
- **Target Triple**：`wasm32-unknown-wasi`（生产代码实际值）
- **Server Reference**：`gcc-11 -std=c11 <src> -lm -o <out>`
- **sysroot**：`server/public/js/runno/langs/clang-fs.tar.gz`
- **sysroot hash (SHA256)**：`B2E4B0F28A2C56B80CA43B61DC1CA2B62B8263B582735504E6C376FED4B1F363`
- **Compiler flags**：`-std=c11 -O0 -fno-common -triple wasm32-unknown-wasi -isysroot /sys -fcolor-diagnostics -ftime-report`（无 `-Werror`）
- **Link flags**：`-z stack-size=8388608 -lc -lc-printscan-long-double -lclang_rt.builtins-wasm32`

机器可读清单见 `server/public/js/contest/runtime-manifest-c11.json`；能力矩阵见 `compat-tests/capability-matrix-c11.json`；Reference 见 `compat-tests/reference-c11.json`。

---

## 最终验收

- ✅ Case 数量与所有分母由脚本自动生成，无算术矛盾（67 + 10 + 5 = 82）。
- ✅ Target Triple 拼写与生产代码一致（`wasm32-unknown-wasi`）。
- ✅ Triple 真实修改 → Runtime Version 已正确升级到 v3。
- ✅ Positive Compile = 100%（67/67）。
- ✅ Negative CE = 100%（10/10）。
- ✅ Warning-No-CE = 100%（5/5）。
- ✅ Deterministic Output = 100%（70/70）。
- ✅ Correctness 三方 = 100%（48/48）。
- ✅ C11 性能无回退。
- ✅ C++ Frozen Regression 无回退（PCH 51/0、Header 94/0、bench 158ms）。
- ✅ 无"212ms 属于 150-206ms 范围"类逻辑错误（已更新为实测 158ms/169ms）。

---

# Browser C11 Runtime FINAL FROZEN

**可以进入 Python 3 Browser Runtime 阶段。**
