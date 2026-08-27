# Browser Python 3 Runtime — 能力报告（FINAL FROZEN）

> 冻结日期：2026-08-20 ｜ Runtime ID：`py312-cpython-compat-v1` ｜ 状态：**P0 FROZEN**
> 测试数据机器生成：`compat-tests/python/capability-matrix-python.json`（87 例）
> 元数据：`server/public/js/contest/runtime-manifest-python.json`、`compat-tests/python/reference-python.json`

## 1. Final Runtime ID

```
py312-cpython-compat-v1
```

版本实测冻结（先实测后冻结，不凭印象）：
- **Browser**：CPython 3.12.1（Pyodide 0.26.4 WebAssembly，`sys.version_info(major=3, minor=12, micro=1, releaselevel='final', serial=0)`）
- **Server**：CPython 3.12.3（Ubuntu 24.04 LTS 参考环境，`python3 --version` = `Python 3.12.3`）
- 两端口径：minor 3.12 完全对齐；micro 差异（1 vs 3）经 87 例三方比对确认无行为差异

## 2. 测试规模（机器生成）

| 目录 | 数量 | 说明 |
|---|---|---|
| `features/` | 34 | positive：stdin 五种读法、int/str/list/dict/set/tuple、math/collections/heapq/bisect/itertools/functools/operator/random/re/string/decimal/fractions/copy/typing/statistics/dataclasses、异常处理、大整数、浮点、Unicode、bytes、struct、多行输出 |
| `errors/` | 13 | negative：SyntaxError / IndentationError / TabError（CE 家族）+ NameError / ZeroDivisionError / IndexError / KeyError / ValueError / TypeError / RecursionError / AssertionError / ImportError（RE 家族）+ SystemExit |
| `acm-corpus/` | 40 | 真实 Python ACM 程序：A+B、快速 IO、二分、前缀和、差分、KMP、并查集、Fenwick、线段树、快速幂、矩阵快速幂、素数筛、GCD/LCM、模逆元、拓扑排序、Dijkstra、Trie、Kruskal、Floyd、LCS、LIS、SCC、数位 DP、区间合并、位运算、大整数、0-1 BFS、频率统计、bisect、递归树、`sys.stdin.buffer` 大输入（10000 元素）等 |
| **合计** | **87** | positive 74 + errors 13 |

## 3. Server Reference（冻结）

```bash
# 编译检查（CE 家族判定）
python3 -m py_compile <src>.py
# 运行（CPython，非 PyPy）
python3 <src>.py < <in>
```

- SSH：通过环境变量配置的参考主机（Ubuntu 24.04 LTS）
- 版本行：`Python 3.12.3 (main, Mar 23 2026, 19:04:32) [GCC 13.3.0]`

## 4. Browser Runtime（冻结）

| 项 | 值 |
|---|---|
| Runtime | Pyodide 0.26.4（CPython WebAssembly，self-host `/js/pyodide/`） |
| Python | 3.12.1，stdlib = `python_stdlib.zip`（Pyodide bundled） |
| WASM | `emscripten_3_1_58, abi 2024_0, wasm32` |
| 包范围 | P0 仅 CPython Core + Standard Library；numpy/scipy/pandas/matplotlib/sklearn 不加载（P1） |
| 中断 | `setInterruptBuffer(Int32Array SAB)` → KeyboardInterrupt |
| 隔离 | P0 Reset Strategy（见 §10） |

## 5. Persistent Worker 架构

- Dedicated Web Worker（`ide-python-worker.js`，type: module），**懒加载**：首次选 Python 或 `prewarm('python')` 才初始化
- 生命周期：`new Worker → loadPyodide(indexURL) → 加载 stdlib → 状态 READY → 常驻`
- UI 状态机：`Loading… → Preparing… → Ready`（`#runtime-status` 标签，`onPythonStatus` 回调）
- 初始化失败可恢复：下次 Run 自动重建
- 消息协议：`init→inited`、`run→run-result`、`ping→pong`（保活）

