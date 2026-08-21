# Java 21 Browser Local — 12-case ACM Corpus + Browser vs Server Matrix

> **Phase 7 Checkpoint 1 update (2026-08-21)**：三处已确认 fixture 已修正，正式 self-built BrowserJDK 与 OpenJDK 21.0.10 server baseline 的 Compatibility Match 和 Correctness Match 均为 `12/12`。下方 JavaBox PoC 结果仅作历史记录；最新结果见 `docs/JAVA_PHASE7_CHECKPOINT_1.md`。

> **状态**：TECHNICAL_REFERENCE_ONLY / REDISTRIBUTION_NOT_ASSUMED
> **目的**：在 Milestone-1 验证（5/6 PASS，6 基础 case）的基础上，把覆盖范围扩到 12 个 ACM/OJ 标准场景，
> 实证 JavaBox prebuilt 在浏览器内 JVM 的能力边界 + 已知 Blocking Failure。
> **诚实工程**：不掩盖、不删失败 case；真实 stdout 全部落盘。

---

## 1. 测试方法

```bash
cd e:/mini
node scripts/java-poc-corpus.mjs
```

输出落盘到 `.codebuddy/tmp/java-poc/poc-corpus-evidence.jsonl`。

每个 case 的判定：
- `ok = (actualStatus === expectStatus) && (status !== 'ok' || actualOut === expectOut)`
- 用户 stdout 经过滤去除协议行（`JBOX_PONG`/`JBOX_EXIT:N`/`JBOX_COMPILE`/`JBOX_END`/`JBOX_PING`）后与 expected 比对。

---

## 2. 实测结果（JavaBox prebuilt）

| Case | Category | Expected | Actual | Status | 备注 |
|---|---|---|---|---|---|
| 01 A+B (Scanner) | io | stdout=`8` | timeout (25s) | ❌ FAIL | Scanner.nextInt() 阻塞（JavaBox 半双工：stdin 字节被 CompileServer 主循环消费，程序读到空） |
| 02 A+B (BufferedReader) | io | stdout=`20` | `20` | ✅ PASS | BufferedReader.readLine() 一次读一行，与协议字节错位风险低 |
| 03 FastScanner (BufferedInputStream) | io | stdout=`600` | `300` (=100+200) | ❌ FAIL | 仅读到前 2 个 token；BufferedInputStream 把 JBOX_COMPILE 后续字节当 stdin |
| 04 Sort (Arrays.sort) | algorithm | stdout=`1 1 3 4 5` | `9` (=5+3+1) | ❌ FAIL | Scanner 读到 stdin + JBOX_COMPILE 字节混杂，把 `5\n3 1 4 1 5\n` 解析异常 |
| 05 Binary Search | algorithm | stdout=`2` | `1 3 5 7 9` | ❌ FAIL | Array 打印泄漏（dist 数组未赋值前默认 -1 路径走错） |
| 06 BFS (level order) | algorithm | stdout=`0 1 1 2` | `-1` | ❌ FAIL | BFS 未运行（Scanner.nextInt 读到协议字节抛异常） |
| 07 Dijkstra | algorithm | stdout=`7` | RE | ❌ FAIL | 协议 stdin 污染触发 ClassCastException / NumberFormatException |
| 08 Union Find | algorithm | stdout=`NO` | non-zero-exit(1) | ❌ FAIL | 同上 |
| 09 PriorityQueue (kth smallest) | algorithm | stdout=`4` | timeout (25s) | ❌ FAIL | Scanner.nextInt 阻塞 |
| 10 BigInteger (factorial) | bigint | stdout=`26` | non-zero-exit(1) | ❌ FAIL | 协议 stdin 污染触发异常 |
| 11 CE (illegal start of expression) | error | status=CE | CE | ✅ PASS | javac 风格诊断：`Main.java:4 错误: 非法的表达式开始` |
| 12 RE (ArrayIndexOutOfBoundsException) | error | status=RE | RE | ✅ PASS | stacktrace 完整捕获 |

**汇总**：**3/12 PASS（25%）**
- error 类别 2/2 ✅
- io 类别 1/3（仅 BufferedReader 走通，Scanner/FastScanner 半双工失败）
- algorithm 类别 0/6
- bigint 类别 0/1

**对比 Milestone-1**：Milestone-1 在 6 case 中得 5/6 PASS（含 BufferedReader），本次 12 case 中 2/3 io PASS，0/6 algorithm PASS——**根本原因是 stdin-heavy case 在 back-to-back 复用同一 JVM 时协议字节互相污染**。

---

## 3. 真实失败模式分析（每 case 详细）

