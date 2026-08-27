# Browser C11 Runtime P0 冻结报告

> **状态：`P0 FINAL FROZEN`**　冻结日期：2026-08-20
> **Runtime ID：`c11-gcc11-compat-v3`**（v2→v3 为 Target Triple 拼写校正 + 统计口径修正，见 §版本升级规则）
> 本文件是 Browser C11 Runtime 的正式冻结基线。基于已冻结 C++11 Runtime
> （`cpp11-gcc11-compat-v4`）复用基础设施，不复制第二套 Worker。
> 后续开发默认不得修改本 Runtime 核心逻辑；若需变更，必须按 §版本升级规则生成新版本。

---

## 1. Runtime ID

**`c11-gcc11-compat-v3`**

目标：为标准单线程 ACM/OJ C11 程序提供稳定、零安装、浏览器本地编译运行与样例调试能力。
- 选手只打开 Chrome，无需安装 GCC / MinGW / WSL / Local Agent。
- 正式 Judge 仍在服务器执行；Browser C11 Runtime 仅用于自定义输入运行 / 样例运行 / Local CE / Local RE / stdout / stderr / Execution Time / 提交前调试。

## 2. GCC11 C Reference（冻结）

| 项 | 值 |
|----|-----|
| 编译器 | **gcc-11**（`11.5.0-1ubuntu1~24.04.1`，Ubuntu 24.04.4 LTS，参考环境） |
| 语言标准 | `-std=c11` |
| 编译命令 | `gcc-11 -std=c11 <src> -lm -o <out>`（`-lm` 置于源文件后，v2 冻结，保证链接顺序；runtime 数学输入依赖真实 libm symbol） |
| 运行命令 | `<out> < <in>`（经配置的 SSH 参考环境） |
| 判定 | **match Server Compile Result（GCC11 实际 exit code）**，不臆断 CE |

> 元数据见 `compat-tests/reference-c11.json`。

## 3. Browser Compile / Link flags（冻结）

### Compile（C 分支，Clang 8.0.1 WASI）
```
clang -cc1 -std=c11 -fno-common -isysroot /sys -fcolor-diagnostics -ftime-report \
  -triple wasm32-unknown-wasi -internal-isystem /sys/include -internal-isystem /sys/lib/clang/8.0.1/include \
  -O0 -emit-obj -o /program.o /program
```
> **Target Triple**：`wasm32-unknown-wasi`（生产代码实际值，见 `ide-wasi-worker.js` C 分支与 `runno-runtime.js` 内建 clang）。
> v3 前为笔误 `wasm32-unkown-wasi`（vendor 拼写错误，Clang 归一化后不影响 codegen），v3 已校正。
- **不加 `-Werror`**（§8）：以 GCC11 实际 exit code 为准，warning 可展示但不得升级为 CE。
- **`-fno-common`**：规避 clang 8.0.1 wasm32 对 C 暂定定义非 static 全局数组的 codegen 崩溃（详见 §KNOWN）。

### Link（C 分支，wasm-ld）
```
wasm-ld --no-threads --export-dynamic -z stack-size=8388608 \
  -L/sys/lib/wasm32-wasi /sys/lib/wasm32-wasi/crt1.o /program.o -lc \
  -lc-printscan-long-double -L/sys/lib/clang/8.0.1/lib/wasi -lclang_rt.builtins-wasm32 \
  -o /program.wasm
```
- **栈 8MB**：容纳 C 局部大数组（如 `long long a[100005]`），对齐 GCC11 Linux 默认栈。
- **`-lc-printscan-long-double`**：C long double 完整支持（§6 决定）。

## 4. compiler-rt builtins 状态

**正常。** C 链接过程正确进入 `-lclang_rt.builtins-wasm32`，未出现 `__lttf2 / __divdi3 / __muldi3` 等 builtin missing。37 个 ACM 算法程序（含矩阵快速幂、大数组、Dijkstra 手写堆）全部链接通过。

## 5. 测试集概览

