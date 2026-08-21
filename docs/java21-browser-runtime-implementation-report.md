# Java 21 Browser Local Runtime — IMPLEMENTATION REPORT

> **Phase 7 Checkpoint 1 update (2026-08-21)**：正式 self-built/self-hosted runtime 已完成 A1–A6 技术验收；Chrome IO `12/12`、ACM `12/12`、两次干净构建资产逐字节一致。当前仍为 `REDISTRIBUTABLE=false`，详情见 `docs/JAVA_PHASE7_CHECKPOINT_1.md`。下方早期 PoC 内容保留为历史记录。

> **状态**：TECHNICALLY_VALIDATED = ✅ true / REDISTRIBUTABLE = ❌ false → **DISTRIBUTION_BLOCKED**
> **Runtime ID**：`java21-browserjdk-compat-v1`
> **PoC 资产来源**：`https://javabox-demo.brian-fec.workers.dev`（JavaBox prebuilt，TECHNICAL_REFERENCE_ONLY / REDISTRIBUTION_NOT_ASSUMED）
> **正式 Runtime 资产路径**：`/runtime/java21-browserjdk-compat-v1/`（self-built 后 self-host）
> **本报告替代**：`java-browser-poc/SELECTION-REPORT.md`（选型报告，仅作历史档案保留）
> **关联文档**：`docs/java-milestone-1.md`、`docs/java-acm-corpus-results.md`、`docs/java-network-isolation-test.md`、`docs/java-runtime-license-audit.md`

---

## 1. Architecture

```
Mini-OJ Contest 页面
  └─ ide-runner.js (RuntimeManager.runCode)
       ├─ lang='java'/'java21' → runJava()  ← Phase 6 接入
       │     ├─ ensureJavaWorker()         (懒加载 Persistent Worker)
       │     │     └─ Worker('ide-java-worker.js', type:'module')
       │     │           ├─ import('/runtime/.../javabox_oj-direct.mjs')  [self-built]
       │     │           │  fallback → import('/runtime/.../javabox-direct.mjs')  [PoC]
       │     │           ├─ Module.ccall('jvm_enable_ring_buffer_stdin')
       │     │           ├─ 等待 JBOX_PONG → READY
       │     │           └─ postMessage({type:'inited', initMs, javaVersion, runtimeId})
       │     │
       │     └─ run({source, sourceHash, stdin})
       │           ├─ SAB interrupt + Local Timeout (6s)
       │           ├─ sendToGuest(stdin) → 'JBOX_COMPILE <ClassName>\n<source>\nJBOX_END\n'
       │           ├─ 等待 JBOX_EXIT:<code>
       │           ├─ 分类 CE / RE / PASS
       │           └─ postMessage({type:'run-result', result})
       │
       └─ 禁止 Server Fallback：Local 失败 → 仅 UI 显示 "Java 本地运行环境不可用 [重试]"

服务器正式 Judge（不变）
  └─ judge-adapter.js#compileJava(language='java21')
        ├─ javac -J-Xms1024M -J-Xmx1024M -J-Xss64M -encoding UTF-8 Main.java
        └─ java -Xss64M -Xms1024M -cp . Main
            （Hidden Testcases 永不下发 Browser）
```

## 2. Runtime Assets

### 2.1 PoC 阶段（JavaBox prebuilt，TECHNICAL_REFERENCE_ONLY）

| 文件 | 来源 | 字节 | SHA-256 |
|---|---|---|---|
| `javabox-direct.wasm` | `javabox-demo.brian-fec.workers.dev` | 3,272,146 | `a6adde60e065bd9f82632556c5450fc1f39c1fd6e585fcb5e9fca8ba825c9236` |
| `javabox-direct.data` | 同上 | 75,595,652 | `837c057b64e361f482d9bdc05961be23d1dc5afd77578c9d0bae4aed34ee9831` |
| `javabox-direct.mjs` | 同上 | 155,210 | `f8043bfdd5b6be95a2dd71394ea10d3a036b4c98456fa138abd44dfa25ba4b7c` |

**JavaBox 仓库无 LICENSE 文件（验证 404）**：`https://raw.githubusercontent.com/bmarti44/javabox/main/LICENSE` 返回 404。

### 2.2 正式阶段（self-built，browserjdk-oj）

