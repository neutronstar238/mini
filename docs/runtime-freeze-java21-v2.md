# Java 21 BrowserJDK v2 — BETA_FROZEN Runtime Freeze

冻结日期：2026-08-21（Asia/Shanghai）  
Runtime：`java21-browserjdk-compat-v2`  
Browser Local：`BETA_FROZEN`  
Official Judge：OpenJDK 21 Stable

本文件记录 Java 21 BrowserJDK v2 的工程冻结基线。冻结只在下面列出的回归、资产校验和既有 A14 可复现构建证据均通过后完成。状态是工程状态，不改变项目负责人和法律复核边界。

## 1. 公开状态与冻结入口

公开 manifest：`server/public/js/contest/runtime-manifest-java21.json`

```json
{
  "status": "BETA_FROZEN",
  "runtimeStatus": "BETA_FROZEN",
  "technicalValidated": true,
  "engineeringRedistributionReady": true,
  "legalReviewRequired": true,
  "redistributable": false
}
```

资产由 immutable manifest 管理：`server/public/js/runtime/java21-browserjdk-compat-v2/runtime-manifest.json`。本次仅更新公开 manifest 和本文件；v2 runtime 目录下的七项资产及 immutable manifest 均未修改。

## 2. 版本、协议和 source pins

| 项目 | 冻结值 |
|---|---|
| Java | OpenJDK `21.0.10+7`，Zero interpreter |
| OpenJDK upstream | `97a3d2372d457c5a72413df14bf08cf99545c695` |
| OpenJDK port | `e339656cdd1c9e09aaf1c4ca9a87c399e3df56a7` |
| OpenJDK patch SHA-256 | `4917b25fbe3b1c35bea4cbc8ebe08a2e9d782754ee425978cfae0dac44c58e75` |
| Emscripten | `5.0.2`, commit `c817c0ca4ba889ee24a185fd954cff7de1bd8afa` |
| Emscripten image | `sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d` |
| libffi | `3.4.6`, upstream `3d0ce1e6fcf19f853894862abcbac0ae78a7be60`, port `0b72a27b7cd647eb31f15144dcfeacde864de9f1` |
| libffi patch SHA-256 | `85468a7db6d5199ae30c4a002e2da03d3181f84b19f9e163bbf6adec8ba9a3e3` |
| libffi autoconf patch SHA-256 | `98f4f00752b6bdd5d8cd1ab58d6031b7f4be768407765ae6f7f029c3597d8354` |
| Build JDK | Temurin `21.0.10+7`, SHA-256 `ea3b9bd464d6dd253e9a7accf59f7ccd2a36e4aa69640b7251e3370caef896a4` |
| Control protocol | `BJOJ/1` |
| stdin protocol | `BJOJ/1 stdin ring contract`; no separate stdin version is invented |
| Target/runtime source | self-built BrowserJDK, self-hosted assets; no JavaBox binary/glue/CDN dependency |

`runtimeAssetHash` is the SHA-256 of the raw bytes of the immutable v2 `runtime-manifest.json`:

`eee8298d267c2ba781cc6db4d587e6a8a2a39ff8aac5692f1c3a3d01daee5878`

## 3. Immutable asset verification

校验命令：

```powershell
$m = Get-Content server/public/js/runtime/java21-browserjdk-compat-v2/runtime-manifest.json -Raw | ConvertFrom-Json
foreach ($a in $m.assets) {
  Get-FileHash server/public/js/runtime/java21-browserjdk-compat-v2/$a.file -Algorithm SHA256
}
```

结果：七项资产的 manifest bytes 和实际 bytes 全部一致，SHA-256 全部一致。