| 测试集 | 数量 | 说明 |
|--------|------|------|
| `compat-tests/c11/features/` | 23 | C11 基础功能（stdio/stdlib/string/math/integer/inttypes/ctype/struct/pointer/function pointer/recursion/dynamic memory/qsort/bsearch/assert/errno/time/stdbool/stddef/limits/VLA/complex/long double） |
| `compat-tests/c11/features/math-runtime/` | 7 | 运行时输入数学（sqrt/pow/sin/cos/floor/ceil/fabs/hypot/combo） |
| `compat-tests/c11/negative/` | 10 | 负向 CE（按 GCC11 实际 exit code 判定） |
| `compat-tests/c11/warnings/` | 5 | GCC11 只 warning+PASS 的用例（验证 -Werror 不误杀） |
| `compat-tests/c11/acm-corpus/` | 37 | 真实纯 C11 算法程序 |
| **合计** | **82** | 标准兼容统计 = positive 67（features 23 + math-runtime 7 + acm 37）+ negative 10 + warnings 5 |

## 6. 核心 Match Rate（达成）

| 指标 | 数值 | 判定 |
|------|------|------|
| **Positive Compile Match** | **100%**（67/67） | ✅ 正向零丢失（features 23 + math-runtime 7 + acm-corpus 37，含 37 个真实 ACM corpus） |
| **Negative CE Match** | **100%**（10/10） | ✅ 按 GCC11 实际 exit code 判定 |
| **Warning-No-CE** | **100%**（5/5） | ✅ GCC11 warning+PASS → Browser PASS，`-Werror` 不误杀 |
| **Deterministic Runtime Output Match** | **100%**（70/70） | ✅ Browser==Server，含 long double `%Lf` 默认启用 |
| **Correctness（三方）Output Match** | **100%**（48/48） | ✅ Browser==Server==Expected |
| **Runtime Unsupported** | **0** | — |
| **Mismatches** | **0** | — |

> 说明：`correctness 48/48` = 37 acm-corpus + 4 features（`01_stdio`/`06_inttypes`/`21_vla`/`23_long_double`，含 expected 注解）+ 7 math-runtime。
> `23_long_double` 计入 correctness：使用 `%.2Lf` 格式化，验证 `-lc-printscan-long-double` 路径下 long double 三方一致。
> 收尾修正：`01_stdio.c` 原逻辑 `getchar()` 会读到 `scanf("%d %d")` 残留的换行，导致输出含空行、expected 协议（`// expected:` 块跳过空行）无法精确表达。已改为显式消费残留换行，使输出确定化为 `8\nA\nhello world`（getchar 稳定读到 `A`、fgets 读到 `hello world`），server/browser 三方一致。

## 7. Deterministic Output（自动 diff）

所有 deterministic ACM/features 用例的 Browser stdout 与 GCC11 stdout **逐字一致**（自动 diff，100%）。

## 8. long double PoC / 最终决定（§6）

**A/B 评测**（A=默认 libc，B=+`-lc-printscan-long-double`，median of 3）：

| 用例 | A（默认 libc） | B（+printscan） | sizeDelta |
|------|----------------|-----------------|-----------|
| `printf("%Lf")` | **FAIL**（formatting disabled） | **PASS** `3.14 / 3.14159265358979323846`（精确） | **+25.8KB** |
| `scanf("%Lf")` | **FAIL**（exit 134） | **PASS** `4.2183` | **+45.5KB** |
| 普通 `printf` int/double | PASS `8 3.25` | PASS `8 3.25`（无回退） | +25.8KB |
| A+B | PASS `8` | PASS `8`（无回退） | +52.6KB |
| qsort | PASS | PASS（无回退） | +52.6KB |
| 算法 BFS | PASS | PASS（无回退） | +52.6KB |

**结论**：C **没有 iostream 问题**（C++ 的 cout/cin long double 集成失败，C 的 printf/scanf `%Lf` 完全可用）。
满足 §6 全部条件（完整支持 + 只增几十 KB + link 影响小 + 普通程序无回退）→
**C11 profile 默认启用 `-lc-printscan-long-double`**。这是 C11 专属决定，**未反向修改冻结的 C++ Runtime**。

