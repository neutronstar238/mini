# Codeforces 混合 Verdict 浏览器回放审计报告

> 状态：**实测完成（2026-08-23）**
>
> 目标：使用真实 Codeforces 源码，分别覆盖原始 `AC / WA / CE / RE / TLE / MLE`，审计其在当前 Web Runtime 的公开测试回放行为。
> 边界：这是 Browser Local compatibility audit，不是正式 Judge、隐藏测试或服务器吞吐测试。

## 1. 先读结论

本报告的最终结论必须区分以下三个问题：

1. 浏览器是否能编译这份源码；
2. 在当前可取得的公开/生成测试上，浏览器是否得到正确输出或复现失败；
3. Codeforces 的原始 verdict 是否能被浏览器公开测试回放**同类观察到**。

其中第 2 项不能替代 Codeforces 隐藏测试判定，第 3 项也不能把浏览器的本地结果写成 Official Verdict。`AC_PUBLIC` 表示“通过本次公开测试集”，不是“已证明官方 AC”；同理，`TLE_LOCAL`、`MLE_OBSERVED` 等均必须保留环境限定。

### 1.1 本轮实测摘要

| 指标 | 数值 |
|---|---:|
| Contest / 数据集版本 | `908 + 914 + 573 + 955 + 608`；open-r1 default / selected_incorrect |
| 含源码提交数 | 60（六类 verdict 各 10） |
| 实际执行 / 去重 source | 60 / 60 |
| 独立验证 `source == og_source` | 6；另 54 份只有 dataset `source`，原始字节不可独立核验 |
| 公开/生成测试总数 | 122 |
| 测试执行总次数 | 318 |
| 主结果 `all_pass` | 30（其中原始 OK 为 10/10） |
| 主结果 Browser CE | 9 |
| 主结果公开测试 WA | 8 |
| 主结果公开测试 RE | 8 |
| 主结果本地 TLE | 5 |
| 可明确观测 MLE | 0（当前不可比较） |
| Unsupported / Harness/System Error | 0 / 0 |

Chrome 版本为 `151.0.7922.174`。网络隔离共拦截 7 次 Mini-OJ 自身
device heartbeat POST；没有提交源码发起网络请求。

### 1.2 原始 verdict 同类复现率

| 原始 verdict | Sources | 同类复现 | 未同类复现 | 解释 |
|---|---:|---:|---:|---|
| OK | 10 | 10 | 0 | 10/10 为 `AC_PUBLIC` |
| WA | 10 | 3 | 7 | 6 份公开测试全过，1 份表现为 RE |
| CE | 10 | 9 | 1 | 1 份在 Python 3.12 可编译但输出不匹配 |
| RE | 10 | 4 | 6 | 4 份全过，2 份表现为 WA |
| TLE | 10 | 3 | 7 | 6 份全过，1 份表现为 WA |
| MLE | 10 | N/A | N/A | 无 per-run memory quota，不计算 concordance |

> 不能用“所有原始提交”直接做正确率分母：原始数据含拒绝提交、重复源码、缺失源码、未支持语言以及无法取得对应测试的记录。每个分母必须在表下注明。

## 2. 数据来源与可复现边界

### 2.1 原始 Codeforces verdict

