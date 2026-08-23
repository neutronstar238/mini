# Java 21 Browser E2E

环境：真实 Google Chrome `151.0.7922.170`，从登录后的真实 Problem Page 开始；Runtime 为 self-built `java21-browserjdk-compat-v2`。

结论：Java 16/16 PASS。

覆盖 Problem Page、Java 21 selector、`NOT_LOADED`、custom stdin、`READY`、DOWNLOAD/BOOT_JVM/INITIALIZE_COMPILER/READY progress、same-source cache hit、Sample Run、`Local Sample Passed != Accepted`、CE、RE、timeout recovery、1 MiB output cap、Formal Submit 与模拟 runtime-loading error。冻结恢复回归使用 6 s timeout；当前 Problem Page 针对 Zero 解释器使用 15 s。加载失败被归类为 runtime unavailable，而不是 Compile Error。

共享层冻结回归也在同一真实 Chrome 流程中通过：

| Runtime | A+B / Sample / Cache / CE / RE / ExecutionTime |
|---|---:|
| `cpp11-gcc11-compat-v5` | 6/6 |
| `c11-gcc11-compat-v3` | 6/6 |
| `py312-cpython-compat-v1` | 6/6 |

C/C++ RE 用非零 exit code 验收；底层统一结果对象仍保留既有 `runStatus` 语义，没有把它误写为 Java RE 语义。

机器证据：`compat-tests/java21/e2e/java21-e2e-results.json`。