### long double 回归（数学库改动后，§6 收尾确认）

math library 策略冻结后（Server Reference `-lm`、Browser 走 WASI libc 内建 math），重跑 long double 相关用例确认**无回退**：

| 用例 | 结果 |
|------|------|
| `23_long_double`（`%.2Lf` 加法/乘法/精确比较） | ✅ 三方一致 `3.75 / 3.38 / 1`，计入 correctness 48/48 |
| `printf("%Lf")` / `scanf("%Lf")` A/B（§8 表） | ✅ 仍为 B 方案（+printscan）PASS，A 方案 FAIL，无回退 |
| 普通 A+B / qsort / BFS（无 long double） | ✅ 无回退 |

> 结论：数学库改动（`-lm` / libc 内建 math）**不影响** long double `%Lf` 路径；`23_long_double` 在 features 使用**多行 `// expected:` 块**（非单行 `=>`），当前已计入 correctness。

## 9. GCC11 C Reference 建立（§7）

- 全部测试双端运行：Browser（Clang WASI `-std=c11`）vs Server（gcc-11 `-std=c11`）。
- **不用 g++**；C 侧 `gcc-11`。
- **以 GCC11 实际 exit code 为准**，不臆断 CE。实测关键差异：
  - `incompatible_pointer` / `invalid_return_type`（`double *p=&int`、`return "str"` for int）在 GCC11 **无 `-Werror` 下是 warning+PASS**，不是 CE → 归入 `warnings/` 而非 `negative/`。
  - `implicit function declaration` 无 `-Werror` 时仅 warning+PASS（Browser 也不误杀）。
- Browser 兼容目标 = **match Server Compile Result**，而非"我们认为不规范就强制 CE"。

## 10. `-Werror` 处理（§8）

- C 分支**不加 `-Werror`**。
- 测试报告区分 Warning 与 Compile Error：`warnings/` 目录验证 "GCC11 warning+PASS → Browser PASS"。
- 反向误杀已消除（此前 C 分支沿用 C++ 的 `-Werror` 导致 `%u`/`%d` format 用例 Browser CE / GCC11 PASS）。

## 11. C11 Negative CE Test（§9）

`compat-tests/c11/negative/`（10 个，全部双端 CE）：
`syntax_error_semicolon` `syntax_error_bracket` `undeclared_variable` `redefinition` `wrong_argument_count` `invalid_array_expression` `const_violation` `invalid_struct_member` `duplicate_case` `missing_header`

**判定**：全部按 GCC11 实际 exit code。**未复制 C++ Header Ownership Table 给 C**；
仅当发现真实 libc/WASI 传递 include 造成 Browser PASS/Server CE 才设计 C11 Compatibility Guard。
当前 10 个 negative 双端一致，**无需 C11 Compatibility Guard**。

## 12. 真实 C ACM Corpus（§10）

`compat-tests/c11/acm-corpus/`（**37 个**纯 C11 算法程序，全部为真实 C 写法：stdio/数组/struct/malloc/函数/指针）：
A+B、qsort 排序、二分、前缀和、差分、BFS、DFS、Dijkstra（手写堆）、Floyd、SPFA、并查集、Kruskal、Prim、
KMP、Trie、单调栈、单调队列、01 背包、完全背包、LIS、LCS、树状数组、线段树、快速幂、矩阵快速幂、质数筛、
gcd/lcm、模逆、字符串哈希、计算几何（double，纯算术避免 -lm）、链表 struct、malloc 动态二维数组、
function pointer qsort comparator、大数组、二分答案、DFS 迷宫、拓扑排序。

**禁止 C++ 改扩展名**：全部为独立编写的 C 程序。所有 deterministic case 的 Browser/GCC11 stdout 自动 diff = 100%。

## 13. Capability 分层（§11）

四层模型，全部如实记录：

