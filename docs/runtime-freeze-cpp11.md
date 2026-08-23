# Browser C++11 Runtime P0 冻结报告

> **状态：`P0 FROZEN`**　冻结日期：2026-08-23
> 本文件是当前 Browser C++11 Runtime 的正式冻结基线。后续开发（C11 / Python / Web IDE / Contest Integration）
> 默认不得修改本 Runtime 核心逻辑；若需变更，必须按 §17 版本升级规则生成新版本。

---

## 1. Runtime ID

**`cpp11-gcc11-compat-v5`**

v5 在 v4 的显式 `-std=c++11` 与内容版本化资产基础上，移除 C++11 源码编译的
`-Werror`。Clang warning 只作为诊断保留，不得把 GCC11 可编译代码升级为 Browser CE；
C++14 泛型 lambda 等真正语法/语义错误仍必须 CE。针对 Codeforces 历史 GNU C++
代码，Worker 还会将字符串字面量中的 `%I64[d/i/o/u/x/X]` 归一化为 `%ll…`，
避免 WASI libc 对 MSVC 风格 length modifier 静默空输出。

冻结目标**不是**"完整替代 GCC11"，而是：
> 为标准单线程 ACM/OJ C++11 代码提供稳定、零安装、浏览器本地编译运行与样例调试能力。

## 2. Compiler / WASI / libc++ 版本（Browser 侧）

| 组件 | 版本 |
|------|------|
| 编译器 | **Clang 8.0.1**（Runno self-host, WASI target） |
| 标准库 | **WASI libc++**（`sys/include/c++/v1`） |
| compatibility shim | `cpp11-gcc11-compat-v3`（`sys/include/bits/stdc++.h`） |
| PCH | `bits.pch`（严格 Gate，见 §5） |
| GCC11 Header Strict Check | `gccCompatVersion=v1`（见 §6） |
| 编译标志 | `-std=c++11 -O0 -isysroot /sys -fcolor-diagnostics -ftime-report` |
| warning 策略 | warning 非致命；以 Clang 非零退出判定 CE |
| 格式兼容 | 字符串字面量 `%I64[d/i/o/u/x/X]` → `%ll[d/i/o/u/x/X]` |

## 3. GCC11 Reference 版本（Official Reference）

| 项 | 值 |
|----|-----|
| 编译器 | GCC/G++ **11.5.x** |
| 版本 | `11.5.0-1ubuntu1~24.04.1` |
| 系统 | Ubuntu 24.04 LTS GCC 11 reference environment |
| 标准 | `-std=c++11`（C 侧 `-std=c11`） |
| 调用 | `ssh <reference-host> "g++-11 -std=c++11 <src> -o <out> && <out> < <in>"` |

> 禁止用宿主 GCC 15 近似结果直接声称 GCC11 兼容；一切结论以 `compat-tests/reference.json` 冻结环境为准。

## 4. Runtime 架构（冻结）

```
Source
  ├─ [严格 PCH Gate] 仅显式 #include <bits/stdc++.h> → bits.pch；否则 NO C++ PCH
  ├─ [GCC11 Header Strict Check] 非 bits 源码做 Local CE 预检（Ownership Table，~1ms）
  │     └─ 失败 → Local CE / "GCC11 兼容性预检失败"
  ├─ Persistent Compiler Worker + Persistent VFS/Sysroot + Runtime Preload
  ├─ Clang 8.0.1 (WASI libc++) → Compile(opt -O0) → Link（compiler-rt builtins 正确链接）
  ├─ Artifact Cache（Compile Once, Run Many）→ Wasm compile/instantiate
  └─ Execution（stdin → stdout/stderr）── Execution Time 独立统计
```
提交模型：**Browser 本地运行不上传源码；仅正式 Submit 才上传服务器。**

## 5. PCH Gate 规则（冻结）

固定规则：
```cpp
// 唯一允许加载 bits.pch 的条件：
#include <bits/stdc++.h>   // 源码显式包含
```
否则：**NO C++ PCH**。

**禁止**：`common.pch`、`iostream.pch` 自动注入、按 `vector/sort/map` 猜测 PCH、
自动加入用户未 include 的 Header、修改用户源码以提高编译成功率。