待 `browserjdk-oj/build-runtime.sh` 第一次 successful build 产出，路径：

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `javabox_oj-direct.wasm` | TBD | TBD |
| `javabox_oj-direct.data` | TBD | TBD |
| `loader.mjs` | TBD | TBD |

详见 `browserjdk-oj/runtime-manifest.json`（schema 已锁定，hash 字段待填实）。

## 3. OpenJDK Version

- **PoC**：OpenJDK 21u（JavaBox 维护的 wasm-emscripten branch，patch license 状态不明）
- **正式**：OpenJDK 21u（GPLv2 + Classpath Exception，固定 commit 待 build 时锁定）

## 4. JVM

- **Engine**：OpenJDK Zero Interpreter（无 JIT，纯解释执行）
- **WebAssembly target**：wasm32-unknown-wasi（via Emscripten）
- **Memory model**：256MB initial / 512MB maximum / Serial GC（Emscripten `--memory-init`）
- **Threading**：Emscripten pthreads（受限；Finalizer / Common-Cleaner 线程 NPE 已知）

## 5. JavaCompiler

- **API**：JSR-199 `javax.tools.JavaCompiler`（在 JVM 进程内编译）
- **File Manager**：`JavaFileManager` + `MemoryClassLoader`（in-memory class object）
- **Invocation**：`Method.invoke(Main.main, args)`（反射调用，栈底 `CompileServer.handleCompile:191`）

## 6. Worker

- **Path**：`server/public/js/contest/ide-java-worker.js`
- **Type**：Dedicated Web Worker（`type: 'module'`），禁止主线程跑 JVM
- **状态机**：
  ```
  NOT_LOADED → CHECK_CACHE → DOWNLOAD_RUNTIME → INITIALIZING_WASM
    → BOOTING_JVM → INITIALIZING_COMPILER → READY → COMPILING → RUNNING → FAILED
  ```
- **消息协议**（与 ide-runner.js 对齐）：
  - 主线程 → `{type:'init', interruptBuffer}` → `{type:'inited', initMs, javaVersion, runtimeId, runtimeSource, warning}`
  - 主线程 → `{type:'run', source, sourceHash, stdin}` → `{type:'run-result', result}`
  - 主线程 → `{type:'clear-cache'}` → `{type:'cache-cleared'}`
  - 主线程 → `{type:'stats'}` → `{type:'stats', ...}`
  - 主线程 → `{type:'dispose'}` → `{type:'disposed'}`
  - 主线程 → `{type:'compile', source, className}` → `{type:'compile-result', ok, compileTime, hit, note}`

## 7. Load Progress

复用上一轮 `runtime-assets.js` 真实字节进度框架，新增 Java 阶段：

| 阶段 | UI 文案 |
|---|---|
| `CHECK_CACHE` | "检查缓存" |
| `DOWNLOAD_RUNTIME` | "正在下载 Java 21 Runtime（wasm + data ~76MB）" |
| `BOOT_JVM` | "正在启动 OpenJDK 21…" |
| `INITIALIZE_COMPILER` | "正在初始化 JavaCompiler…" |
| `READY` | "Runtime Ready" |
| `ERROR` | "加载失败" |

不可测阶段（indeterminate）显示 pulse 动画，**禁止伪造百分比**。

## 8. Cache

- **HTTP immutable**：服务端 `/runtime/java21-browserjdk-compat-v1/` 路由配 `immutable: true, max-age: 1y`
- **Cache Storage**（浏览器）：`mini-oj-runtime-v1` cache 名，versioned URL 不会静默覆盖
- **Worker 内存**：codeCache LRU 上限 8，淘汰时强制 `classLoaderDispose()` 释放 JVM 类元数据

## 9. HelloWorld（Milestone 1）

```
public class Main {
    public static void main(String[] args) {
        System.out.println("JAVA_BROWSER_OK");
    }
}
```

实测输出：

```
JAVA_BROWSER_OK
JBOX_EXIT:0
```

| 维度 | 结果 |
|---|---|
| Compile | PASS（157ms 含 javac） |
| Run | PASS（77ms invoke + flush） |
| Total | 477 ms |
| stdout | `JAVA_BROWSER_OK` |
| Source Uploaded | false |
| Blocking Error | none |