| Layer | 覆盖 | 状态 |
|-------|------|------|
| **Layer 1 Header Compatibility** | 标准 C 头（stdio/stdlib/string/math/ctype/inttypes/stdbool/stddef/limits/float/complex/assert/errno/time） | ✅ P0 |
| **Layer 2 Compiler Capability** | C11 语法（struct/union/enum/pointer/VLA/complex/long double/function pointer/recursion） | ✅ P0 |
| **Layer 3 Runtime/Link Capability** | libc + compiler-rt builtins + `-lc-printscan-long-double` + malloc/free/qsort/bsearch | ✅ P0 |
| **Layer 4 Host/WASI Capability** | wasm32 ABI 差异、栈大小、文件系统 | ⚠️ 部分（见 Known Divergences） |

## 14. 性能 Benchmark（§16，bench-c11.js，n=10）

| Case | artifact bytes | cold compile | warm compile median/p90 | link | execution median | total |
|------|----------------|--------------|--------------------------|------|------------------|-------|
| A `int main(){return 0;}` | 13KB | 63ms | **7 / 10ms** | 3ms | 0.23ms | 24ms |
| B stdio A+B | 102KB | 68ms | **13 / 21ms** | 4ms | 1.23ms | 33ms |
| C stdio+stdlib+string | 60KB | 21ms | **13 / 15ms** | 3ms | 1.30ms | 31ms |
| D qsort | 106KB | 16ms | **12 / 13ms** | 3ms | 1.69ms | 31ms |
| E BFS | 132KB | 16ms | **13 / 15ms** | 3ms | 1.43ms | 30ms |

> 表内为 **v3（Target Triple 校正后）最终复测**（`bench-c11.js`，n=10，localhost:3001 + headless Chromium），
> warm compile 稳定在 7-13ms，与历史基线一致，**Triple 校正无性能回退**。首次 cold compile 主要受 llvm Module 初始化影响（60-75ms）。

**与 C++ 对比**（同一 Browser）：
- C `<bits/stdc++.h>` A+B 不存在；C 的 B（stdio A+B）warm compile **median ~12ms**。
- C++ `<bits/stdc++.h>` A+B warm compile **median ~150-206ms**（`bench-ab.js` 冻结基线）。
- **C 明显更轻（~15-20x）**，符合"头文件轻"预期，但为实测值，未提前写死目标。

## 15. KNOWN_DIVERGENCES（§11，按 Layer）

| 差异 | Layer | 说明 | 处理 |
|------|-------|------|------|
| `size_t`=4 字节、`long`=32 位 | Host/WASI ABI | wasm32 与 x86-64 的 `long`/`size_t` 宽度不同（`LONG_MAX`=INT_MAX） | **固有**，不修改；用例规避平台相关值 |
| glibc `isdigit` 返回位掩码（2048）、musl 返回 1 | Runtime/STL | C 标准只保证非零 | Allowed Implementation Divergence；用例用 `(x != 0)` 布尔化 |
| `strtol("zzz")` 是否设 `EINVAL` | Runtime/STL | glibc 不设、musl 设（实现定义） | Allowed Divergence；用例只测确定性 ERANGE |
| ~~`sqrt`/`fabs` 等需要 `-lm`~~ | ~~Compiler/Runtime~~ | ~~GCC11 reference 命令无 `-lm`，`sqrt` 变量会 link 失败~~ | **已解决（v2）**：Server Reference 正式冻结为 `gcc-11 -std=c11 <src> -lm -o <out>`；Browser 走 WASI libc 内建 math；`features/math-runtime` 7 例 runtime 数学三方 100% 一致 |
| `<signal.h>` / `<setjmp.h>` / `<threads.h>` | Host/WASI | WASI 不支持（或属 P1） | **P1**，不提供错误空壳 |
| 文件系统（fopen/fread 路径） | Host/WASI | 不作为 P0 必须能力 | P1，不承诺完整 Linux FS |

> 无"浏览器行为错误的空壳实现"。所有差异如实归因到具体 Layer。

## 16. Artifact Cache（Compile Once, Run Many，§14）