原则：**PCH 只能优化编译方式，不得改变源码语义。**

## 6. GCC11 Header Strict Check 规则（冻结）

- **保留**，用于识别 libc++ 传递 include 导致的 `Browser PASS / Server GCC11 CE`（如漏 `<algorithm>` 用 `std::sort`）。
- 判定依据 = 用户显式 include 集合 + P0 高频实体标准头归属（Ownership Table）。
- **不改 libc++、不删声明、不补 shim**；bits 显式包含 → 豁免。
- 缓存：`lang | gccCompatVersion | sourceHash` → PASS/CE，源码不变不重跑。
- **性质**：是 **GCC11 Compatibility Guard**，**不是**完整 GCC11 Compiler Frontend。
- **UI 呈现**（不伪装成 Clang 原生 CE）：
  > **GCC11 兼容性预检失败**
  > `std::sort` 需要显式包含 `<algorithm>`。
  > 正式 GCC11 环境预计将产生 CE。

## 7. Artifact Cache 规则（冻结）

- 键：`RUNNO_VERSION | lang | optLevel | pchLevel | longDouble | sourceHash`
- 上限：`ARTIFACT_CACHE_MAX = 8`
- **Compile Once, Run Many**：同一源码换 stdin/跑 Sample1/Sample2 复用编译产物。

## 8. Execution Time 定义（永久冻结）

**"运行时间"** 仅表示：
> 程序完成 **Compile / Link / Wasm instantiate** 后，从正式执行用户程序并提供 **stdin** 开始，
> 到 **main/_start 退出并完成 stdout flush** 的时间。

**禁止**把以下计入 Execution Time：`compiler startup`、`compile`、`link`、`wasm compile`、`wasm instantiate`。

**推荐 UI**：
```
运行时间：6.97 ms      ← 主展示指标
编译耗时：206 ms
链接耗时：17 ms
```

## 9. 当前性能基线（冻结）

`<bits/stdc++.h>` A+B（`compat-tests/bits/bench-ab.js`）：

| 指标 | 数值 |
|------|------|
| warm compile | **150 ~ 206 ms** |
| link | **15 ~ 18 ms** |
| execution | 数 ms ~ 10ms 级（受浏览器调度波动） |
| GCC11 Header Strict Check | **~1 ms**；缓存命中 **~0 ms** |

后续修改其他语言/UI 时，C++ Runtime 必须做 regression test（见 §16）；出现明显回退必须报告。

## 10. Positive Compile Match

**100%**（75/75）——Server(GCC11) 能编译的标准 ACM 代码，Browser 也能编译（正向零丢失）。

## 11. Negative CE Match

**100%**（13/13）——Server(GCC11) 应 CE 的代码，Browser 也应 CE（负向零误放行，含漏头预检）。

## 12. Deterministic Runtime Output Match

**100%**（72/72）——确定性算法输出一致率（排除 Allowed STL Divergence 与 Host-dependent 后）。

补充：原始 74 例双端均运行，其中 1 例 Allowed STL Divergence、1 例 Host-dependent（见 Known Divergences）。

## 13. Known Divergences（冻结）

详见 [KNOWN_DIVERGENCES.md](./KNOWN_DIVERGENCES.md)。分类：Header / Compiler / Link / Runtime / Host-WASI / STL Implementation / GNU Extension。

## 14. P0 Supported Profile（冻结）

标准单线程 ACM/OJ C++11 算法竞赛子集：
- 容器 `vector/array/deque/list/stack/queue/priority_queue/map/multimap/set/multiset/unordered_*`
- 算法 `sort/stable_sort/binary_search/lower_bound/upper_bound/nth_element/reverse/unique/next_permutation`
- 数值 `numeric(accumulate/iota)`、`cmath`、`bitset`、`type_traits`、`string/iostream/cstdio`
- `pair/tuple`、lambda/auto、move/emplace、`mt19937`（原始序列）
- 图/DP/数学算法模板（最短路/并查集/KMP/背包/线段树/快速幂等）

## 15. P1 功能清单（接受/不修）

