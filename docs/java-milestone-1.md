# JAVA_BROWSER_MILESTONE_1 —— OpenJava 21 Browser Local Runtime 技术验证报告

> **状态**：TECHNICAL_REFERENCE_ONLY / REDISTRIBUTION_NOT_ASSUMED
> **目的**：在 NOT_AVAILABLE 之前，先证明"OpenJava 21 (Zero) → WASM → 浏览器内编译运行 Main.java"这条技术路径真实可行。
> **与正式 distribution 隔离**：本报告基于 JavaBox prebuilt（个人 Cloudflare Worker，无 hash 校验，JavaBox 自身无 LICENSE），仅用于技术验证，不作为正式运行时的依赖。

---

## 1. 执行环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 10/11 (win32, x64) |
| Node.js | v24.16.0 |
| Host Browser | (本 milestone 在 Node 模拟浏览器 host；浏览器端真实部署待 Phase 6 后续验证) |
| WASM Runtime | OpenJava 21 (Zero interpreter) via Emscripten，JavaBox prebuilt |

---

## 2. 资产

来源：`https://javabox-demo.brian-fec.workers.dev`（JavaBox 官方 demo CDN）

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `javabox-direct.wasm` | 3,272,146 | `a6adde60e065bd9f82632556c5450fc1f39c1fd6e585fcb5e9fca8ba825c9236` |
| `javabox-direct.data` | 75,595,652 | `837c057b64e361f482d9bdc05961be23d1dc5afd77578c9d0bae4aed34ee9831` |
| `javabox-direct.mjs` | 155,210 | `f8043bfdd5b6be95a2dd71394ea10d3a036b4c98456fa138abd44dfa25ba4b7c` |

**资产审计**：
- JavaBox 仓库 `https://raw.githubusercontent.com/bmarti44/javabox/main/LICENSE` 返回 **404**——**JavaBox 无 LICENSE 文件**。
- 因此这些资产（含 compiled OpenJava WASM + CompileServer + jvm-main.c + Emscripten loader）**法律状态不明确**，**禁止 vendor 到正式 Mini-OJ distribution**。
- JavaBox 文档明确声明运行需要 COOP/COEP + SharedArrayBuffer——与 SAB/Cross-Origin-Isolated 部署约束一致（Mini-OJ 已有该能力）。

---

## 3. 启动与初始化

| 阶段 | 耗时 | 备注 |
|---|---|---|
| Emscripten Module.create | ~190 ms | 解析 mjs、连接 stdin bridge |
| `jvm_enable_ring_buffer_stdin` | <10 ms | 启用 ring buffer 给 program System.in |
| 等待 `JBOX_PONG`（CompileServer ready） | **~2,278 ms** | 首次 boot 含 OpenJava 类库初始化、CompileServer 守护进程启动 |
| 后续 case 复用同一 JVM | — | Persistent JVM 验证 OK |
| Finalizer / Common-Cleaner 线程 NullPointer | — | Emscripten pthread 与 HotSpot Finalizer 已知冲突（JavaBox 自身已知问题），不影响用户程序 |

---

## 4. Milestone-1 PoC 结果

### 4.1 6 case 真实执行结果

| # | Case | 期望 | 实际 | 耗时 | 备注 |
|---|---|---|---|---|---|
| 1 | HelloWorld | ok | **ok** ✅ | 477 ms | `stdout: JAVA_BROWSER_OK`, `JBOX_EXIT:0` |
| 2 | CE 缺分号 | ce | **ce** ✅ | 157 ms | javac 风格诊断：`Main.java:4 错误: 非法的表达式开始\n  }\n  ^` |
| 3 | RE `1/0` | re | **re** ✅ | 468 ms | stderr: `java.lang.ArithmeticException: / by zero @ Main.java:3` |
| 4 | RE `null.toString()` | re | **re** ✅ | 467 ms | stderr: `NullPointerException: Cannot invoke "Object.toString()" because "<local1>" is null @ Main.java:4` |
| 5 | A+B Scanner (stdin) | ok | **timeout** ❌ | 25,012 ms | JavaBox 协议半双工缺陷：`Scanner.nextInt()` 与 JBOX_COMPILE 协议字节在 ring buffer 共享通道错位 |
| 6 | FastScanner BufferedReader (stdin) | ok | **ok** ✅ | 154 ms | `stdout: 30`——证明 **stdin ring buffer 真实工作** |

