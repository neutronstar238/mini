# Java 21 Timeout Results

Runtime：`java21-browserjdk-compat-v2`。结论：Timeout PASS，Recovery PASS。

| Case | 实测 | 分类 |
|---|---:|---|
| `while(true){}` | 6003 ms | Local TLE |
| 大循环无 IO | 6004 ms | Local TLE |
| 递归 | 6005 ms | `LOCAL_TIMEOUT_FALLBACK` / Local TLE |
| timeout 后 `print("ALIVE")` | 1323 ms | AC，stdout `ALIVE` |

生产 Worker 收到真实 SharedArrayBuffer interrupt ring；未在 grace 内退出时终止 Worker，再按相同 immutable runtime assets 重建 JVM。本次三类 timeout 各触发一次重建，`restartCount=3`，页面线程保持响应。

UI 文案保持：“本地运行超时仅用于调试保护，正式 TLE 以服务器 Judge 为准。”Local TLE 不等同正式 Judge TLE。真正 `StackOverflowError` 的 Browser/Server RE 分类另由 A10 error suite 验证。

机器证据：`compat-tests/java21/timeout/timeout-results.json`。