- `std::atomic` / `shared_ptr` 当前 atomic 路径 / `std::regex` 当前 atomic 路径
- `std::thread` / `std::mutex` / `pthread`
- `csetjmp` / `csignal`
- `std::__gcd` 等 GNU 内部扩展 / `__gnu_pbds` / 其他 GNU-only headers/API
- `uniform_int_distribution` 与 libstdc++ 输出完全一致（Allowed STL Divergence）
- `chrono` 实际时间完全一致（Host-dependent）
- long double iostream 格式化（需 P1 Runtime Upgrade，见 §15.1）

### 15.1 long double PoC 结论（冻结）

已实测：加 `-lc-printscan-long-double`（在 `-lc` 前）后：
- `printf("%Lf")` / `scanf("%Lf")` **可正常**。
- `cout << long double` / `cin >> long double` 仍存在 libc++/WASI 集成问题（值丢失）。

**结论**：long double iostream formatting **暂不进入 P0，不再修**；如需未来处理，单独作为 **P1 Runtime Upgrade** 任务。

### 15.2 random / chrono 分类（冻结）

- `uniform_int_distribution`：`mt19937` 原始序列一致，libstdc++/libc++ 分布映射实现不同
  → **Allowed STL Implementation Divergence**，不修。
- `chrono`：实际运行时间属 **Host-dependent Output**，不作为 stdout exact-match，不修。

## 16. Regression Test 命令（冻结）

```bash
# 1) Header Strict Check 单元测试
node compat-tests/test-header-check.js
# 2) Positive Compile / Negative CE / Deterministic Output（需本地 server + yqzl server）
cd compat-tests
node run-browser.js --json > _browser_all_final.json   # 需 server 运行于 localhost:3001
node run-server.js                                     # 需配置自己的 GCC 11 reference host
node compare.js --server=_server_all.json --browser=_browser_all_final.json --out=capability-matrix.json
# 3) bits PCH regression（PCH on/off 语义中性）
node verify-pch-neutral.js
# 4) A+B performance benchmark
node bits/bench-ab.js
```
回归门槛：Positive ≥100%、Negative ≥100%、Deterministic Output ≥100%、bits PCH diff=0、
warm compile 无显著回退。任何一项不满足即视为破坏 P0。

## 17. Runtime manifest / hash（冻结）

机器可读清单见：`server/public/js/contest/runtime-manifest-cpp11.json`

| 组件 | 版本/值 |
|------|---------|
| Runtime ID | `cpp11-gcc11-compat-v5` |
| Compiler | Clang 8.0.1 |
| Runtime/Runner | `RUNNO_VERSION = 0.10.0-ojc4` |
| shim version | `cpp11-gcc11-compat-v3` |
| PCH version | `bits`（严格 Gate） |
| gccCompatVersion | `v1` |
| sysroot hash (SHA256) | `B2E4B0F28A2C56B80CA43B61DC1CA2B62B8263B582735504E6C376FED4B1F363` |
| compiler flags | `-std=c++11 -O0 -isysroot /sys -fcolor-diagnostics -ftime-report` |

## 18. 后续修改时的版本升级规则（冻结）

> **runtimeId 内任一组件（compiler / runtime / shim / PCH / gccCompatVersion / sysroot hash / compiler flags）发生改变，
> 都必须生成新的 Runtime Version，禁止静默覆盖当前冻结版本。**

- 任何核心逻辑变更前：先建立新版本号（如 `cpp11-gcc11-compat-v6`）、更新 manifest、跑完整 regression。
- 不解除冻结不得：继续无限增加 C++ compatibility cases、追求 C++11 100% 标准库兼容。

---

## 本轮禁止继续做（冻结清单）

- Clang Modules / runtime.wasm + user-module.wasm / dynamic linking / prelinked runtime
- Clang upgrade / Wasm Atomics / pthread / thread support
- common PCH / iostream PCH / WebVM
- GNU PBDS compatibility / 完整 libstdc++ 移植
- 继续无限增加 C++ compatibility cases / 继续追求 C++11 100% 标准库兼容

> 以上除非后续**明确解除冻结**。
