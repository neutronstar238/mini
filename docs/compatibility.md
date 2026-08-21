# Browser C++ 运行时 vs GCC 11 兼容性说明

> **Browser C++11 Runtime：`P0 FROZEN`（`cpp11-gcc11-compat-v4`，冻结于 2026-08-20）**
> 后续开发默认不得修改该 Runtime 核心逻辑。冻结基线见
> [docs/runtime-freeze-cpp11.md](./runtime-freeze-cpp11.md)，
> Known Divergences 见 `compat-tests/KNOWN_DIVERGENCES.md`，
> 机器可读 manifest 见 `server/public/js/contest/runtime-manifest-cpp11.json`。

> 本说明面向最终用户/维护者，总结 Browser 内 C++11 编译器（Clang 8.0.1 + WASI libc++ +
> `cpp11-gcc11-compat-v3` shim + bits PCH + **GCC11 Header Strict Check**）与正式
> **GCC 11（-std=c++11）** 的兼容性边界。
> 详细机器可读数据见 `compat-tests/capability-matrix.json`，完整报告见
> `compat-tests/capability-report.md`，冻结的参照环境元数据见 `compat-tests/reference.json`。

## 参照环境（frozen reference）

- **GCC11 参照机**：yqzl 服务器（Ubuntu 24.04.4 LTS）
- **编译器**：`gcc-11` / `g++-11` = `11.5.0-1ubuntu1~24.04.1`
- **编译标准**：`-std=c++11`（C）`-std=c11`
- **Browser 侧**：`cpp11-gcc11-compat-v4`（Clang 8.0.1 + WASI libc++ + v3 shim + `bits/stdc++.h` PCH）
- 说明：禁止用宿主 GCC 15 的编译结果近似声称 "GCC 11 兼容"。所有兼容性结论均以
  `reference.json` 记录的冻结 GCC11 环境为基准。

## 兼容性结论（P0 标准单线程算法竞赛子集）

基于 **75 个正向**（Server 能编译的标准 ACM 程序）与 **13 个负向**（应 CE）真实用例的双端比对：

| 指标 | 数值 |
|------|------|
| Positive Compile Match（Server 能编译 → Browser 也能编译） | **100%** |
| Negative CE Match（Server 应 CE → Browser 也应 CE） | **100%**（13/13） |
| Deterministic Runtime Output Match（确定性算法输出一致率） | **100%**（72/72） |

**结论**：P0 范围内，Browser 对标准单线程 ACM C++11 代码的**编译能力与 GCC11 完全对齐
（正向零丢失、负向零误放行）**，确定性算法输出与 GCC11 完全一致。

### 运行时输出重新分类（不再混成单一数字）

- **Allowed STL Implementation Divergence（1）**：`uniform_int_distribution` 等分布映射实现不同
  （`mt19937` 原始序列两端一致，属允许的 STL 实现差异，不伪造）。
- **Host-dependent Output（1）**：`chrono::elapsed_ms` 真实计时跨端必然不同（测试只校验计算结果，不把计时纳入 exact-match）。
- **Known Runtime Unsupported（2）**：long double 格式化输出（见下）。

## GCC11 Header Strict Check（Local CE 预检）

**目的**：在 Browser 本地显示"编译成功"前，尽量消灭"Browser libc++ 因传递 include 错误放行、
但 GCC11 正式提交会 CE"的负向误放行（典型：漏写 `<algorithm>` 但用了 `std::sort`）。

**规则**：
- 仅对**非 `bits/stdc++.h`** 源码触发；显式 `#include <bits/stdc++.h>` 直接豁免。
- 判定依据 = 用户显式 include 集合 + P0 高频实体的标准头归属（Ownership Table）。
- **不修改 libc++、不删声明、不补 shim**；bits 显式包含 = 用户主动选择完整 GNU ACM Header 环境。
- 结果按 `sourceHash + runtimeVersion + gccCompatVersion` 缓存；纯 JS token 级扫描，延迟 ~1ms。

**效果**：`missing_algorithm_header.cpp` 等负向误放行从 Browser PASS 修复为 Browser CE。

## bits/stdc++.h PCH（严格 Gate）

- **只有显式 `#include <bits/stdc++.h>` 才用 bits.pch**；否则一律不用 C++ PCH。
- **禁止**：iostream/common 自动注入、按 vector/sort 猜测 PCH、给无 bits 源码加载额外声明。
- PCH 仅是编译加速，**不改语义**（命中/不命中输出一致）；PCH 命中**不影响** CE 判定。
- shim **不补额外声明**（同一逻辑 bits 版与显式头版输出一致）。

## 已知差异（KNOWN DIVERGENCES，按 Layer）

| 差异 | Layer | 说明 |
|------|-------|------|
| long double 格式化输出（cout/cin 路径） | Link/libc++ | WASI libc++ 默认禁用；PoC 显示 `printf("%Lf")` 可行但 iostream 路径集成不完整，暂不升级 P0 |
| `uniform_int_distribution` 等随机分布输出跨端不同 | Compiler/STL | `mt19937` 序列一致，拒绝采样映射实现不同（Allowed Divergence） |
| `chrono` 计时值跨端不同 | Host-WASI | 真实计时必然不同（Host-dependent） |
| `std::atomic`/`shared_ptr`/`regex` 原子实现 | Compiler | 当前 clang 8 无法 codegen 原子指令，P1 |
| `<thread>`/`<mutex>` 使用 | Link/Host | WASI 无 pthread 运行时，仅头可编译，P1 |
| `std::__gcd`、`__gnu_pbds`、`ext/*` 等 GNU 扩展 | Header（GNU 扩展） | 独立分类，缺失为预期，不补 shim |

> 漏写 `<algorithm>` 等**负向误放行已通过 GCC11 Header Strict Check 修复**，不再列入 Known Divergence。

## 性能

- `<bits/stdc++.h>` A+B 在 Browser 端：warm compile **~206ms**（参考 ~150-200ms，无回退）、
  execution **~7ms**（纯运行时间）。
- **GCC11 Header Strict Check 延迟 ~1ms**（缓存命中 0ms），对普通 Run 无感知。

## 建议

- **竞赛代码**：优先使用标准头 + `using namespace std`，并在需 `sort` 等时显式 `#include <algorithm>`，
  以获得与 GCC11 最一致的行为（Header Strict Check 会在漏写时给出 Local CE 提示）。
- **long double 格式化**：如需在 Browser 输出 long double 高精度，属 P0 范围外；可改用 double。
- **thread/atomic/regex 的原子实现**：P1 能力，不属单线程算法竞赛范围。