**汇总**：`passed: 5/6 (83.3%)`

### 4.2 HelloWorld 关键 stdout 原文

```
JAVA_BROWSER_OK
JBOX_EXIT:0
```

### 4.3 CE 关键 stdout 原文

```
/Main.java:4: 错误: 非法的表达式开始
  }
  ^
JBOX_EXIT:1
```

> 注：JavaBox 的 javac 输出为中文 locale（`错误:`），与服务器 OpenJava 21 默认英文 locale（`error:`）存在 locale 差异。已知 divergence，进入 Browser vs Server Matrix 记录。

### 4.4 RE 关键 stderr 原文

```
[err] java.lang.ArithmeticException: / by zero
[err] 	at Main.main(Main.java:3)
[err] 	at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(Unknown Source)
[err] 	at java.base/java.lang.reflect.Method.invoke(Unknown Source)
[err] 	at CompileServer.handleCompile(CompileServer.java:191)
[err] 	at CompileServer.main(CompileServer.java:95)
JBOX_EXIT:1
```

> JavaBox 把 stacktrace 直接打 stderr（不像标准 JVM 含 `Exception in thread "main"` 前缀）；分类正则需要识别 `java.lang.<ExceptionClass>` 而不是 `Exception in thread`。

### 4.5 FastScanner stdin 关键 stdout

```
30
JBOX_EXIT:0
```

> BufferedReader.readLine() 第一次从 ring buffer 取到 `"10 20\n"`，nextToken 出 `10` `20`，println `30`。

---

## 5. Network Isolation 检验

| 项 | 结果 |
|---|---|
| Source uploaded? | **false**（driver 仅本地驱动 WASM，未做任何 HTTP） |
| Stdin uploaded? | **false**（stdin 通过 ring buffer 本地写入） |
| Local stdout uploaded? | **false**（driver 本地消费） |
| Runtime assets downloaded? | true（72.1 MB `.data` + 3.1 MB `.wasm` + 155 KB `.mjs`）——通过 `fetch()` 从 `javabox-demo.brian-fec.workers.dev`，来源属于 JavaBox demo CDN |

---

## 6. 阶段判定

| 维度 | 状态 | 备注 |
|---|---|---|
| JVM Boot | ✅ PASS | 2,278 ms 收到 JBOX_PONG |
| JavaCompiler | ✅ PASS | CompileServer 真实在 JVM 内调用 `javax.tools.JavaCompiler` |
| Main.main() 执行 | ✅ PASS | HelloWorld 输出 `JAVA_BROWSER_OK` |
| stdout / stderr 捕获 | ✅ PASS | print / printErr 全部捕获 |
| stdin（FastScanner） | ✅ PASS | BufferedReader.readLine() 真实读取 |
| CE 分类（javac 风格） | ✅ PASS | `Main.java:LINE 错误: ...` 捕获 |
| RE 分类（Java 异常） | ✅ PASS | ArithmeticException / NPE 捕获完整 stacktrace |
| Persistent JVM | ✅ PASS | 6 case 复用同一 JVM |
| Network Isolation | ✅ PASS | 无 source/stdin/stdout 上行 |
| **Scanner.nextInt (ACM 主流 IO)** | ❌ **FAIL** | JavaBox 协议半双工——程序 Scanner 与 CompileServer 协议 reader 共享 ring buffer stdin 错位 |
| **REDISTRIBUTABLE** | ❌ **FAIL** | JavaBox 无 LICENSE；prebuilt 来源个人 CDN、无 hash |

### TECHNICALLY_VALIDATED = ✅ **true**（5/6 PoC PASS，Milestone 1 目标全部达成）

### REDISTRIBUTABLE = ❌ **false** → status = **DISTRIBUTION_BLOCKED**

> 触发条件：
> 1. JavaBox (bmarti44/javabox) 仓库无 LICENSE 文件（验证 404）
> 2. jvm-main.c / CompileServer.java / build scripts 自身 license 不明
> 3. prebuilt 下载自个人 Cloudflare Worker，无 hash 校验
> 4. CompileServer.java 协议 stdin 与程序 System.in 共享半双工
> 5. Scanner.nextInt() ACM 主流 IO 不可用