| 文件 | bytes | SHA-256 |
|---|---:|---|
| `browserjdk.wasm` | 3,226,551 | `7f2acfac69689859fe6a752c38378b8f472343d2425a7209f1b485023c2dfc4c` |
| `browserjdk.data` | 26,697,106 | `cbe3b484ece983726a2e7740178f271c29b0a9809d24e0977817eb57073ccc82` |
| `browserjdk.mjs` | 143,479 | `8c445a96e61090d0cb074588a31f1204f8525a5a645996147f1112dc8bd8ad0c` |
| `loader.mjs` | 9,272 | `cd8b4bef6832a23b7b771e6ce35efd4080624aa6ced87d3a36447a91ceac2520` |
| `LICENSE` | 22,152 | `0e45d00edb6894bccb03203de831668fc4f6e27e92cca5fe35c14b77aec52b6b` |
| `THIRD_PARTY_NOTICES.md` | 83,673 | `4873b87095d2c88a05ec04f9c4c4184275f995cce01df2e7509962b338e899b3` |
| `LINKED_COMPONENTS.json` | 617 | `5a199bfe4377868c1fe4ff3f804a2f240e30673de3cec7fbb882e3e066da542c` |

总 raw bytes：`30,182,850`。浏览器传输/压缩 bytes 当前 harness 不暴露，记为 `N/A`，不与 raw bytes 混称。

## 4. Runtime contracts

### Compile cache

- Key：`runtimeId + SHA-256(source)`；stdin 不进入 key。
- Capacity：8 个 bytecode-only LRU entries。
- 命中时 compile status 为 `SKIP`、compile time 为 0；每次 run 仍建立新的执行上下文、stdin、stdout 和 stderr。
- cache 不保留用户 source、stdin、stdout、stderr、`Class` 或 `ClassLoader` 对象。

### Isolation

- 每次 run 使用 fresh `MemoryClassLoader` 和 fresh stdin/stdout/stderr。
- `System` properties、Locale、TimeZone 在 run 结束后恢复；A–L browser isolation 和 server harness 均通过。
- 异常、超时后 worker/CompileServer 可继续接收下一次请求；无法中断时 terminate 并重建 worker。

### Timeout and output

- Local timeout policy 由 worker 的 `timeoutMs` 控制；冻结恢复回归使用 6,000 ms，Problem Page 针对 Zero 解释器使用 15,000 ms。
- 超时返回 `status=timeout`、`runStatus=TLE`、`timedOut=true`，并通过 interrupt；interrupt 无效时 terminate + recreate。
- stdout/stderr 单项上限为 1 MiB，超限返回 `outputTruncated=true`。

### Execution time

`executionTime` 只计入编译、link、WASM instantiate 完成后，开始向用户程序提供 stdin，到 `main/_start` 退出并完成 stdout flush 的程序执行区间；不计 compiler/JVM 初始化、compile、link 或 WASM instantiate。

## 5. Final regression evidence

以下命令均在本次冻结前执行，结果文件保留在 `compat-tests/java21/`；除 IO runner 的历史 manifest 字段外，所有 runner 均直接登记 v2 runtime ID。

| Runner/命令 | 实际结果 |
|---|---|
| `node compat-tests/java21/run-checkpoint1.mjs` | IO `12/12`，旧 ACM 子集 `12/12`；实际 worker runtime 为 v2 |
| `node compat-tests/java21/run-checkpoint2-corpus.mjs` | positive `38/38`；error `8/8`；compile/runtime/correctness 全部通过；blocking failures `0` |
| `node compat-tests/java21/run-phase7-core.mjs` | compile cache PASS；browser cache PASS；A–L isolation PASS；timeout/recovery PASS；output cap PASS |
| `$env:RUN_FROZEN='1'; node scripts/e2e/java-phase7-e2e.mjs` | Chrome `151.0.7922.170`，真实 Problem Page E2E `16/16`；C++11/C11/Python frozen regression `18/18`；blocking failures `0` |
| `node scripts/e2e/java-phase7-network.mjs` | Local Run PASS（仅同源 GET，无 source-like body）；Formal Submit PASS（唯一 source 上传路径）；blocking failures `0` |
| `node scripts/stress/java21-memory-stress.mjs` | 不同源码 `500/500`；相同源码/不同 stdin `1000/1000`；cache hits `999`；status PASS |

机器结果：

- `compat-tests/java21/results/java21-compatibility-matrix.json`
- `compat-tests/java21/results/checkpoint1-results.json`
- `compat-tests/java21/results/phase7-core-results.json`
- `compat-tests/java21/e2e/java21-e2e-results.json`
- `compat-tests/java21/network/java21-network-isolation.json`
- `compat-tests/java21/memory/java21-memory-stress.json`

