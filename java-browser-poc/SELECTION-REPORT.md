# Java 21 Browser Local Runtime 选型报告（Selection Report）

> 项目：Mini-OJ —— Chrome 浏览器多语言编译运行与服务器权威判题
> 报告日期：2026-08-20 | 阶段：Runtime Enhancement Phase（Java Browser Local 选型研究）
> 现状基线：C/C++（Clang 8.0.1 + WASI，`cpp11-gcc11-compat-v4` / `c11-gcc11-compat-v3`）与 Python 3（Pyodide 0.26.4，`py312-cpython-compat-v1`）已冻结 FINAL FROZEN。
> 目标：在浏览器内本地编译并运行 Java 21 源码；UX 与 C/C++/Python Local Run 完全一致（Web Worker、永不冻结 UI、Capped stdout 1 MiB、Local CE / RE 分类、Local Timeout 由 SAB KeyboardInterrupt 或 terminate 兜底）。

---

## 0. 摘要 Executive Summary

经过对四个候选方案的逐项可行性研究（基于 2025-2026 公开仓库 README、releases、Issues 与本 OJ 冻结约束的对照）：

**结论：四个候选方案当前都无法在「与现有 C/C++/Python 同级别的 P0 FINAL FROZEN」层面满足需求。** 推荐的处理路径：

1. **P0 期：本特性标记为 `Experimental / Not Available for P0`**，Java21 语言在 UI 上仍可选（前端 select 添加 `Java 21`）但 **Local Run 区显示「暂不支持本地运行，请直接正式提交」**；OJ 端 Official Judge 已具备完整 Java 21 路径（`judge-adapter.js#compileJava` + `language-profiles.js#java21`），正式提交立即可用。
2. **冻结一个 `java21-openjdk-wasm-compat-vX` 占位 `runtimeId`**，禁止生产资产携带真实 OpenJDK WASM；如同日后引入，必须按下文 **§5 P0 PoC 实施步骤** 升级 v 号。
3. **P1 期：仅当满足以下任一条件再启动正式接入**：
   - 上游如 `Yaossg/JavaBox` 文档声明"OpenJDK 21 全部特性支持"并提供运行时 size < 30 MB；
   - CheerpJ 商业版以外出现自由使用、Java 21 完整支持、System.in 可读的社区构建；
   - 实验室构建出针对 OpenJDK 21 的 WasmGC + Threading 路径，并在 5 MiB-30 MiB 体积上限下稳定可中断；
   - 至少有第二个项目（如 Vloxy/Mainmatter）进入维护期且承诺 Java 21 兼容。

任何 Plan A 的真实投入（裁剪 OpenJDK、构建 plugin/JVMTI/awt headless、生成 AOT classlib）都属于独立工程专题，不能塞进 P0 计划。

---

## 1. 评估维度定义

| 维度 | 简写 | 通过门槛 |
|---|---|---|
| Java 21 Compatibility | `J21` | 至少支持 var、records、sealed classes、pattern matching、virtual threads 中可编译运行的部分子集（≥ 5 项） |
| Browser Compile | `BC` | 真`javac`能跑在浏览器内，可对源码做 `javax.tools.JavaCompiler` 风格的语义/语法分析 |
| Browser Run | `BR` | 浏览器内可直接 exec 字节码（含 invocation / GC / threading / IO） |
| stdin/stdout | `IO` | `System.in` 可按行/全缓冲读，`System.out`/`System.err` 实时流到宿主 |
| Compile Error | `CE` | 真实 javac 风格诊断（含源码位置、warning level），而非简陋字符串匹配 |
| Runtime Error | `RE` | 真实 Java 异常 + 完整 stacktrace 行号，与服务器 OpenJDK 输出风格一致 |
| Timeout | `TLE` | SAB+Atomics.wait 或 Worker.terminate 二选一可中断，且不冻主 UI |
| Cold Start | `Cold` | P0 同级阈值：最大 < 30 MB 资产、Cold Network Start < 8 s、Cached Cold < 4 s |
| Runtime Size | `Size` | 总体字节 ≤ 30 MB（解压后 ≤ 80 MB）才考虑上线 |
| License | `Lic` | Apache-2.0 / MIT / BSD / GPL-2/3(配合 classpath exception)。排斥 SSPL、Elastic v2、AGPL、商业付费 |
| Self-host | `Self` | 能在 `server/public/js/runtime/java21/<version>/` 下托管，HTTP `immutable` 长缓存 |
| Integration | `Intg` | 可复用现有 `ide-runner.js` 暴露的 `prewarm/compileArtifact/execArtifact` 接口 + `runtime-manifest-*` manifest 形态 + `language-profiles.sanitizedPublicProfile()` 返回结构 |

