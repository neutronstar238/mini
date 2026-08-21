# Java Browser Local — Network Isolation Test

> **状态**：TECHNICAL_REFERENCE_ONLY（基于 JavaBox prebuilt PoC）
> **目的**：明确本地 Java 运行时的网络边界，保证 OJ 比赛 page 不会因本地 Java 运行而泄露 source/stdin/stdout。

---

## 1. 测试方法

PoC 驱动 `scripts/java-poc-driver.mjs` 与 `scripts/java-poc-corpus.mjs` 均在 Node 环境中执行。所有"浏览器网络"行为在 Node 中通过 `fetch` 与 `import()` 模拟；所有"浏览器本地运行时"行为通过 JavaBox prebuilt WASM 完成。

测试矩阵覆盖：

| 类别 | 资源 | 是否上行？ | 证据 |
|---|---|---|---|
| 运行时资产（wasm/data） | `/runtime/java21-browserjdk-compat-v1/javabox_oj-direct.{wasm,data,mjs}` | **NO**（self-built 应 host 到此路径；当前 SCAFFOLD 状态无文件） | app.js 已配 immutable 静态路由 |
| 运行时资产（fallback） | `https://javabox-demo.brian-fec.workers.dev/javabox-direct.{wasm,data,mjs}` | **YES**（fetch，PoC 必需，正式 OJ 部署 **禁止**） | 见 §3 |
| 提交 / Compile Server (`/api/compile`) | server 端 | **NO** | ide-runner.js Java 分发**不**调用 `fetch('/compile')` |
| 提交 / javac | server 端 | **NO** | compile path 完全在 browser wasm 内 `javax.tools.JavaCompiler` |
| 提交 / 浏览器 → Server javac fallback | – | **NO** | runJava 失败 → 仅 UI 显示 "Java 本地运行环境不可用 [重试]"，**绝不**自动 POST source |
| 用户 Java source（Main.java） | – | **NO** | driver 仅本地通过 `jvm_stdin_write_string` 传入 |
| 用户 stdin（"3 5\n"） | – | **NO** | driver 本地通过 ring buffer 写入 |
| 程序 stdout ("JAVA_BROWSER_OK") | – | **NO** | driver 本地消费，落盘到 evidence 文件 |
| 程序 stderr (Java 异常 stacktrace) | – | **NO** | driver 本地消费 |
| Local execution timing / 编译 timing | – | **NO** | timing 仅本地 console.debug，无网络上报 |
| 评测 Hidden Testcases | server 端 | **NO** | hidden tests 仅 server `judge-adapter.js#compileJava` 使用，永不下发 Browser |

---

## 2. 浏览器内 Java 运行时网络隔离测试（PoC evidence）

实测：跑 6 case HelloWorld/CE/RE/A+B Scanner/FastScanner 时，**全部走 wasm 本地编译运行**，无任何 source/stdin/stdout 上行：

```
[POC] assets ok: wasm=3.1MB, data=72.1MB
[POC] module created in 153ms. Waiting for CompileServer...
[POC] CompileServer READY (boot+compiler ready in 2261ms)
[PASS] HelloWorld -> status=ok exit=0 in 309ms
      stdout: JAVA_BROWSER_OK
[PASS] CE (missing semicolon) -> status=ce exit=1 in 156ms
      cePos: Main.java:4 error: 非法的表达式开始
[PASS] RE (ArithmeticException) -> status=re exit=1 in 312ms
      stderr: java.lang.ArithmeticException: / by zero @ Main.java:3
[PASS] NPE -> status=re exit=1 in 312ms
      stderr: NullPointerException @ Main.java:4
[FAIL] A+B Scanner (stdin) -> timeout 25091ms (JavaBox 半双工)
[PASS] FastScanner (BufferedReader) -> status=ok exit=0 in 154ms
      stdout: 30
```

**结论**：

- `sourceUploaded: false` ✓
- `stdinUploaded: false` ✓
- `localResultUploaded: false` ✓

唯一上行网络是 `fetch(javabox-direct.{wasm,data,mjs})`（首次 Runtime 加载），属于 Runtime asset **下载**，不含任何用户数据。

---

## 3. 正式 OJ 部署的网络隔离 Gate（待 self-build 完成）

| 项 | 要求 |
|---|---|
| Runtime assets 必须 self-host | `/runtime/java21-browserjdk-compat-v1/` 静态路由，immutable 缓存 |
| 禁止依赖个人 CDN | 当前 JavaBox prebuilt 来自 `javabox-demo.brian-fec.workers.dev`，**正式 OJ 部署禁止**；仅 PoC 阶段允许 |
| hidden tests 永不下发 Browser | `judge-adapter.js#compileJava` 仅 server 端读 hidden tests，browser Java 永远只跑 user source |
| Formal Submit 仍正常 | 即使 Local Java 不可用，"正式提交"按钮仍可正常 POST source 到 `/api/contest/contests/:cid/submissions`（server 端 OpenJDK 21 评测） |
| 禁止 Server Fallback | Local Java Runtime 加载失败时，**绝不**自动 POST source 到 server 帮用户运行；只显示 "Java 本地运行环境不可用 [重试]" |
| Local timeout 决不卡 UI | EXEC_TIMEOUT_MS（6s）后 SAB interrupt + grace → terminate + 重建 Worker；与 Python Worker FALLBACK 策略一致 |

---

## 4. 隐私契约文案（与 Python / C++ / C11 统一）

用户在页面看到的"运行时下载"提示文案：

> 首次使用可能从服务器下载并缓存静态运行环境；Runtime Ready 后，本地运行过程中源码、自定义输入及本地执行结果不发送至判题服务器。

Java 21 同样适用：
- 运行时下载：self-built `java21-browserjdk-compat-v1` assets（self-host，immutable）
- 源码 / stdin / stdout：仅在浏览器本地 wasm 内流动
- 网络请求：仅 Runtime asset 下载 + （若启用）正式提交时 POST source 到 `/api/contest/contests/:cid/submissions`（用户主动点击"正式提交"才发生）

---

## 5. 验证命令

```bash
# PoC 阶段：在浏览器 DevTools Network 面板观察
#   1. 首次进入 contest 页：不下载任何 Java Runtime 资源（默认语言不是 Java）
#   2. 切换语言到 Java 21：触发 ide-runner.prewarm('java') → 下载 javabox-direct.{wasm,data,mjs}
#      （仅这三个文件，无其他）
#   3. 点击"运行代码"：无任何 POST 请求，stdout 直接在浏览器渲染
#   4. 点击"正式提交"：POST /api/contest/contests/:cid/submissions
#      （含 source+language+problemId+contestId+clientRequestId）

# 自动化验证：scripts/java-poc-driver.mjs / scripts/java-poc-corpus.mjs
cd e:/mini
node scripts/java-poc-driver.mjs  # 6 case，落地 poc-evidence.jsonl
node scripts/java-poc-corpus.mjs  # 12 case，落地 poc-corpus-evidence.jsonl
```

---

## 6. 总结

| 维度 | 状态 |
|---|---|
| Source not uploaded | ✅ |
| Stdin not uploaded | ✅ |
| Local stdout not uploaded | ✅ |
| Runtime assets 来源合规 | ❌ SCAFFOLD → self-build 后 ✅ |
| Hidden tests 不下发 Browser | ✅ |
| 禁止 Server Fallback | ✅（worker + UI 双重保证） |
| Formal Submit 正常 | ✅ |
| Local Timeout 不卡 UI | ✅（FALLBACK terminate 兜底） |