### Stress and memory baseline

本次 stress 时间窗：`2026-08-21T10:00:20.873Z`–`2026-08-21T10:03:11.584Z`。

| 指标 | 初始/峰值/最终 |
|---|---:|
| WASM linear memory | `0 / 463,994,880 / 463,994,880` bytes |
| configured maximum | `536,870,912` bytes（512 MiB） |
| JS used heap | `33,523,631 / 34,273,378 / 19,856,749` bytes |
| Browser process RSS | `176,267,264 / 194,166,784 / 191,164,416` bytes |
| bytecode cache | `0 / 8 / 8` entries |
| output cap | `1,048,576` bytes，`outputTruncated=true` |

稳定性判定中 WASM linear memory、JS heap 和 browser RSS 均为 PASS；Java heap、renderer/worker 独立 RSS 由于没有可靠采样接口记为 `N/A`。

### Performance baseline

- Browser：Chrome `151.0.7922.170`，COOP/COEP cross-origin isolation enabled。
- Browser cache runner init：约 `802 ms`；browser isolation runner init：约 `767 ms`。
- Stress 首个不同 source：runtime load `904 ms`、compile `1,481 ms`、execution `4 ms`；最后一个不同 source compile `238 ms`、execution `1 ms`。
- Stress 相同 source 首次 compile `269 ms`，第 1000 次为 cache hit、compile `0 ms`、execution `1 ms`。
- Timeout 回归固定执行区间 `6,000 ms`；三次超时后 recovery 输出 `ALIVE`。

这些数值是本机工程基线，不作为不同浏览器、网络或服务器 Judge 的 SLA。

## 6. Reproducibility and licensing gate

- A14 既有证据记录两次 clean build 和 source-only rebuild 的七项资产 byte-identical，结论为 `Reproducible Build: PASS`；本次再次完成逐文件 bytes/SHA-256 校验。
- `licenseStatus` / engineering status：`CLEAR_WITH_OBLIGATIONS`。
- 许可证与实际链接组件矩阵：`browserjdk-oj/THIRD_PARTY_LICENSE_MATRIX.md`；notice：`browserjdk-oj/THIRD_PARTY_NOTICES.md`。
- 当前公开状态保留 `legalReviewRequired=true`、`redistributable=false`；工程结论不替代项目负责人和法律复核。

## 7. Known divergences and scope boundary

- Runtime 使用 Zero interpreter、无 JIT；相对 server OpenJDK HotSpot，执行性能不可直接等价。
- 浏览器 WASM linear memory 上限为 512 MiB，server Judge 的内存配置不同。
- Thread/ExecutorService/ForkJoinPool、Socket/ServerSocket、ProcessBuilder/Runtime.exec、GUI（Swing/JavaFX/AWT）、JNI 和 third-party jar 不属于本冻结 profile。
- Browser 编译诊断文本、异常栈前缀和行号上下文可能与 server javac/java 不同；冻结门禁比较 verdict、异常类别和确定性 stdout，不要求诊断文本字节相同。
- Browser transfer/compression bytes 和独立 JVM heap/worker RSS 不是当前 harness 的可观测指标。

## 8. Version upgrade rule

以下任一冻结组件发生变化，必须创建 `java21-browserjdk-compat-v3` 或更高版本，禁止静默覆盖 v2：

- OpenJDK、Emscripten、libffi、WASM ABI 或 build source pins；
- `BJOJ/1` control protocol 或 stdin ring contract；
- CompileServer、JSR-199 strategy、bytecode cache key/capacity/eviction；
- MemoryClassLoader isolation、timeout/recovery、worker lifecycle 或 execution-time definition；
- runtime asset layout、任何七项资产、immutable manifest 或其 hash。

旧 v2 目录、公开证据和 hash 必须保留。后续 Java 工作仅限 regression；共享层改动造成回归时，先记录失败层和 blocker，再决定是否建立新版本。

## 9. Freeze result

全部冻结门禁通过，输出：

`JAVA21_BETA_FREEZE_COMPLETE`