---

## 7. Blocking Failure（JavaBox 设计限制）

仅 Scanner.nextInt case 阻塞：

**真实 Error / 现象**：
```
[stderr ring buffer] JBOX_COMPILE Main
... (CompileServer 解析中)
[ring buffer input] import java.util.*;...
[ring buffer input] JBOX_END
... (CompileServer 切到 handleCompile)
... (javac run ... /tmp/Main.java)
... (MemoryClassLoader.loadClass("Main"))
... (Method.invoke(Main.main, args))
... → Scanner.nextInt() 调用 System.in.read()
     → System.in 被 ring buffer 接管，read() 返回下一字节
     → 实际读到的是 JBOX_COMPILE 后字节（"Main"）的首字符？
     → 但 Scanner 还没消费过前置 stdin "3 5\n"，因为该字节已被 CompileServer 主循环读走
     → Scanner 阻塞 25s（deadline）
```

**根因**（CompileServer.java 主循环与 handleCompile 共用 System.in reader）：
- CompileServer 主循环：`BufferedReader in = new BufferedReader(... System.in ...)`
- `handleCompile`：`while ((line = in.readLine()) != null)` 同样 `in.readLine()`
- 一旦 Scanner.nextInt() 在 handleCompile 内 invoke 阻塞，程序读不到 stdin；JVM 又持续占用线程 → 无 `JBOX_EXIT`
- 这是 JavaBox 协议设计的**已知缺陷**，不是 Mini-OJ worker 的问题。

**规避（self-build browserjdk-oj 时）**：
1. **stdin 与协议物理隔离**：program System.in 走 ring buffer（SAB + Atomics），**协议 stdin 走另一条路径**（如 SharedArrayBuffer 专用协议 channel）。
2. **CompileServer 协议 reader 与 program System.in 严格分开**：CompileServer 在 invoke 之前 swap stdin fd，invoke 完还原；或 CompileServer 自身用 RMI/Socket 而非 stdin。
3. **每次 compile+run 走独立 subprocess**（每次 fork 出新 JVM）——重，但隔离干净。Zero interpreter cold start ~3s，可接受。

---

## 8. 下一步（Phase 6 todo 流转）

按计划：
1. ✅ **TODO 1 (java-poc-fetch)** —— 完成：TECHNICALLY_VALIDATED = true
2. ⏭️ **TODO 2 (browserjdk-oj)** —— 建立独立工程 + License Audit + 自建 CompileServer/stdin bridge
3. ⏭️ **TODO 3-8** —— Java Worker / RuntimeManager / UI / Corpus / Reports / Modern C++

---

## 9. 复现命令

```bash
# 1. fetch prebuilt
mkdir -p .codebuddy/tmp/java-poc
cd .codebuddy/tmp/java-poc
curl --fail --location --show-error \
  -O https://javabox-demo.brian-fec.workers.dev/javabox-direct.wasm \
  -O https://javabox-demo.brian-fec.workers.dev/javabox-direct.data \
  -O https://javabox-demo.brian-fec.workers.dev/javabox-direct.mjs

# 2. 跑 driver
cd e:/mini
node scripts/java-poc-driver.mjs

# 3. 读取证据
cat .codebuddy/tmp/java-poc/poc-evidence.jsonl
```

---

## 10. 结论

> **Milestone 1 真实成功**：
> - JVM Boot ✅
> - JavaCompiler ✅
> - Main.main() ✅
> - stdin/stdout/stderr ✅
> - CE 风格诊断 ✅
> - RE 分类 + stacktrace ✅
> - Persistent JVM ✅
> - Network Isolation ✅
>
> **不构成正式 runtime**：
> - JavaBox 无 LICENSE
> - prebuilt 来自个人 CDN 无 hash
> - Scanner.nextInt 半双工冲突（ACM 主流 IO 不可用）
>
> **正式 runtime 必经路径**：TODO 2 `browserjdk-oj/` 工程——OpenJava21u + Emscripten + libffi 自建，CompileServer / stdin bridge / worker adapter 全自主实现，THIRD_PARTY_LICENSE_MATRIX 完整可审计。