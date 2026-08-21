# JAVA_PHASE7_CHECKPOINT_2

结论：`java21-browserjdk-compat-v2` 已满足本检查点的全部技术与工程门禁，Java Profile 从 `SCAFFOLD` 升级为 `BETA`。这不是 `STABLE` 或 `FINAL FROZEN`；比赛启用和二进制再分发仍需项目负责人/法律审核。

## 范围与版本

- 本轮仅执行 A7–A14；没有重新执行 A1–A6，也没有开始 Modern C++。
- v2 是必需的新 Runtime ID：CompileServer、bytecode cache、stdin/timeout/isolation contract 与 runtime binary 均发生实质变化；v1 未被静默覆盖。
- Runtime：self-built OpenJDK `21.0.10+7-LTS`、Emscripten `5.0.2`、协议 `BJOJ/1`，无 JavaBox binary/glue/CDN 依赖。

## 验收汇总

| Area | Result | Evidence |
|---|---:|---|
| A7 Compile Cache | PASS | 首次编译；两个相同源码 run 均 `SKIP/cacheHit`; 源码改变后 miss |
| A8 Isolation | 12/12 | A–H 8/8；I–L 4/4；Properties/Locale/TimeZone 均恢复 |
| A9 Timeout | PASS | 三类超时均在约 6 s 返回 Local TLE；Worker 重建后 `ALIVE` |
| A10 Corpus | 38/38 positive + 8/8 error | Browser = Server OpenJDK 21 = Expected；3 CE + 5 RE 分类一致 |
| A11 Chrome E2E | 16/16 | Chrome 151，从真实 Problem Page 覆盖 load/run/sample/cache/CE/RE/TLE/recovery/error/submit |
| Frozen regression | 18/18 | C++11、C11、Python 各 6/6 Chrome E2E |
| A12 Network | PASS | Local Run 无 source/stdin/stdout/stderr 上行；Formal Submit 是唯一 source 上传 |
| A13 Stress | PASS | 500/500 不同源码；1000/1000 同源码不同 stdin；LRU peak/final 8 |
| Output cap | PASS | stdout 精确截断为 1,048,576 bytes，页面和 Worker 未崩溃 |
| A14 Rebuild | PASS | 两次独立 clean build 的 7 个 manifest assets byte-identical |
| A14 Source rebuild | PASS | 仅 final source archive、manifest 与固定 build image 重建出相同 7 assets |

## Memory 与尺寸

- WASM linear memory：初始化/idle 时 Worker 尚在启动，指标未就绪；运行后 peak/final `463,994,880 B`（442.50 MiB），configured max `536,870,912 B`（512 MiB）。
- JS used heap：idle `33,472,836 B`（31.92 MiB），peak `34,181,527 B`（32.60 MiB），final `19,940,122 B`。
- Browser Process RSS：idle `182,190,080 B`（173.75 MiB），peak `188,022,784 B`（179.31 MiB），final `185,806,848 B`。
- Runtime manifest assets raw：`30,182,850 B`（28.78 MiB）；transfer/compression bytes 未由 harness 暴露，记为 `N/A`。
- Java/JVM heap 与 Renderer/Worker 独立 RSS 无可靠采样接口，均明确记为 `N/A`，没有与 WASM memory 或 Browser RSS 混称。

## 工程与法律状态

`TECHNICALLY_VALIDATED=true`，`ENGINEERING_REDISTRIBUTION_READY=true`，`LEGAL_REVIEW_REQUIRED=true`，`REDISTRIBUTABLE=false`。

工程结论只表示 12 项可复核门禁均已完成，不代表法律批准。Immutable runtime manifest 仍保留构建时的 `CHECKPOINT_2_CANDIDATE` 证据状态；产品 Profile 的验收状态为 `BETA`。

## 机器报告

- `compat-tests/java21/results/java21-compatibility-matrix.json`
- `compat-tests/java21/results/java21-isolation-results.json`
- `compat-tests/java21/results/java21-memory-stress.json`
- `compat-tests/java21/results/java21-e2e-results.json`
- `compat-tests/java21/results/java21-network-isolation.json`
- `compat-tests/java21/results/java21-redistribution-engineering-gate.json`

本检查点在此停止；不自动进入 Modern C++。
