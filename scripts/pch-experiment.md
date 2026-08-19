# Web IDE Browser Runtime 优化与 PCH 实验记录

> 架构：`ide-wasi-worker.js`（Persistent Compiler Worker + 干净 Exec Worker）
> + `ide-runner.js`（主线程调度：Artifact Cache / Module Cache / speculative compile）。
> PCH 已由实验转正（UI「PCH 加速（自动）」开关，默认开启，仅 C++）。

## 自动 PCH 分层（当前设计）

用户 Source 扫描显式 `#include`（`ide-runner.js` 的 `detectPchLevel`）：

```
用户 Source
     │
     ▼
扫描显式 #include
     ├─ 含 bits/stdc++.h  → bits.pch
     ├─ 含 iostream       → iostream.pch
     └─ 其他             → 正常 Header Parse
```

- UI 勾选「PCH 加速（自动）」→ 传 `pchLevel='auto' + pchEnabled=true`，runner 自动选层级。
- 两档 PCH 均在同一常驻 Compiler Worker 内生成并常驻 VFS，按 `optLevel|pchLevel` 分别缓存。
- artifact key 纳入 pchLevel，避免跨层级错误命中。

## 架构要点（P0~P5 落地情况）

| 需求 | 实现 |
|---|---|
| Execution Time 精确测量 | Exec Worker 内 `wasi.start()` 前后打点；stdout/stderr Worker 内缓冲随结果回传，计时区间零 IPC |
| Compile Once, Run Many | SHA-256(runtime+lang+optLevel+pch+source) → Artifact Cache；样例自测 = 编译 1 次 + 执行 N 次 |
| Persistent Compiler Worker | clang/wasm-ld 的 WebAssembly.Module + 解包后 VFS 常驻同一 Worker；编译/链接不出 Worker，无中间文件复制 |
| Persistent VFS/Sysroot | clang-fs 解包一次常驻 Worker；PCH 产物 /bits.pch 常驻 VFS |
| WebAssembly.Module 缓存 | program.wasm 主线程只 compile 一次，postMessage 分发给 Exec Worker |
| speculative compile | 编辑器停止输入 1s 后台预编译（编译队列串行、同 key 在途复用） |
| -O0 快速编译默认 | UI 默认「快速编译 (-O0)」；「性能模式 (-O2)」用于估算程序运行性能 |
| preload | 页面加载/语言切换即初始化编译器 Worker 与 Python runtime（HTTP immutable 缓存已由 app.js 提供） |
| profiling | runtime/cache load · clang init · pch gen · preprocess/header parse · compile/codegen · link · wasm compile · instantiate · execution（console.debug 完整对象） |

## 实测数据（-O0，Chromium headless，localhost）

### 5 组 × 10 次对照（每次运行强制真实重编译）

| 测试 | COLD | WARM MEDIAN | PCH 大小 | 说明 |
|---|---|---|---|---|
| A no-include | 9ms | 7ms | — | 基线 |
| B iostream 无 PCH | 365ms | 310ms | — | 头文件解析为主 |
| **C iostream.pch** | 61ms | **57ms** | **5.9MB** | 相对 B -82% |
| **D bits.pch** | 161ms | **145ms** | **10.7MB** | 相对 E -76% |
| E bits 无 PCH | 682ms | 596ms | — | 最重 |

> 注：本表为「PCH 已生成后的冷/暖编译」对照（cold=首次重编、warm median=PCH 复用）。shim 已合并本轮验证通过的聚合头（容器/算法/浮点/流等），排除 Runtime 受限的 `<atomic>/<thread>/<mutex>/<future>/<condition_variable>/<regex>`，故 bits.pch 由旧 11.2→10.7MB、warm 150→145ms（PCH 更小、反序列化更快）。

### 结论

1. **头文件解析占编译 90%+**（-ftime-report：frontend/backend）。
2. **iostream.pch 比 bits.pch 快 2.5 倍**（57 vs 145ms）：bits 打包全部聚合头（10.7MB），反序列化成本更高 → 支撑自动分层设计：`cin/cout` 选手用 iostream.pch 最轻，bits.pch 留给 STL 全家桶。
3. **PCH 目前未完全"常驻"**：每次 compile 仍从 VFS 读 PCH bytes → malloc → copy → Clang 反序列化 AST。未来若让 Clang AST 状态跨编译驻留内存（clangd-style），150ms 有望降到 ~100ms 级——但受 clang -cc1 单命令进程模型限制，需较大工程，列为 P1 研究。
4. 缓存命中（改输入/再跑样例）compileMs=0，仅 execution ~3-6ms。

## 结论

1. **头文件解析占编译耗时 91%**（-ftime-report 实测），证实报告核心假设；-O0/-O1 对编译提速有限。
2. **PCH 是编译热路径最大单项优化**：compile 1412ms → 228ms（**-84%**）；一次性生成 ~1s，常驻 VFS 会话内零成本复用。
3. **常驻编译器 Worker**（Module+VFS 复用）使第二次编译 1412→710ms（省模块再编译与 FS 克隆）。
4. **Execution Time 与 Compile Time 已严格分离**：页面主指标「运行时间：X ms」= 纯 `_start()` 时长；编译耗时仅作次要行展示，不计入。
5. 短程序典型体验：改代码后首次点 Run ≈ 0.25~1.4s（视 PCH 开关），再点/跑样例 ≈ 3~6ms。

## 未实施（P1 研究项，不影响稳定功能）

- Clang Modules（-fmodules）：与 -cc1 wasm 构建兼容性未知，PCH 已覆盖主要收益。
- 预链接 C++ runtime / runtime.wasm + user-module.wasm 拆分：可省链接与部分运行时装配，改动面大。
- IndexedDB 持久化 artifact：HTTP immutable + V8 code cache 已覆盖跨会话资产，内存级 artifact 已满足赛时场景。
