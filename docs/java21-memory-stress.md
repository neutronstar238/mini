# Java 21 Memory Stress

环境：Chrome 151、真实 Problem Page、self-built `java21-browserjdk-compat-v2`。结论：PASS，无 blocking failure。

## Workload

- 500/500 个不同 Source：每个 compile + run，强制 LRU eviction。
- 1000/1000 次相同 Source / 不同 stdin：首轮 miss，后续 999 次 hit。
- Cache peak/final 均为 8 entries。
- 超限 stdout 精确截断为 1,048,576 bytes，`outputTruncated=true`，页面未崩溃。

## 独立指标

| Metric | Initial | Idle | Peak | Final / Max |
|---|---:|---:|---:|---:|
| WASM linear memory | N/A（Worker 初始化中） | N/A（JVM boot 中） | 463,994,880 B / 442.50 MiB | final 442.50 MiB; max 512 MiB |
| Java/JVM heap | N/A | N/A | N/A | N/A |
| JS used heap | 33,426,988 B | 33,472,836 B | 34,181,527 B | 19,940,122 B |
| Browser Process RSS | 178,184,192 B | 182,190,080 B | 188,022,784 B | 185,806,848 B |
| Renderer/Worker RSS | N/A | N/A | N/A | N/A |
| Runtime assets raw | 30,182,850 B | same | same | transfer N/A |

WASM 的 0 初始样本是 Worker `INITIALIZING_WASM/BOOTING_JVM` 时尚未暴露 buffer 的 sentinel，不表示物理内存为零，因此对外报告为 N/A。

稳定性窗口取 LRU warm-up 后的后半样本。只有同时满足 `delta >= max(8 MiB, baseline 5%)` 且正增长 step 占比至少 75% 才判明显线性持续增长。本轮 WASM delta 0；JS heap delta 119,045 B；Browser Process RSS delta 425,984 B，均低于 material-growth threshold，三项 PASS。

机器证据：`compat-tests/java21/memory/java21-memory-stress.json`。
