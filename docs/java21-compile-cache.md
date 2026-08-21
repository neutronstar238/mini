# Java 21 Compile Cache

Runtime：`java21-browserjdk-compat-v2`。结论：PASS。

实现保存 immutable compiled class bytes，key 为 `runtimeId + SHA-256(source)`，LRU capacity 为 8。cache entry 不保存 stdin、stdout、执行结果、`Class<?>` 或已运行的 ClassLoader；每次 run 都创建新的 `MemoryLoader` 并再次调用 `Main.main()`。

| Run | Source | stdin / stdout | compileStatus | cacheHit | compileTime |
|---|---|---|---|---:|---:|
| A | original | `stdin-1` / `stdin-1` | PASS | false | 1952 ms |
| B | original | `stdin-2` / `stdin-2` | SKIP | true | 0 ms |
| C | original | `stdin-3` / `stdin-3` | SKIP | true | 0 ms |
| D | changed | n/a / `changed` | PASS | false | 301 ms |

源码 SHA-256 从 `dbf12d…75c87e` 变为 `1bfc4c…470ef6` 后正确 miss。Isolation suite 中 static field 连续三次都输出 `1`，证明 cache hit 没有复用实际执行过的 Class 对象。

机器证据：`compat-tests/java21/cache/cache-results.json`。