## 6. stdin 高度兼容 OJ（实测）

Bootstrap 以 `BytesIO(stdin_bytes)` 构造 `sys.stdin`（`TextIOWrapper(..., encoding='utf-8')`），**五种读法全部可用**：

- `input()`（CPython 非 tty 时回退 `sys.stdin.readline()`）
- `sys.stdin.readline()`
- `sys.stdin.read() / readlines()`
- `sys.stdin.buffer.readline() / read()`
- 换 stdin 不需要重新编译（code object 缓存命中，仅重放 stdin）

覆盖用例：`features/01_basic_io`、`features/02_fast_io`、`features/03_buffer_io`、`features/04_string`、`acm-corpus/40_fast_input_large`（10000 元素 `sys.stdin.buffer` 大输入）等。

## 7. CE / RE 分类（实测一致）

| 阶段 | 判定 | 结果 |
|---|---|---|
| `compile(source, '<submission>', 'exec')` | SyntaxError / IndentationError / TabError | **Local CE**（含行号，进 stderr） |
| `exec(code, fresh_globals)` | 运行时异常 | **Local RE**（完整 Traceback 进 stderr，`tracebackClass` 上报） |
| `SystemExit(0)` | 正常退出 | runStatus PASS，exitCode 0 |
| `SystemExit(n)` | 按退出码退出 | runStatus PASS，exitCode n（与 Server exit code 语义对齐） |

Errors 13 例分类匹配 **13/13（100%）**，RE 例的异常类型（NameError/ZeroDivisionError/…/ModuleNotFoundError）双端与 `# error:` 预期完全一致。

## 8. Compile Once, Run Many

- `sourceHash`（sha256）→ code object（PyProxy）缓存，cap ≈ 4（LRU 淘汰）
- 缓存键：`language | runtimeId | pythonVersion | sourceHash`
- 实测（isolation-test J）：同源码第二次运行 `cacheHit=true`、`compileStatus=SKIP`、stdout 一致
- 换 stdin 不重复编译：编译时间从 0.6ms 降至 0

## 9. 计时分离（Execution Time 定义）

- `coldLoad`：主线程创建 Worker → READY（含 pyodide wasm 下载 + CPython 初始化），**不计入运行时间**
- `compileTime`：Worker 内 `compile()` 墙钟
- `executionTime`：Worker 内 `exec()` 墙钟（含 stdout flush）
- UI 提示：`本地运行时间：X ms（仅供参考，正式 TLE 以服务器为准）`——Local Timeout 仅本地保护，不是正式 TLE

实测：cold 946ms 仅首次；warm 每次总耗时 3-6ms。

## 10. P0 Reset Strategy（Run Isolation 实测 12/12 PASS）

每次 Run 模拟新 Python 进程，JS 侧 + Python bootstrap 双保险：

| # | 污染面 | 验证（probe 断言） |
|---|---|---|
| A | fresh globals（`x=42` 不残留） | `'x' in dir()` → False |
| B | `sys.modules` 清理（动态注入模块删除） | `'leak_mod_xyz' in sys.modules` → False |
| C | `builtins` 恢复（print 覆盖还原） | `print('visible')` 正常输出 |
| D | `random` 重播种（消耗 100 个随机数后 seed 还原） | `seed(7)` 首值 = 0.32383276483316237 |
| E | `sys.setrecursionlimit(50)` 恢复 | `getrecursionlimit()` → 1000 |
| F | `sys.argv` / `os.chdir('/')` 恢复 | `argv[0] != 'hacked'`、`cwd != '/'` |
| G | stdin/stdout/stderr 重建 | run2 输出仅含 run2 内容，stdin 为新值 |
| H | `__name__ == '__main__'` | True |
| I | `sys.path` 恢复（`/leakpath` 不残留） | False |
| J | code object 缓存（同源码） | 第二次 SKIP + cacheHit |
| K | 无限循环中断 | 6002ms SAB interrupt → KeyboardInterrupt |
| L | 中断后 Worker 复用 | `print('alive')` 正常 |