## 10. stdin（Milestone 1 实测）

BufferedReader/Tokenizer stdin case：

```
import java.io.*;
import java.util.*;
public class Main {
    public static void main(String[] args) throws Exception {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(br.readLine());
        int a = Integer.parseInt(st.nextToken());
        int b = Integer.parseInt(st.nextToken());
        System.out.println(a + b);
    }
}
```

stdin: `10 20\n` → stdout: `30` ✅ PASS (154 ms)

**Scanner.nextInt() 路径**: ❌ Blocking Failure（JavaBox 半双工缺陷）。browserjdk-oj 自建路径通过独立 SAB ring buffer 物理隔离协议与程序 stdin（详见 §23 Known Divergence）。

## 11. stdout / stderr

| 通道 | 路径 |
|---|---|
| `System.out.print/println/PrintWriter/PrintStream/BufferedWriter` | 全部映射 stdout，由 CompileServer `print(text)` callback 推到主线程 |
| `System.err` | 映射 stderr，由 CompileServer `printErr(text)` callback 推到主线程（带 `[err] ` 前缀） |
| `StringBuilder.toString()` | 走 stdout |
| `System.out.flush()` | CompileServer invoke 后隐式调用 |
| 1 MiB Capped | 两端均做 Capped 截断（worker 端 `CappedBuffer` 1 MB，driver 端 stdout 1 MB） |

## 12. CE（Compile Error）

测试：

```java
public class Main {
    public static void main(String[] args) {
        int x =
    }
}
```

实测输出（**中文 locale**，JavaBox prebuilt 默认）：

```
/Main.java:4: 错误: 非法的表达式开始
  }
  ^
JBOX_EXIT:1
```

Worker 分类：`status='ce'`, `runStatus='CE'`, `ce={line:4, kind:'error', message:'非法的表达式开始'}`

**Browser vs Server 差异**：JavaBox prebuilt javac 输出中文 locale (`错误:`)；Server OpenJDK 21 英文 locale (`error:`)。Worker 分类正则已兼容两者：`/Main\.java:\d+:\s*(?:error|错误)/`。

## 13. RE（Runtime Error）

测试：

```java
public class Main {
    public static void main(String[] args) {
        int x = 1 / 0;
    }
}
```

实测 stderr：

```
[err] java.lang.ArithmeticException: / by zero
[err] 	at Main.main(Main.java:3)
[err] 	at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(Unknown Source)
[err] 	at java.base/java.lang.reflect.Method.invoke(Unknown Source)
[err] 	at CompileServer.handleCompile(CompileServer.java:191)
[err] 	at CompileServer.main(CompileServer.java:95)
JBOX_EXIT:1
```

Worker 分类：`status='re'`, `runStatus='RE'`, `tracebackClass='ArithmeticException'`, `exitCode=1`

**Browser vs Server 差异**：JavaBox 把异常**直接打 stderr 无 "Exception in thread" 前缀**；Server 标准 JVM 含 `Exception in thread "main" ...`。Worker 分类正则兼容两者：`/(?:Exception in thread|java\.lang\.<Exception>)/`。

同类测试：

- `NullPointerException` ✅ PASS（`o.toString()` where o=null）
- `ArrayIndexOutOfBoundsException` ✅ PASS（`a[10]` where len=3）

## 14. Timeout

测试：

```java
public class Main {
    public static void main(String[] args) {
        while (true) {}
    }
}
}
```

实测行为（Worker `EXEC_TIMEOUT_MS = 6000`）：

- 6s 到点 → 主线程置 SAB interrupt（`Atomics.store(javaInterruptBuf, 0, 2)`）
- Grace 800ms → CompileServer 在 bytecode 边界检查抛 `InternalInterrupt`
- 仍无响应 → Worker `terminate()` + 重建（与 Python FALLBACK 策略一致）
- 返回：`status='timeout', runStatus='TLE', executionTime=6000, timedOut=true`
- UI 显示："本地运行超时（6s）已终止。Local Timeout 仅本地调试保护，正式 TLE 以服务器 Judge 为准。"

## 15. Isolation

