# Java 21 ACM Corpus Results

Runtime：`java21-browserjdk-compat-v2`。Server baseline：Docker image `browserjdk-oj-build:emsdk-5.0.2` 内 OpenJDK `21.0.10+7-LTS`。

结论：38/38 deterministic positive cases 与 8/8 error cases 全部通过。

| Score | Result |
|---|---:|
| Positive Compile Match | 38/38 |
| Compatibility Runtime Match | 38/38 |
| Correctness Runtime Match | 38/38 |
| Server Correctness | 38/38 |
| Negative Compatibility | 8/8 |
| Negative Classification | 8/8 |

Positive corpus 覆盖 Scanner/BufferedReader/FastScanner、StringTokenizer/StringBuilder、Arrays/Collections/PriorityQueue/ArrayDeque/HashMap、BigInteger/BigDecimal，以及 sort、binary search、prefix/difference、BFS/DFS、Dijkstra/Floyd、DSU/Kruskal、KMP/Trie、knapsack、LIS/LCS、Fenwick/segment tree、fast/matrix pow、sieve、GCD/LCM、topological sort、SCC、bitmask、EOF 与 large input。

每个 positive case 都验证 `browserMatchesServer`、`browserMatchesExpected`、`serverMatchesExpected`。Error suite 为 3/3 CE（missing semicolon、illegal expression、type mismatch）及 5/5 RE（ArithmeticException、NullPointerException、ArrayIndexOutOfBoundsException、NumberFormatException、StackOverflowError）；只比较 verdict/exception class，不要求 diagnostic 或 stacktrace 逐字一致。

机器证据：`compat-tests/java21/results/java21-compatibility-matrix.json`。