---

## 2. Plan A：OpenJDK 21 → WebAssembly + Persistent JVM + `javax.tools.JavaCompiler`（JavaBox 风格）

**核心思路**：用上游 Yaossg/JavaBox 或类似项目，把 OpenJDK（或部分）编译到 WASM，浏览器内启动 Persistent JVM + `javax.tools.JavaCompiler`（JSR-199）。

**结论**：理论上能达到 P0 同级别，但当前**不是现成方案**，需要一两周工程构建。

| 维度 | 评估 |
|---|---|
| J21 | ⚠️ JavaBox 当前文档声称 JDK 8 语义为主；OpenJDK 21 → WASM 需重新构建且路径不稳定 |
| BC | ✅ `javax.tools.JavaCompiler` 是 JSR-199 标准，可实现 |
| BR | ⚠️ JVM on WASM 已有原型（CheerpJ、JavaBox 内部），但完整 OpenJDK 21 在 WASM 上仍属前沿 |
| IO | ⚠️ System.in 需 SharedArrayBuffer 桥接，文档未提供完整实现 |
| CE/RE | ✅ 标准 javac 风格 |
| TLE | ⚠️ 虚拟线程在 WASM 上中断响应慢，GC 暂停不可预估 |
| Cold/Size | ❌ OpenJDK 21 即使最小裁剪也 > 30 MB；远超 Python/C++ |
| Lic | ⚠️ OpenJDK GPL+CE，资产可发布；JavaBox 自有协议需查 |
| Self/Intg | ✅ 理论可行 |

**判定**：P0 不接入。仅在投入独立工程专题且达成 < 30 MB / Cold < 8 s 时考虑。

---

## 3. Plan B：CheerpJ（Browser JVM + bytecode → JavaScript）

**核心思路**：CheerpJ 把 Java bytecode 转译为 JavaScript 在浏览器执行（不需 WASM）。

**结论**：成熟商品，但**只支持 Java 8–17（不完整支持 Java 21）**；Community Edition 仅允许非商业用途；System.in / 完整 stdlib 在浏览器端受限。

| 维度 | 评估 |
|---|---|
| J21 | ❌ 官方支持 Java 8–17；Java 21 records/sealed/virtual threads 多数未覆盖 |
| BC | ❌ 不做 Java → bytecode 编译（只翻译已有 bytecode） |
| BR | ✅ Java bytecode → JS 执行 |
| IO | ⚠️ System.in 需特殊配置 |
| CE | ⚠️ 不是 javac，是 bytecoder；CE 体验差 |
| RE | ✅ 标准异常 |
| TLE | ❌ 无 SAB 中断；只靠 Worker.terminate |
| Cold/Size | ⚠️ CheerpJ runtime 较大；初次加载需 > 8 MB |
| Lic | ⚠️ Community 仅非商业，商业需付费 |
| Self | ❌ CheerpJ 默认 CDN，自托管复杂 |

**判定**：P0 不接入（License + Java 21 不支持双重阻挡）。可考虑 P1/P2 商业合作或等 CheerpJ 4 自由版。

---

## 4. Plan C：WebVM + Linux + OpenJDK

**核心思路**：用 Leaning Technologies WebVM 在浏览器内跑完整 Linux，然后装 OpenJDK。

**结论**：功能可行（Linux + 全套工具），但**体积过大（基础 50 MB+，含 OpenJDK 后 > 200 MB）**，不适合 OJ 本地自检场景。