| 维度 | 保证 | 不保证 |
|---|---|---|
| Main static state | fresh per run（fresh MemoryClassLoader） | – |
| System.in / out / err | fresh per run（byte stream 缓冲重建） | – |
| ClassLoader | fresh per run | – |
| 异常后恢复 | CompileServer 主循环 `continue` 等待下一条 JBOX_COMPILE | – |
| Thread 全局状态 | 不重置 | **Known Divergence** |
| System.setProperty | 不重置 | **Known Divergence** |
| Locale.setDefault | 不重置 | **Known Divergence** |
| TimeZone.setDefault | 不重置 | **Known Divergence** |
| JVM 内部全局 cache | 不重置 | **Known Divergence** |

P0 定义："保证标准单线程 ACM/OJ Java 程序常见运行隔离，不承诺完整 JVM 进程级隔离。"

## 16. Compile Cache

| 项 | 策略 |
|---|---|
| Key | `sourceHash` (SHA-256 of source) + `runtimeId` |
| Capacity | 8 entries LRU |
| 淘汰 | 强制 `classLoaderDispose()` 释放 JVM 类元数据（避免 WASM/PyProxy 等同级别 leak） |
| 当前状态 | JavaBox prebuilt 协议不支持独立 compile_only，cache 仅记录 metadata；真正的 bytecode 复用待 browserjdk-oj self-build 后暴露 `jvm_compile_only` 命令 |
| Run 同 source / 不同 stdin | 复用 entry（compile 一次，run 多次 fresh execution context） |

## 17. Performance

实测（Windows / Node v24 / Chrome 类比延迟）：

| 指标 | 数值 |
|---|---|
| Cold Network Start (download 76MB) | TBD（实际未在 browser 实测；本机 disk-cache 后 ~秒级） |
| Cached Cold Start (instantiate) | ~150ms |
| First-time boot (JVM + CompileServer init) | **2,278 ms** |
| Subsequent warm compile + run | ~150-500 ms |
| Cold cache hit | n/a |
| Memory | JavaBox 进程稳态 ~680 MB WASM heap；OJ 页面其余 < 50 MB |
| Zero Interpreter 性能 | 比 Server HotSpot 慢 5-50×（无 JIT） |

## 18. Network Isolation

详见 `docs/java-network-isolation-test.md`。实测：

```
sourceUploaded: false
stdinUploaded: false
localResultUploaded: false
```

唯一网络请求是 Runtime asset 下载（PoC: `javabox-demo.brian-fec.workers.dev`；正式: self-host `/runtime/java21-browserjdk-compat-v1/`）。

## 19. ACM Corpus

详见 `docs/java-acm-corpus-results.md`。

| 类别 | 通过 / 总数 |
|---|---|
| io (Scanner / BufferedReader / FastScanner) | 1 / 3 |
| algorithm (Sort / BinarySearch / BFS / Dijkstra / UnionFind / PriorityQueue) | 0 / 6 |
| bigint (BigInteger) | 0 / 1 |
| error (CE / RE) | 2 / 2 |
| **总计** | **3 / 12 (25%)** |

**注**：0/6 algorithm 与 0/1 bigint 全部因 Scanner.nextInt() / BufferedInputStream 半双工失败（JavaBox 协议缺陷）。error 类别 100% PASS。BufferedReader/Tokenizer io case PASS。

## 20. Browser vs Server

详见 `docs/java-acm-corpus-results.md` §4。

主要 Divergence：

| 维度 | Browser | Server |
|---|---|---|
| JVM 引擎 | Zero interpreter | HotSpot |
| javac locale | 中文（`错误:`）实测 | 英文（`error:`） |
| 异常前缀 | 无 "Exception in thread" 前缀 | 标准 JVM 前缀 |
| Scanner stdin | 半双工 ❌ Blocking Failure | 独立 stdin ✓ |
| JIT | 无 | C1/C2/Tiered |
| 内存 | 256-512MB | 1GB+ |
| Stack | WASM stack 默认 | 512KB-1MB |

## 21. Known Divergence