- Key 含 `language`（c11 vs cpp11）、`optLevel`、`pchLevel`、`longDouble`、`sourceHash` → **C/C++ source 不会误复用 artifact**。
- 已验证：同一 C 源码编译一次后，换 stdin（Sample1/Sample2/自定义输入）复用编译产物，不重复 compile。
- 实测 compile 命中 `cacheHit` 后跳过 compile（warm total 远低于 cold）。

## 17. Execution Time 验证（§13）

定义与 C++ **完全一致**：只含用户程序执行 + stdin + stdout flush，**不含** Compiler Init / Compile / Link / Wasm Compile / Wasm Instantiate。
UI 主指标 `运行时间：X ms`，次要 `编译耗时：Y ms`。实测各用例 execution 独立 ms 级（见 §14）。

## 18. P0 Supported Profile

标准单线程 ACM/OJ C11 算法竞赛子集：
- **stdio**：printf/scanf/getchar/putchar/fgets/puts
- **stdlib**：malloc/calloc/realloc/free/abs/labs/llabs/atoi/strtol/qsort/bsearch
- **string**：strlen/strcmp/strcpy/strncpy/memcpy/memset/memcmp/strchr
- **math**：sqrt/pow/fabs/sin/cos/floor/ceil（含 long double %Lf）
- **类型**：int/long/long long/unsigned/uint32_t/uint64_t/int64_t、PRI/SCN 宏、bool、struct/union/enum、指针/函数指针、VLA、complex 基础运算
- **算法**：图/DP/数学算法模板（最短路/并查集/KMP/Trie/背包/线段树/树状数组/快速幂/矩阵快速幂/质数筛等）
- 全局大数组（含 `-fno-common`）、局部大数组（8MB 栈）

## 19. P1 清单（接受/不修）

- `<signal.h>` / `<setjmp.h>` / `<threads.h>` / C11 threads（WASI 无对应运行时）
- 完整 Linux 文件系统（fopen/fread/fwrite 路径）
- WASI 原子操作 / dynamic linking / runtime.wasm 拆分 / Clang 升级 / Clang Modules
- C PCH（实测 warm compile 已足够快，无 Header Parse 瓶颈，不引入）

## 20. C++ Frozen Regression 结果（§1 门槛）

改动 `ide-wasi-worker.js`（C 分支加 `-fno-common`、去 `-Werror`、8MB 栈）与 `ide-runner.js`（LANG_PROFILES + C11 runtimeId）后，**本轮复测通过**：

| 回归项 | 命令 | 结果 |
|--------|------|------|
| PCH 语义中性 | `node verify-pch-neutral.js` | `checked=51 diff=0` ✅（C++ 不受影响） |
| GCC11 Header Strict Check | `node test-header-check.js` | `pass=94 fail=0` ✅（漏头预检/豁免全部正确） |
| C++ `-Werror` / PCH / Header Check 路径 | — | 未改动（`-fno-common` 仅加 C 分支） |
| C++ 性能基线 | `bits/bench-ab-final.js`（n=10） | warm compile **median 158ms / p90 169ms**（回到历史 150-206ms 基线内，无回退） |

> 结论：C11 改动（含 Target Triple 拼写校正）未破坏已冻结的 `cpp11-gcc11-compat-v4` 运行时；C++ 冻结回归门槛全部满足。

## 版本升级规则（冻结）

> **runtimeId 内任一组件（compiler / runtime / clang flag / sysroot hash / compiler flags / stack size / long double 策略）发生改变，
> 都必须生成新的 Runtime Version（`c11-gcc11-compat-v3` 等），禁止静默覆盖当前冻结版本。**

机器可读清单见 `server/public/js/contest/runtime-manifest-c11.json`；能力矩阵见 `compat-tests/capability-matrix-c11.json`。

## 本轮禁止继续做（冻结清单）

- 为 C 强行做 PCH / Clang 升级 / Atomics / pthread / C11 threads / WebVM / dynamic linking / runtime.wasm 拆分
- 复制 C++ Header Ownership Table 给 C（除非发现真实 libc 传递 include 误放行）
- 完整 Linux filesystem / 复杂 Package Manager
- Java / Python（本阶段只做 C11）

> 以上除非后续明确解除冻结。