| 维度 | 评估 |
|---|---|
| J21 | ✅ 完整 OpenJDK 21 |
| BC | ✅ 真 javac |
| BR | ✅ 真 JVM |
| IO | ✅ 完整 System.in/out |
| CE/RE | ✅ 标准 javac/JVM |
| TLE | ⚠️ SAB 中断需要定制 |
| Cold/Size | ❌❌ 总资产 > 200 MB |
| Lic | ⚠️ WebVM 部分协议需查 |
| Self | ⚠️ 复杂 |
| Intg | ❌ 与现有 Python/C++ Worker 架构差异巨大 |

**判定**：P0/P1/P2 均不接入。资源代价不可接受。

---

## 5. Plan D：GraalVM Web Image

**核心思路**：用 GraalVM 把 Java 程序 AOT 编译到 WASM/JS。

**结论**：**只能跑预编译 AOT binary，不支持浏览器内 Java 源码编译**。与本 OJ 目标（用户写 Java 源码 → 浏览器编译）不匹配。

| 维度 | 评估 |
|---|---|
| J21 | ✅ |
| BC | ❌ 不做浏览器内 Java 源码编译（只 AOT 预编译） |
| BR | ✅ |
| IO | ⚠️ AOT 后 stdin 行为变化 |
| CE | ❌ 无 |
| RE | ✅ |
| TLE | ⚠️ |
| Cold/Size | ⚠️ |
| Lic | ⚠️ GraalVM CE 有协议要求 |
| Self | ⚠️ |
| Intg | ❌ |

**判定**：不适用于 OJ 场景（用户必须能在浏览器写代码并即时编译）。

---

## 6. 最终推荐矩阵

| 维度 | Plan A (JavaBox/WASM) | Plan B (CheerpJ) | Plan C (WebVM) | Plan D (GraalVM Web) |
|---|---|---|---|---|
| J21 | ⚠️ | ❌ | ✅ | ✅ |
| BC | ✅ | ❌ | ✅ | ❌ |
| BR | ✅ | ✅ | ✅ | ✅ |
| IO | ⚠️ | ⚠️ | ✅ | ⚠️ |
| CE | ✅ | ⚠️ | ✅ | ❌ |
| RE | ✅ | ✅ | ✅ | ✅ |
| TLE | ⚠️ | ❌ | ⚠️ | ⚠️ |
| Cold | ❌ | ⚠️ | ❌❌ | ⚠️ |
| Size | ❌ | ⚠️ | ❌❌ | ⚠️ |
| Lic | ⚠️ | ⚠️ | ⚠️ | ⚠️ |
| Self | ✅ | ❌ | ⚠️ | ⚠️ |
| Intg | ✅ | ⚠️ | ❌ | ❌ |
| **结论** | **P1 投入** | **P2 观望** | **P0–P2 均不** | **不适用** |

---

## 7. P0 最终决策

- **Java21 Official Judge = Stable**：服务器端 javac→java 路径已接通（`judge-adapter.js#compileJava`），可直接正式提交。
- **Java21 Browser Local = Experimental / Not Available**：UI 上 Java 21 选项可见但 Local Run 区显示「暂不支持本地运行，请直接正式提交」。
- 触发 P1 接入的条件：满足 §0 的四条之一。

---

## 8. P0 PoC 实施步骤（占位，本阶段不实施）

如果未来满足 §0 条件，需要：

1. 选型（JavaBox 或自构建）→ 锁定具体上游 commit + license
2. 编译 WASM → 测量 size / Cold Start
3. 验证 14 项 决策门槛（Java 21 compat / compile / run / stdin / stdout / CE / RE / Timeout / 隔离 / Compile Once Run Many / 30+ ACM corpus / Browser vs Server 100% / Cold Start / Size ≤ 30 MB）
4. 建立独立 runtimeId `java21-openjdk-wasm-compat-v2`（v1 已被本报告冻结占位）
5. 建独立 manifest + sysroot + Asset Hash + 缓存策略
6. 接入 `ide-runner.js` 统一分发（参考 `runPython` 模式：Persistent Worker + onPythonStatus 模式）
7. UI 状态切换：Experimental → Beta → Stable
8. 全语言 E2E 回归 + Frozen Regression