## 11. Timeout / 无限循环保护（实测）

- 默认本地保护：`EXEC_TIMEOUT_MS = 6000ms`（本地调试保护，非正式 TLE）
- 流程：超时 → `Atomics.store(interruptBuf, 0, 2)`（SAB interrupt）→ KeyboardInterrupt 生效 → runStatus ABORTED（含 Traceback）
- grace 窗口 `PY_INTERRUPT_GRACE_MS = 800ms` 后仍无响应 → `terminate()` + 下次 Run 重建 Worker
- 实测：无限循环 6002ms 内中断，Worker 不复位继续服务；页面不卡死

## 12. 三方位 Correctness（Deterministic 100%）

- 74 例 positive（features 34 + acm-corpus 40）**全部确定性**
- 比对：`Browser stdout == Server CPython stdout == Expected`（`# expected:` 注释协议）
- **74/74（100%）**，mismatches = 0
- 非确定性输出（依赖 hash 随机化的 set/dict 迭代序）单独分类，不进入 Deterministic 统计

## 13. 兼容性 Runtime Output（Browser==Server 100%）

- 双端都 run=PASS 的 74 例：stdout **74/74（100%）** 逐字节一致（`normalizeOut` 仅去行尾空白）
- 快速 IO 大输入（10000 元素 `sys.stdin.buffer`）双端一致

## 14. Positive Compile Match（100%）

- Server `py_compile` PASS 的 74 例 → Browser compile 全部 PASS（74/74，100%）
- 无"Server 能跑、Browser 不能"的正向用例

## 15. Errors 分类 Match（100%）

| 类型 | 数量 | 双端行为 |
|---|---|---|
| CE 家族（Syntax/Indentation/Tab） | 3 | 双端均在编译阶段失败 |
| RE 家族（9 类运行时异常） | 9 | 双端均运行失败，异常类型一致 |
| SystemExit | 1 | 双端 exit code 语义一致（Server exit≠0，Browser runStatus PASS + exitCode≠0） |
| **合计** | **13/13（100%）** | |

## 16. 性能 Benchmark（bench-python.js，n=10，median/p90）

| 类别 | compile med/p90 | exec med/p90 | total med/p90 |
|---|---|---|---|
| A A+B（input/int） | 0.6 / 0.6 ms | 1.1 / 1.3 ms | 4 / 5 ms |
| B 计算密集 fib(30) 迭代 | 0.6 / 0.8 ms | 0.9 / 1.2 ms | 4 / 5 ms |
| C 字符串/正则 | 0.6 / 0.9 ms | 1.6 / 1.9 ms | 5 / 5 ms |
| D 数据结构 list/dict 5000 操作 | 0.6 / 0.7 ms | 2.3 / 2.5 ms | 5 / 6 ms |
| E 标准库 math/collections/itertools | 0.5 / 0.6 ms | 0.9 / 1.0 ms | 3.5 / 4 ms |
| F 无 stdin 纯输出 | 0.5 / 0.5 ms | 0.8 / 0.9 ms | 3 / 4 ms |
| G 大整数 2^1000 / 2^10000 | 0.5 / 0.5 ms | 1.0 / 1.0 ms | 4 / 4 ms |
| H 递归 fib(20) | 0.5 / 0.6 ms | 1.7 / 1.9 ms | 4 / 5 ms |
| I `sys.stdin.buffer` 1000 行大 stdin | 0.6 / 0.7 ms | 1.2 / 1.3 ms | 4 / 5 ms |

- **cold runtime load（pyodide 初始化，仅首次）**：946.4 ms
- warm 90/90 次运行全部 PASS/PASS
- 编译在 Worker 内完成，零 IPC 计时区间；executionTime 不含 cold load 与 compile

## 17. 资产与缓存（self-host）