Codeforces `contest.status` 返回比赛提交列表，提交对象包含语言、题目、verdict、耗时和内存等元数据；源码批量返回受权限限制，`includeSources` 只对比赛 manager 可用。参见 [Codeforces API 方法文档](https://codeforces.com/apiHelp/methods?locale=en) 中的 `contest.status` 说明。

本轮数据记录至少要保留：

| 字段 | 用途 |
|---|---|
| `contestId`、`submissionId` | 唯一定位 |
| `problemId` / `problemIndex` | 问题分层 |
| `programmingLanguage` | 原始语言标签与 Runtime 映射 |
| `verdict` | 原始 Codeforces verdict，作为比较基准，不覆盖 |
| `source`、`og_source`、`sourceHash` | 源码真实性、去重和回放审计 |
| `timeConsumedMillis`、`memoryConsumedBytes` | 仅作为官方侧记录；不能直接与浏览器计时/内存等价 |
| `sourceBytesUtf8` | 检查正式提交源代码上限 |

缺失源码的记录只能进入 `NO_SOURCE` 统计，不能伪造为浏览器 CE/RE。

### 2.2 测试输入来源

本轮公开测试由题面样例和可公开取得的生成/测试数据组成；必须给每个 test 标注 `testOrigin = sample | generated | other-public`，并记录输入/期望输出的 UTF-8 字节数。

公开测试边界如下：

- 不含 Codeforces 官方隐藏测试全集；
- 生成测试若非 Codeforces 官方评测输入，只能称为 public/generated corpus；
- 题目没有公开测试或测试下载失败时，源码只能记为 `NO_TESTS`，不能记 `AC_PUBLIC`；
- 浮点输出必须记录比较器、容差、是否 tokenized；不能把比较器放宽后的匹配写成逐字节一致。

### 2.3 安全与回放要求

第三方源码只在浏览器 Worker 中运行。回放记录浏览器版本、Runtime manifest/hash、网络拦截规则、机器信息、测试数据版本和 Harness 版本。源码、stdin、stdout/stderr 不应向外部网络上传；任何违反隔离或 Harness 自身异常均记 `HARNESS_SYSTEM_ERROR`，不得归入程序 RE。

## 3. 当前 Web Runtime 的限制基线

下表是回放时必须写入报告的**本地限制**，不是 Codeforces 题目的限制，也不是正式 Judge 的限制。

| Browser profile | 当前实现 | stdin | stdout / stderr | Local execution timeout | 编译/初始化 | 内存观察 |
|---|---|---:|---:|---:|---:|---|
| C11 frozen | Clang 8 + WASI | 4 MiB（UTF-8 字节） | 各 1 MiB，超限 `outputTruncated` | 6 s | C/C++ compile guard 90 s | 没有按题目配置的浏览器 MLE 配额；C 链接栈 8 MiB |
| C++11 frozen | Clang 8 + WASI/libc++ | 4 MiB（UTF-8 字节） | 各 1 MiB，超限 `outputTruncated` | 6 s | C/C++ compile guard 90 s | 没有按题目配置的浏览器 MLE 配额；C++ 链接栈 1 MiB |
| C17 / C++17 modern | Clang 19.1.7 + WASI | 4 MiB | 各 1 MiB（执行 Worker 按字节封顶） | 6 s | C/C++ compile guard 90 s | manifest 的 compiler/linker linear memory 为 initial 256 MiB / max 1 GiB、stack 32 MiB；这是 compiler engine 观测，不等价于用户程序 MLE |
| Python 3 | CPython 3.12 / Pyodide | 未在 Python Worker 声明统一 stdin 上限（按回放实际值记录） | 各 1 MiB，`CappedBytesIO` | 6 s；SAB fallback 会 terminate/rebuild | Runtime init 60 s | 没有题目级浏览器 MLE 判定；WASM/JS/Worker 内存应单独记录 |
| Java 21 | BrowserJDK / OpenJDK Zero | 协议 ring 2 MiB；源码协议上限 12 MiB；stdin 写入无单独题目级上限（超大输入需记录 ring/back-pressure） | 各 1 MiB | 15 s；SAB interrupt 后可重建 | JVM/asset init 120/180 s | Emscripten linear memory configured max 512 MiB；native JVM `MaxHeapSize` 256 MiB；均不等于 Codeforces memoryConsumed，也没有独立 MLE verdict |

实现证据：

- 通用 C/C++/Python 本地执行超时和 C/C++ stdin 上限：`server/public/js/contest/ide-runner.js:84-87`；Java 专用 15 s：`server/public/js/contest/ide-runner.js:815-819`；
- frozen C/C++ 输出上限及 C/C++ 栈参数：`server/public/js/contest/ide-wasi-worker.js:19,191-209`；
- modern source/stdin/output 限制：`server/public/js/contest/ide-wasi-worker-modern.js:24-26,708-711,816-823`；执行 Worker 的字节输出封顶：`server/public/js/contest/ide-wasi-execution-worker-modern.js:4-24`；
- Python 输出封顶：`server/public/js/contest/ide-python-worker.js:88-110`；
- Java ring、协议源码上限、内存统计语义：`browserjdk-oj/src/js/loader.mjs:10-11,159-190`；ring capacity 与 JVM max heap：`browserjdk-oj/src/native/browserjdk_main.c:17,246`；
- modern memory manifest：`server/public/js/runtime/cpp-modern-engine-v2/runtime-manifest.json:114-118`；
- 正式 Submit 源码上限是 256 KiB UTF-8：`server/src/config.js:77-78`。Browser Local 允许的源代码尺寸并不在所有 profile 上统一，超出正式上限的源码必须单独标为 `SUBMIT_INELIGIBLE`。

输出上限的计量单位也要保留：frozen C/C++ Worker 使用 `MAX_OUTPUT_CHARS`（JS 字符串长度），modern 执行 Worker 使用 UTF-8 字节，Python/Java 的 capped stream 按字节。三者都显示为约 1 MiB，但不能在边界测试中假设完全相同。

### 3.1 题目限制必须单独记录

本轮 corpus 没有固化 `officialTimeLimitMs` / `officialMemoryLimitMb`，因此不做
题目限制等价结论。后续生成器应补齐这两个字段；在此之前，不得用上表的
6/15 s 或 WASM memory 数字代替官方限制。

## 4. Verdict 语义与可复现判定表

### 4.1 运行级别状态

每个 source/test run 必须原样保存 `compileStatus`、`runStatus`、`exitCode`、`timedOut`、`aborted`、`outputTruncated`、`stdout`、`stderr`、`executionMs`、`wallMs` 和 Harness 状态。建议把浏览器观察状态规范化为以下集合：

`COMPILE_PASS | BROWSER_CE | PASS_OUTPUT_MATCH | BROWSER_WA_PUBLIC | BROWSER_RE | BROWSER_TLE_LOCAL | BROWSER_MLE_OBSERVED | OUTPUT_LIMIT | INPUT_LIMIT | HARNESS_TIMEOUT | RUNTIME_UNAVAILABLE | HARNESS_SYSTEM_ERROR`。

其中 `OUTPUT_LIMIT`、`INPUT_LIMIT` 和 `RUNTIME_UNAVAILABLE` 不得默认为 WA/RE；它们是环境/协议限制，应单独计数。

### 4.2 原始 verdict 与浏览器观察的关系

| 原始 CF verdict | 浏览器公开回放可称为“复现”的条件 | 可报告的强度 | 不能推断 |
|---|---|---|---|
| AC / `OK` | 源码成功编译，所有可用公开测试输出匹配，且没有 RE/TLE/limit/harness failure | `AC_PUBLIC`；若与原始 AC 一致，记 `AC_PUBLIC_CONCORDANT` | 不能证明隐藏测试通过、官方时间/内存通过 |
| WA / `WRONG_ANSWER` | 成功编译且至少一个公开测试正常结束但 comparator 不匹配 | `WA_REPRODUCED_PUBLIC` | 公开测试全过时不能证明代码官方应 AC；可能是 hidden-only WA |
| CE / `COMPILATION_ERROR` | 浏览器编译阶段明确非零失败/诊断，未进入用户程序执行 | `BROWSER_CE`；与原始 CE 只能记 `LOCAL_CE_CONCORDANCE` | 不能证明两边是同一个编译器错误；Clang/GCC、标准库和 flags 不同 |
| RE / `RUNTIME_ERROR` | 至少一个公开测试触发用户程序非零退出、异常、trap 或明确执行错误；且不是 Harness/Worker 协议故障 | `RE_REPRODUCED_PUBLIC` | 公开测试未触发 RE 时不能排除 hidden RE |
| TLE / `TIME_LIMIT_EXCEEDED` | 浏览器明确由本地 wall timer/interrupt/terminate 终止用户程序 | `TLE_OBSERVED_LOCAL`；可加 `LOCAL_TLE_CONCORDANCE` | 6/15 s 不是题目 time limit；浏览器 WASM/Zero 与 Codeforces 硬件/编译器不同；未超时不等于官方不 TLE |
| MLE / `MEMORY_LIMIT_EXCEEDED` | 只有在浏览器提供明确的用户程序 memory limit，并捕获到超限/内存异常且排除页面/编译器内存时，才能记 `MLE_OBSERVED_LOCAL` | 当前默认 `MLE_NOT_MEASURABLE` 或 `MEMORY_SIGNAL_UNCLASSIFIED` | 线性内存 max、JS heap、Worker RSS、浏览器崩溃、OOM kill、Java heap 都不能直接等价 CF MLE |

### 4.3 原始 verdict 未被公开测试复现时

这不是成功，也不是失败修复结论，必须写成“未观察到”：

| 原始 verdict | 浏览器通过公开测试时的分类 |
|---|---|
| WA | `WA_NOT_REPRODUCED_PUBLIC`（疑似隐藏测试差异/测试覆盖不足） |
| RE | `RE_NOT_REPRODUCED_PUBLIC` |
| TLE | `TLE_NOT_REPRODUCED_PUBLIC`（不等于性能安全） |
| MLE | `MLE_NOT_MEASURABLE`，即使浏览器公开输入通过 |
| CE | `CE_NOT_REPRODUCED_BROWSER`（编译器/标准库差异或数据元信息需审计） |

## 5. 为什么 MLE 不能直接等价

这是本报告的硬门槛，不能省略：

1. Codeforces 的 `memoryConsumed` 是其服务器判题沙箱对特定编译器、进程、输入和题目 memory limit 的测量结果；它不是源码静态属性。
2. C/C++ 浏览器程序是 WASM 实例。manifest 中的 initial/max linear memory 描述的是 compiler/linker 或 WASM instance 的地址空间能力，不是操作系统 RSS、用户 heap 峰值或 Codeforces memory accounting。
3. Java 同时存在 Emscripten linear memory、JVM heap、JS heap、Worker/renderer RSS；当前 `memoryStats()` 明确只报告 linear memory，不报告 JVM heap、JS heap 或 renderer RSS。
4. Python 的 Pyodide/WASM、JS 对象、Worker 和浏览器页面共享不同内存层；当前结果没有题目级 MLE verdict。
5. 浏览器端 memory growth、浏览器 OOM、WASM `memory.grow` 失败、Java `OutOfMemoryError`、Worker crash 和页面崩溃可能呈现为 RE、ABORTED、UNAVAILABLE、Harness timeout 或无结果，而不是稳定的 `MLE`。
6. 题目公开测试通常小于隐藏测试；一个原始 MLE 提交公开输入不超内存，只能说明“当前公开输入未观测到内存超限”。

因此：原始 MLE 语料必须被采集和执行，但主指标应是 `MLE detection coverage`，不是把“浏览器没有崩”计为通过。除非专门增加可审计的 per-run memory quota、峰值采样、终止原因和映射规则，否则 MLE 结论固定为 `NOT_MEASURABLE`。

## 6. Source 级聚合规则

### 6.1 建议的聚合字段

每个 source 保存：

```json
{
  "submissionId": "...",
  "officialVerdict": "AC|WA|CE|RE|TLE|MLE|OTHER",
  "originalLanguage": "...",
  "browserProfile": "...",
  "problemId": "...",
  "sourceBytesUtf8": 0,
  "sourceEligibleForFormalSubmit": true,
  "testsAvailable": 0,
  "testsExecuted": 0,
  "failureSet": [],
  "browserPublicOutcome": "AC_PUBLIC|BROWSER_CE|BROWSER_WA_PUBLIC|BROWSER_RE|BROWSER_TLE_LOCAL|BROWSER_MLE_OBSERVED|NO_TESTS|NO_SOURCE|UNSUPPORTED_LANGUAGE|HARNESS_SYSTEM_ERROR",
  "officialBrowserRelation": "...",
  "compileMs": {"median": null, "p95": null},
  "executionMs": {"median": null, "p95": null},
  "maxObservedInputBytes": 0,
  "maxObservedOutputBytes": 0,
  "outputTruncated": false,
  "memoryTelemetry": "none|partial|user-peak|explicit-limit"
}
```

### 6.2 Source outcome precedence

保留所有 `failureSet`，同时生成一个主结果供矩阵统计。建议优先级为：

`HARNESS_SYSTEM_ERROR` → `UNSUPPORTED_LANGUAGE / NO_SOURCE / NO_TESTS` → `BROWSER_CE` → `BROWSER_MLE_OBSERVED` → `BROWSER_TLE_LOCAL` → `BROWSER_RE` → `BROWSER_WA_PUBLIC` → `AC_PUBLIC`。

如果一次回放同时出现多个失败，报告中还要保留**第一次失败的 testIndex**和每类失败计数，避免单一主结果掩盖 Runtime 缺陷。

### 6.3 原始 verdict × 浏览器主结果矩阵

| Official \ Browser | all_pass | Browser CE | Public WA | Public RE | Local TLE | Unsupported/System |
|---|---:|---:|---:|---:|---:|---:|
| OK | 10 | 0 | 0 | 0 | 0 | 0 |
| WA | 6 | 0 | 3 | 1 | 0 | 0 |
| CE | 0 | 9 | 1 | 0 | 0 | 0 |
| RE | 4 | 0 | 2 | 4 | 0 | 0 |
| TLE | 6 | 0 | 1 | 0 | 3 | 0 |
| MLE | 4 | 0 | 1 | 3 | 2 | 0 |

MLE 行只是 Browser outcome 分布，不是 MLE concordance：两份 573/B 在本地
超时，三份 914/E 出现 `Maximum call stack size exceeded`，一份输出不匹配，
四份公开测试全过；这些信号均不能等价为 Codeforces MLE。

矩阵中的分母是“含源码且完成一次可归类回放的 source 数”；被 Harness/Runtime 阻断的记录另列，不得静默删除。

## 7. 按语言分层指标

原始 Codeforces 标签不能直接当作 Browser profile。报告同时展示原始标签、规范化语言族和实际 Browser Runtime。

| Original language | Browser profile | Sources | Compiled | all_pass | CE | Public WA | Public RE | Local TLE |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| GNU C | C11 frozen | 2 | 2 | 2 | 0 | 0 | 0 | 0 |
| GNU C11 | C11 frozen | 2 | 2 | 2 | 0 | 0 | 0 | 0 |
| GNU C++ | C++11 v5 | 1 | 1 | 1 | 0 | 0 | 0 | 0 |
| GNU C++11 | C++11 v5 | 4 | 4 | 1 | 0 | 1 | 0 | 2 |
| C++14 (GCC 6-32) | C++17 modern v2 | 7 | 7 | 4 | 0 | 0 | 3 | 0 |
| Python 3 | Python 3.12 | 18 | 15 | 7 | 3 | 5 | 2 | 1 |
| PyPy 3 | Python 3.12 | 12 | 9 | 5 | 3 | 2 | 1 | 1 |
| PyPy 3-64 | Python 3.12 | 13 | 10 | 7 | 3 | 0 | 2 | 1 |
| Java 8 | Java 21 BrowserJDK | 1 | 1 | 1 | 0 | 0 | 0 | 0 |

每个语言组至少计算：

- `compile_success_rate = compiled / source_executed`；
- `public_pass_rate = AC_PUBLIC / source_with_tests`；
- `official_rejection_observed_rate`，但按原始 verdict 分开计算，不能把 AC 与 rejected 混在一个“正确率”；
- `official_verdict_concordance`，只在该 verdict 的观察条件满足时计算；MLE 默认 `N/A`；
- compile / execution / wall time 的 p50、p95、max；
- input/output limit hit、Harness failure、memory telemetry coverage；
- source-size 分层（≤256 KiB、>256 KiB）及 `SUBMIT_INELIGIBLE` 数量。

> C++14、GNU C++、GNU C++11、MS C++ 等原始标签映射到不同 Browser profile 时，必须把“原始编译器/标准”和“浏览器编译器/标准”都写出，不能报告成同一编译环境。

## 8. 按问题分层指标

| Problem | Tests | Sources | Original verdicts | Max input bytes | Browser outcomes |
|---|---:|---:|---|---:|---|
| 573/B | 5 | 2 | MLE=2 | 1,000,007 | TLE=2 |
| 608/B | 4 | 2 | MLE=2 | 400,002 | all_pass=2 |
| 908/A | 3 | 17 | OK=4, WA=4, CE=8, RE=1 | 5 | pass=8, CE=7, WA=1, RE=1 |
| 908/B | 7 | 2 | WA=1, RE=1 | 256 | pass=1, WA=1 |
| 908/C | 22 | 9 | WA=1, CE=1, RE=5, TLE=2 | 4,009 | pass=2, CE=1, WA=3, RE=3 |
| 908/D | 2 | 5 | OK=2, RE=1, TLE=2 | 6 | all_pass=5 |
| 908/E | 27 | 4 | OK=2, WA=1, CE=1 | 50,058 | pass=2, CE=1, WA=1 |
| 908/F | 2 | 9 | WA=3, RE=2, TLE=4 | 2,588,902 | pass=6, WA=1, RE=1, TLE=1 |
| 908/G | 22 | 3 | OK=1, TLE=2 | 701 | pass=1, TLE=2 |
| 908/H | 18 | 1 | OK=1 | 2,259 | all_pass=1 |
| 914/E | 5 | 4 | MLE=4 | 2,777,789 | WA=1, RE=3 |
| 955/F | 5 | 2 | MLE=2 | 502,552 | all_pass=2 |

问题层必须补充：

- 测试来源拆分：sample / generated / other-public；
- 测试输入尺寸分位数和最大值；
- 输出 token/字节规模及 `outputTruncated`；
- 每种原始 verdict 在该题的 Browser outcome 分布；
- 题目官方 time/memory limit 与浏览器固定本地保护的差值；
- 是否存在该题没有公开测试、只含样例或生成数据明显偏小的情况。

## 9. 指标定义

| 指标 | 定义 | 允许的解读 |
|---|---|---|
| `compile_success_rate` | 成功完成 Browser compile/link 的 source 数 / 可执行 source 数 | 兼容性编译指标 |
| `test_output_match_rate` | 正常结束且 comparator 匹配的 test runs / 已执行 test runs | 公开输入上的输出匹配率 |
| `AC_PUBLIC_rate` | 所有可用公开测试通过的 source / 有测试且执行完成的 source | 公开测试通过率，不是 Official AC 率 |
| `WA_reproduction_rate` | 原始 WA 中至少一个公开测试 mismatch 的 source / 可执行原始 WA source | 公开测试能否触发错误的覆盖指标 |
| `RE_reproduction_rate` | 原始 RE 中公开输入触发排除 Harness 故障的 RE source / 可执行原始 RE source | 公开测试 RE 触发率 |
| `TLE_local_observation_rate` | 原始 TLE 中触发本地计时器的 source / 可执行原始 TLE source | 本地保护观察率，不是官方 TLE 等价率 |
| `MLE_detection_rate` | 仅以明确 per-run memory quota + 原因映射为分母/分子 | 未建立硬配额时为 `N/A` |
| `failure_class_concordance` | Browser 观察类与原始 verdict 同类的 source / 该 verdict 可执行 source | 需按类、语言、问题分层 |
| `coverage` | 已执行 source 或 test / 目标 source 或 test | 必须列出阻断原因 |

## 10. 复现命令和原始证据

```powershell
# 另一个终端启动本地服务
$env:PORT = '3101'
node server/src/app.js

# 混合 verdict corpus / replay
$env:BASE_URL = 'http://127.0.0.1:3101'
$env:CF_COMPAT_CORPUS = Join-Path $PWD 'tmp\codeforces-compat\contest-mixed-verdicts-corpus.json'
$env:CF_COMPAT_REPORT = Join-Path $PWD 'output\codeforces-mixed-verdict-browser.json'
$env:CF_COMPAT_RUN_TIMEOUT_MS = '30000'
node scripts/e2e/codeforces-browser-compat.mjs
```

必须归档：

- corpus 原文件、下载来源和 hash；
- raw replay JSON；
- 浏览器版本、Runtime manifest/hash、OS/设备信息；
- 每个 source/test 的 stdout/stderr 预览、exit code、status、timing；
- 原始 verdict 与 Browser outcome 映射表；
- 被跳过或失败的 source/test 及原因；
- 运行前后 `git status --short` 与改动文件列表。

## 11. 最终审计判定

本轮 60 份 submission-derived 源码全部进入 Browser Runtime，覆盖 C、C++、
Python 和 Java；10 份原始 OK 全部通过 122 个测试池中各自对应的公开测试，
没有发现新的 AC 兼容性回退。失败 verdict 的同类复现率是测试覆盖指标：WA
30%、CE 90%、RE 40%、TLE 30%，不能解释为浏览器 verdict 准确率。

MLE 语料已经采集并执行，但当前没有统一、可审计的用户程序内存配额和终止
原因映射，因此 MLE detection/concordance 结论仍为 N/A。Browser Local 的
输入、输出和固定 6/15 秒保护也不等同于 Codeforces 的题目限制。

## 12. 审计阻塞与后续工作

- 原始源码不可得的提交不能进入执行分母；
- 未支持语言、source 超过正式 256 KiB、无公开测试和 Runtime 初始化失败必须独立统计；
- 原始 CE 不能只靠浏览器 CE 断言“同一 CE”，需保留编译器、版本、标准库和 flags；
- 原始 TLE 不能用固定 6/15 s 直接等价，必须按题目限制和本地保护窗口另列；
- 原始 MLE 在没有 per-run memory quota、峰值采样和可解释终止原因前保持 `N/A`；
- 需要专门构造/取得覆盖大输入、大输出、深递归、堆峰值、WASM memory growth、Java heap 和 Python object growth 的边界语料；
- 若要宣称“比赛全语言兼容”，还需加入当前语言 allowlist 中的 C11、C++11、C17、C++17、Python 3、Java 21，并对每个原始语言标签说明近似映射。
