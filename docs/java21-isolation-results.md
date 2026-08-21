# Java 21 Run Isolation Results

Runtime：`java21-browserjdk-compat-v2`。结论：A–L 12/12 PASS，P0 A–H 8/8 PASS。

| ID | 检查 | 实测结果 |
|---|---|---|
| A | static primitive | 三次均输出 `1` |
| B | static collection | 两次均输出 size `1` |
| C | fresh System.in | 相同 bytecode 分别输出 `one`、`two` |
| D/E | fresh stdout/stderr | 每轮独立捕获，无前轮残留 |
| F | exception recovery | `IllegalStateException` 后下一轮输出 `ALIVE` |
| G/H | same/different source | 连续运行输出正确且互不污染 |
| I | ClassLoader identity | cache hit 的 identity 分别为 `1811151`、`4732460` |
| J | System properties | `MUTATED` 后下一轮恢复为 `ABSENT` |
| K | Locale | `fr-FR` 后恢复 baseline `en-US` |
| L | TimeZone | `UTC` 后恢复 baseline `GMT` |

恢复策略：run 前 snapshot `System.getProperties()`、default Locale 与 default TimeZone；finally 中恢复。stdin/stdout/stderr 也在 finally 中恢复。Thread/Executor/ForkJoin 仍为 P1 unsupported，不在本门禁内。

机器证据：`compat-tests/java21/isolation/isolation-results.json`。
