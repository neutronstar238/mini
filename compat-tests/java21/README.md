# Java 21 Compatibility Matrix（compat-tests/java21）

> 状态：PoC 通过（java-browser-poc/SELECTION-REPORT.md）；Java 21 Browser Local = Experimental。
> 本矩阵针对 **Official Judge**（服务器 OpenJDK 21）验证，不针对 Browser Local（Local 已标记 UNAVAILABLE）。

## 目录结构

```
compat-tests/java21/
├── README.md                 # 本文件
├── run-server.js             # Official Judge 端测试运行器（spawn javac → java）
├── compare.js                # 结果对比（output vs expected）
├── corpus/                   # 30+ ACM 测试用例
│   ├── 01_a_plus_b/
│   ├── 02_fast_io/
│   ├── 03_sort/
│   ...
│   └── 30_scc/
└── results/                  # 运行结果（git ignored）
```

## 测试设计

每个 corpus 用例结构：

```
corpus/<id>/
├── Main.java                 # 用户代码（标准 ACM 模板）
├── input.txt                 # 公开测试输入
├── expected.txt              # 期望输出
└── meta.json                 # { category, stdLibUsed, expectedVerdict }
```

## 30+ ACM Corpus 覆盖

| 类别 | 用例 ID | 名称 | Java 标准库要点 |
|---|---|---|---|
| Fast IO | 01_a_plus_b | A+B (Scanner) | java.util.Scanner |
| Fast IO | 02_fast_io | FastScanner (BufferedInputStream) | java.io.BufferedInputStream |
| Sort | 03_sort | Arrays.sort int | Arrays.sort |
| Sort | 04_collections_sort | Collections.sort List | java.util.Collections |
| Binary Search | 05_binary_search | int[] 经典实现 | 数组 |
| Prefix Sum | 06_prefix_sum | int[] prefix | 数组 |
| BFS | 07_bfs | 图遍历（ArrayDeque） | javaArrayDeque, HashMap |
| DFS | 08_dfs | 递归遍历 | recursion |
| Dijkstra | 09_dijkstra | PriorityQueue + HashMap | java.util.PriorityQueue |
| Floyd | 10_floyd | 三重循环 | 数组 |
| Union Find | 11_union_find | int[] parent | 数组 |
| Kruskal | 12_kruskal | PriorityQueue 边 | PQ |
| Trie | 13_trie | Node[] 子节点 | HashMap / array |
| KMP | 14_kmp | next[] 部分匹配表 | char[] |
| PriorityQueue | 15_priority_queue | 默认小顶堆 | PQ |
| 01 Knapsack | 16_knapsack_01 | DP | int[] |
| LIS | 17_lis | O(n log n) 二分 | ArrayList |
| LCS | 18_lcs | DP | 2D 数组 |
| Fenwick | 19_fenwick | int[] BIT | 数组 |
| Segment Tree | 20_segment_tree | int[] 4N | 数组 |
| Fast Pow | 21_fast_pow | long 矩阵快幂 | long |
| BigInteger | 22_big_integer | BigInteger 大数 | BigInteger |
| Topo Sort | 23_topo_sort | Kahn 算法 | ArrayDeque, indegree[] |
| SCC | 24_scc | Tarjan | ArrayList, 递归 |
| BufferedReader | 25_buffered_reader | BufferedReader + StringTokenizer | BufferedReader |
| PrintWriter | 26_print_writer | 大输出缓冲 | PrintWriter |
| Unicode | 27_unicode | 中英文混合输出 | Charset, String |
| CE | 28_ce_undeclared | 编译错误（缺分号） | (预期 CE) |
| RE | 29_re_div_zero | 1/0 ArithmeticException | (预期 RE) |
| TLE | 30_tle_infinite_loop | while(true) | (预期 TLE，需超时) |

## 运行方式

```powershell
cd compat-tests/java21
# 单独跑一个用例
node run-server.js --case 01_a_plus_b
# 跑全部
node run-server.js --all
```

## 结果记录

- Official Judge 期望：30 个用例全部 PASS（含 CE/RE/TLE 预期命中）
- Browser Local：当前不参与对比（runtime UNAVAILABLE）
- 记录在 `results/<timestamp>-server.json`