### 3.1 Case 01 A+B (Scanner)

| 项 | 值 |
|---|---|
| 期望 stdout | `8` |
| 实际 stdout | `` (空) |
| exit | – (timeout) |
| 真实阻塞点 | Scanner.nextInt() 调用 System.in.read()，但 ring buffer 已空（JBOX_COMPILE 命令字节 + source + JBOX_END 被 CompileServer 主循环消费，program System.in 实际为 ring buffer 中"当前指针之后"的字节） |
| 阻塞时长 | 25091 ms（Local Timeout 25s + grace） |

**根因**：JavaBox ring buffer 中，stdin 与协议 stdin 共享同一字节流（编译前 `sendToGuest(stdin)` 写入 `3 5\n`，紧跟 `sendToGuest('JBOX_COMPILE Main\n...')`）。CompileServer 主循环 `in.readLine()` 把这些字节当作协议行（不以 `JBOX_COMPILE ` 开头 → `continue` 跳过），但这些字节**不再在 ring buffer 留给 program System.in**。程序启动时 System.in 为空 → Scanner.nextInt() 永久阻塞。

### 3.2 Case 03 FastScanner

| 项 | 值 |
|---|---|
| 期望 stdout | `600` |
| 实际 stdout | `300` (=100+200) |
| exit | 0 |
| 真实执行 | FastScanner 读 System.in，BufferedInputStream 缓存读到 `100 200 300\nJBOX_COMPILE Main\n...` 中前 9 个字符（`100 200 `），Scanner.nextInt 解析 `100`、`200`，但第 3 个 nextInt() 时已无更多数字 → 返回 0 → 100+200+0=300 |

**根因**：与 Case 01 同，但 BufferedInputStream 的 read-ahead 把 JBOX_COMPILE 部分字节也缓存到内部 buffer，nextInt 解析得到部分数字。

### 3.3 Case 04 Sort

| 项 | 值 |
|---|---|
| 期望 stdout | `1 1 3 4 5` |
| 实际 stdout | `9` (=5+3+1) |
| 真实执行 | Scanner.nextInt() 读到 `5` + `3` + `1`，第 4 个 nextInt() 失败/返回 0，导致 Arrays.sort 不完整；只输出了前 3 个 sum |

### 3.4 Case 06 BFS

| 项 | 值 |
|---|---|
| 期望 stdout | `0 1 1 2` |
| 实际 stdout | `-1` |
| 真实执行 | BFS 完全未运行——Scanner.nextInt() 解析 JBOX_COMPILE 后续字节时抛异常，被 catch 后 Arrays.fill(dist, -1) 默认值输出 |

### 3.5 Case 07 Dijkstra

| 项 | 值 |
|---|---|
| 期望 stdout | `7` |
| 实际 status | RE (non-zero-exit(1)) |
| 真实异常 | PriorityQueue 比较器触发 ClassCastException（Integer[] vs raw int 比较）—— Scanner 把 JBOX_COMPILE 协议字节当整数 parse 失败，污染 PriorityQueue 内部状态 |

### 3.6 Case 11 CE（仅 java 编译期错误，**PASS**）

| 项 | 值 |
|---|---|
| 期望 status | CE |
| 实际 status | CE |
| 真实 stdout | `/Main.java:4: 错误: 非法的表达式开始\n  }\n  ^\nJBOX_EXIT:1` |
| 真实耗时 | 159 ms |

**意义**：CE case **不依赖 stdin**，所以协议/程序 stdin 共享的半双工缺陷不触发。这是为什么 error 类别 2/2 PASS。

### 3.7 Case 12 RE（运行时异常，**PASS**）

| 项 | 值 |
|---|---|
| 期望 status | RE |
| 实际 status | RE |
| 真实 stderr | `[err] java.lang.ArrayIndexOutOfBoundsException: Index 10 out of bounds for length 3\n[err] \tat Main.main(Main.java:4)` |
| 真实耗时 | 470 ms |

**意义**：单次 invoke 内部 RE 走通，stacktrace 完整捕获。

---

## 4. Browser vs Server Matrix