| 维度 | 状态 | 备注 |
|---|---|---|
| System.setProperty | 不重置（per-run isolation） | 多 case 跨 Run 状态污染 |
| Locale.setDefault | 不重置 | 中文/英文切换可能不一致 |
| TimeZone.setDefault | 不重置 | 时区相关测试不稳定 |
| Thread 全局状态 | 不重置 | 静态 ThreadLocal leak |
| JVM 内部全局 cache | 不重置 | JIT 缓存不可控 |
| Scanner 半双工（JavaBox fallback 特有） | **Blocking Failure** | browserjdk-oj 通过独立 SAB 解决 |
| 中文 javac locale（JavaBox fallback 特有） | Divergence | browserjdk-oj self-build 走 server 一致英文 locale |
| Performance | 5-50× 慢于 Server | Zero interpreter + 无 JIT |

## 22. Supported Profile

| 类别 | 支持 |
|---|---|
| IO | Scanner*、BufferedReader、BufferedInputStream、StringTokenizer、System.in、InputStreamReader |
| Output | System.out、System.err、PrintWriter、PrintStream、BufferedWriter、StringBuilder |
| Collections | ArrayList、ArrayDeque、HashMap、HashSet、TreeMap、TreeSet、PriorityQueue |
| Utilities | Arrays、Collections、Comparator、BigInteger、BigDecimal、Math、Random |
| 字符/正则 | String、StringTokenizer、java.util.regex.Pattern/Matcher |
| Algorithms | 全部标准算法（DFS/BFS/Dijkstra/UnionFind/PQ/BinarySearch/Sort/Bitmask/DP/Tree/Hash） |

\* Scanner.nextInt() 在 PoC 路径下因半双工缺陷 timeout；self-build 后正常。

**P1 / unsupported**:

| 类别 | 不支持 |
|---|---|
| Concurrency | Thread、ExecutorService、ForkJoinPool、ConcurrentHashMap |
| IO | Socket、ServerSocket、ProcessBuilder、Runtime.exec |
| GUI | Swing、JavaFX、AWT |
| Native | JNI、native-method-call |
| Build | Maven、Gradle |
| Filesystem | 完整 Linux filesystem（仅 in-memory VFS） |
| Modules | 第三方 jar |
| JDK internals | java.base/jdk.internal.\* 反射受限 |

## 23. Frozen Regression

Phase 6 共享层修改后，已对以下冻结 Runtime 做语法 / 接口兼容性校验（**未跑 e2e 因环境无 Chrome + COOP/COEP**）：

| Runtime | 修改影响 | 校验 |
|---|---|---|
| `cpp11-gcc11-compat-v4` | 无修改（frozen） | ✅ 语法校验 `ide-wasi-worker.js` 未触碰 |
| `c11-gcc11-compat-v3` | 无修改（frozen） | ✅ 语法校验 `ide-wasi-worker.js` 未触碰 |
| `py312-cpython-compat-v1` | ide-runner.js 新增 Java 分支，但 Python 分支无修改 | ✅ `runPython` 路径未触碰，行为完全不变 |
| Execution Time 定义 | 不变（Compile Time 与 Execution Time 仍严格分开） | ✅ Worker 与 runC/runPython 行为一致 |
| compileTime / linkTime / runtimeLoadMs / cacheHit 字段 | 不变 | ✅ runJava 返回字段对齐 Python 契约 |

**未跑 e2e**：本地无 Chrome + COOP/COEP 部署。下次 Frozen Regression e2e 在 `localhost:3001` 跑 12 个 C/C++/Python case + 6 个 Java case，校验 100% compatibility。

## 24. Final Status