| 资产 | bytes | sha256（前 16 位） |
|---|---|---|
| pyodide-lock.json | 106,288 | cd50b49de944c579 |
| pyodide.js | 14,746 | c0069107621d5b94 |
| pyodide.mjs | 13,824 | 7f24c6655a79eacf |
| pyodide.asm.js | 1,229,107 | 919560652ed3dad3 |
| pyodide.asm.wasm | 10,088,038 | b7e66a19427a5501 |
| python_stdlib.zip | 2,341,888 | 72894522b791858b |
| **合计** | **13,819,891（~13.2MB）** | `runtimeAssetHash = 17E09D0E…B38922B` |

- HTTP immutable 长缓存（`app.js` `/js/pyodide/` 分支，与 `/js/runno/` 同款策略）
- `wasmRuntimeHash = b7e66a19…`、`stdlibHash = 72894522…`（完整见 manifest）

## 18. Known Divergences（冻结）

| 类别 | 说明 |
|---|---|
| 版本 micro | Browser 3.12.1 vs Server 3.12.3（同 minor 3.12，87 例实测无差异） |
| hash 随机化 | 两端默认随机；依赖 set/dict 迭代序的输出属非确定性，单独分类 |
| P1（不承诺） | numpy/scipy/pandas/matplotlib/sklearn；pip/socket/subprocess/multiprocessing；模块级持久状态（P0 Reset 已覆盖主要污染面，12/12 断言无残留） |

## 19. 集成点（C/C++ 冻结路径零改动）

- `ide-runner.js`：新增 `runCode({language, source, stdin})` 统一分发；`python/python3 → runPython`（Python Worker 客户端），`c/cpp → runC`（现有 Clang/WASI 管线，**零改动**）
- `runPython` 保留为兼容薄封装（现有 compat 脚本依赖）；`runC` 签名与行为不变
- `problem-detail.js`：`runIde` 改走 `runCode`；Python 输出附加"本地时间仅供参考"提示；状态标签 Loading/Preparing/Ready
- `app.js`：仅新增 `/js/pyodide/` immutable 缓存分支
- 日志风格复用 `console.debug('[ide-runner] …')`；错误信息含阶段标注（compile/exec/crash/timeout），不打印用户源码与 stdin

## 20. Runtime Manifest / Hash（冻结）

- `server/public/js/contest/runtime-manifest-python.json`：`status = "P0 FROZEN"`、`frozenAt = 2026-08-20`、全部 verified 字段已填、performanceBaseline 已填
- `runtimeAssetHash = 17E09D0EF8C89EF403F8DB7F34AACFE323A271D624F6CF1C4C9D1CB43B38922B`
- 升级规则：runtimeId 内任一组件改变（Python minor / Pyodide / stdlib / flags / isolation / interrupt）必须生成新 Runtime Version，禁止静默覆盖

## 21. C11 / C++11 Frozen Regression（无回退）

见最终验收 §"回归确认"：复跑 C11（`verify-pch-neutral`、`test-header-check`）与 C++ bits warm compile benchmark，全部 PASS、无回退。

## 最终验收

| 验收项 | 结果 |
|---|---|
| Browser/Server minor 版本匹配 | 3.12 == 3.12 ✅ |
| Positive Compile Match | 100%（74/74）✅ |
| Errors 分类 Match | 100%（13/13）✅ |
| Compatibility Runtime Output | 100%（74/74）✅ |
| Correctness 三方 Output | 100%（74/74）✅ |
| Run Isolation | 12/12 PASS ✅ |
| 无限循环中断 / 复用 | 6002ms KeyboardInterrupt，Worker 复用 ✅ |
| Bench n=10 | 90/90 PASS，warm total 3-6ms ✅ |
| C11/C++11 回归 | PASS，无回退 ✅ |
| 禁止加载科学计算包 | P0 仅 CPython Core + stdlib ✅ |

**P0 FROZEN — `py312-cpython-compat-v1`（2026-08-20）**