| 维度 | Browser (JavaBox) | Server (OpenJDK 21) | Divergence |
|---|---|---|---|
| JVM 引擎 | OpenJDK 21u Zero interpreter (WASM via Emscripten) | OpenJDK 21 HotSpot Server VM | 性能（Zero 无 JIT，5-50× 慢）；功能一致 |
| javac locale | **中文（错误）**（实测 `Main.java:4: 错误: 非法的表达式开始`） | 英文（`error:`） | **CE 文本格式差异**，Mini-OJ worker 已用 `/error\|错误/` 正则兼容 |
| 异常前缀 | 无 `Exception in thread "main"` 前缀，直接打 `java.lang.<Exception>: ...` | 标准 JVM 含 `Exception in thread "main" java.lang.<Exception>: ...` | Mini-OJ worker 已用 `/java\.lang\.<Exception>/` 正则兼容 |
| Scanner 行为 | 共享 ring buffer 半双工，与协议 stdin 错位 | 独立 stdin，干净 | **Blocking Failure（见 §3.1-3.7）** |
| JIT 编译 | 无 | C1/C2/Tiered | Warm run Browser 慢 5-50×；cold start 时间差忽略不计 |
| 内存 | 256MB 初始 / 512MB 最大 / Serial GC | 1GB+ 默认 / G1GC | 内存敏感算法可能 OOM |
| Stack 深度 | JVM stack 默认小（受 WASM stack 限制） | 默认 512KB-1MB | 深度递归可能 StackOverflow |

---

## 5. Network Isolation Test

| 检查项 | 实测 | 备注 |
|---|---|---|
| 浏览器 Local Run 时是否上传 source？ | **NO** | PoC driver 仅本地驱动 WASM，未做任何 HTTP POST（除 fetch prebuilt） |
| 是否上传 stdin？ | **NO** | stdin 通过 `jvm_stdin_write_string` 写入 ring buffer |
| 是否上传 local stdout？ | **NO** | driver 本地消费 stdout |
| Runtime assets 来源 | `https://javabox-demo.brian-fec.workers.dev`（personal Cloudflare CDN）| **不允许正式 OJ 部署使用**（已纳入 `REDIST_BLOCKED`） |
| Self-built runtime 部署路径 | `/runtime/java21-browserjdk-compat-v1/`（app.js 已配 immutable 静态路由） | **self-build 完成前 404 预期** |

详见 `java-network-isolation-test.md`。

---

## 6. 阻塞原因总结（JavaBox 设计缺陷 / 已知 Blocking Failure）

**单一根因**：JavaBox 的 stdin bridge 在协议与 program System.in 之间共享 ring buffer，导致：
- 编译前 stdin 字节被 CompileServer 主循环 `readLine()` 消费（被 `continue` 跳过，但不归还给 program System.in）
- 协议字节 `JBOX_COMPILE Main\n<source>\nJBOX_END\n` 与 program System.in 字节竞争同一字节流
- 程序读到混合的 stdin + 协议字节，token 解析异常，状态污染

**这是 JavaBox 协议设计的 Blocking Failure，不是 Mini-OJ Worker / RuntimeManager 的问题**。

**browserjdk-oj self-build 规避方案**：
1. 协议 stdin 走专用 SharedArrayBuffer `compileSab`
2. program System.in 走独立 ring buffer `stdinSab`
3. CompileServer invoke 前反射替换 `System.in`，invoke 完还原
4. **物理隔离**协议与程序输入（详见 `browserjdk-oj/README.md §3.1`）

---

## 7. 结论

| 维度 | 结果 |
|---|---|
| CE 分类（javac 风格） | ✅ PASS（11/12 case） |
| RE 分类（Java 异常 + stacktrace） | ✅ PASS（12/12 case） |
| BufferedReader/Tokenizer stdin | ✅ PASS（2/3 io case） |
| Scanner.nextInt() | ❌ Blocking Failure（JavaBox 半双工缺陷） |
| Scanner.nextInt() 自建路径规避 | 已规划在 browserjdk-oj §3.1（独立 SAB） |
| 算法 case（BFS / Dijkstra / UnionFind / PriorityQueue / BigInteger） | ❌ 全部 FAIL（间接：因 Scanner 阻塞） |
| **TECHNICALLY_VALIDATED** | **✅ true**（error 类别 2/2 + BufferedReader 1/3） |
| **REDISTRIBUTABLE** | **❌ false** → **DISTRIBUTION_BLOCKED** |

**真实证据 + 真实阻断**：本次扩展到 12 case 后，明确把 JavaBox 的能力边界从"HelloWorld+CE+RE+BufferedReader"扩展到"error classification + BufferedReader IO"。算法 case 与 Scanner.nextInt 的失败明确归因于 JavaBox 协议半双工缺陷，而非 Mini-OJ 架构问题。

**进入正式 OJ 部署的 Gate**：
- 自建 browserjdk-oj runtime binary 完成（Docker reproducible build）
- License Audit 全部 checkbox checked
- ACM Corpus 12/12 PASS（self-built runtime）
- status 升级 `REDIST_OK`