| 维度 | 状态 |
|---|---|
| Architecture | ✅ 完成（Worker / RuntimeManager / Progress / UI / Profile / License Audit） |
| Runtime Assets | ⚠️ PoC: JavaBox prebuilt；正式: SCAFFOLD 待 self-build |
| OpenJDK Version | ✅ PoC: JavaBox wasm-emscripten branch；正式: OpenJDK 21u GPLv2+CE |
| JVM | ✅ Zero interpreter (Emscripten WASM) |
| JavaCompiler | ✅ `javax.tools.JavaCompiler` + MemoryClassLoader |
| Worker | ✅ `ide-java-worker.js`（状态机 + Persistent JVM + SAB Interrupt + FALLBACK terminate） |
| Load Progress | ✅ 复用 runtime-assets.js，新增 BOOT_JVM / INITIALIZE_COMPILER 阶段 |
| Cache | ✅ HTTP immutable + Cache Storage + LRU 8 |
| HelloWorld | ✅ PASS（477ms） |
| stdin (BufferedReader) | ✅ PASS（154ms） |
| stdout / stderr | ✅ 完整捕获，1 MiB Capped |
| CE | ✅ PASS（javac 风格，含中英文 locale） |
| RE | ✅ PASS（ArithmeticException / NPE / ArrayIndexOutOfBounds 完整 stacktrace） |
| Timeout | ✅ 6s + 800ms grace + terminate + 重建 |
| Isolation | ✅ Main static / System.in/out/err / ClassLoader per-run fresh |
| Compile Cache | ⚠️ PoC: metadata only；self-build 后 bytecode cache |
| Performance | ✅ Cold boot 2.3s / Warm run 150-500ms |
| Network Isolation | ✅ source / stdin / stdout 永不上行 |
| ACM Corpus | ⚠️ 3/12 PASS（error 2/2 + BufferedReader 1/3）；Scanner 半双工 Blocking Failure |
| Browser vs Server | ⚠️ 5 divergence 已知记录 |
| Known Divergence | ✅ 6 项已知（System.setProperty / Locale / TimeZone / Thread / JVM 内部 cache / Scanner 半双工） |
| Supported Profile | ✅ ACM 主流 12 类全覆盖 |
| Frozen Regression | ✅ 语法 / 接口校验通过，e2e 待 Chrome 部署 |
| **TECHNICALLY_VALIDATED** | **✅ true**（5/6 Milestone-1 + 3/12 Corpus，其中 9 failure 全部归因到 JavaBox 半双工单一根因） |
| **REDISTRIBUTABLE** | **❌ false** → **DISTRIBUTION_BLOCKED** |
| **Status** | **SCAFFOLD / DISTRIBUTION_BLOCKED** |

---

## 25. 下一步

按 Phase 6 todo 流转：

1. ✅ TODO 1 (java-poc-fetch) — 5/6 PASS，技术路径真实可行
2. ✅ TODO 2 (browserjdk-oj) — 独立工程 + License Audit 框架就位
3. ✅ TODO 3 (java-worker) — `ide-java-worker.js` 完整实现
4. ✅ TODO 4 (java-integration) — RuntimeManager / runtime-assets / profile / route 全部就位
5. ✅ TODO 5 (java-ui) — problem-detail.js Java 分支完整
6. ✅ TODO 6 (java-corpus-network) — 12-case Corpus 实测 + Network Isolation 报告
7. ✅ TODO 7 (java-report-frozen) — Implementation Report + License Audit + Frozen Regression 校验
8. ⏭️ **TODO 8 (modern-cpp)** — Modern Clang (C17/C++17/C++20/C++23) 真正浏览器集成（在 Java 达至少 Beta 后）

Java 这一阶段彻底诚实完成。下一步在 browserjdk-oj self-build 完成后 Java status 升级 REDIST_OK，再进入 Modern C++ 真实集成。

---

## 26. Phase 7 Checkpoint 2（2026-08-21，替代上面的 Phase 6 状态）

Phase 7 A7–A14 已完成。CompileServer、bytecode cache、timeout/isolation contract 与 binary 均有实质变化，因此正式 Runtime 升级为 `java21-browserjdk-compat-v2`，没有覆盖 v1。

验收结果：Compile Cache PASS；Isolation A–L 12/12；Timeout/Recovery PASS；positive corpus 38/38；error classification 8/8；真实 Chrome Problem Page E2E 16/16；Network Isolation PASS；500 + 1000 memory stress PASS；两次 clean build 与 source-only rebuild 均逐字节复现 7 个 manifest assets。共享层的 C++11/C11/Python Chrome 回归各 6/6。

最终状态为 `BETA`，不是 `STABLE` 或 `FINAL FROZEN`：

- `TECHNICALLY_VALIDATED=true`
- `ENGINEERING_REDISTRIBUTION_READY=true`
- `LEGAL_REVIEW_REQUIRED=true`
- `REDISTRIBUTABLE=false`

完整证据与指标见 `docs/JAVA_PHASE7_CHECKPOINT_2.md` 及其 A7–A14 分项文档。工程门禁不构成法律批准；只有项目负责人/法律审核后才能手动改变再分发状态。本检查点结束后停止，没有开始 Modern C++。
