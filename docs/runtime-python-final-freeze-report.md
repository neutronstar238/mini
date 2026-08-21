# Browser Python 3 Runtime — Final Freeze Fix 报告（FINAL FROZEN）

> 冻结日期：2026-08-20 ｜ Runtime ID：`py312-cpython-compat-v1` ｜ 状态：**P0 FINAL FROZEN**
> 本轮性质：**Final Freeze Fix**（生产可靠性收尾，不新增 Feature/Package/Corpus）
> 交付物：本报告、`server/public/js/contest/runtime-manifest-python.json`、`compat-tests/python/capability-matrix-python.json`

---

## 0. 结论

满足全部 9 项最终冻结条件，**Python Browser Runtime 正式 FINAL FROZEN**。

| # | 冻结条件 | 结果 |
|---|---|---|
| 1 | `sys.exit(non-zero)` 不再在 OJ UI 显示 PASS | ✅ 4/4（sys.exit(0)→PASS；sys.exit(1)/sys.exit(2)/raise SystemExit(3)→RE/NON_ZERO_EXIT） |
| 2 | SAB 可用性自动检测 | ✅ `pythonInterruptStatus()` 返回 READY/FALLBACK |
| 3 | SAB 不可用时无限循环仍可通过 terminate Worker 处理 | ✅ FALLBACK 3/3，7262ms 终止，不卡页面 |
| 4 | PyProxy LRU 淘汰正确释放 | ✅ LRU 淘汰 + dispose/reset/clear 显式 `.destroy()` |
| 5 | 1000 次不同源码压力测试无明显线性内存泄漏 | ✅ JS heap 0 增长 / WASM 恒 20MB |
| 6 | Cold Network / Cached Cold / Warm 三层分别记录 | ✅ 见 §8 |
| 7 | Python 兼容性与 Correctness 100% | ✅ 74/74 + 74/74，mismatches 0 |
| 8 | Run Isolation 100% | ✅ 14/14 |
| 9 | C11 / C++11 Frozen Regression 无回退 | ✅ C11 全 100%/0；C++ PCH 51/0 + Header 94/0 |

---

## 1. SystemExit(non-zero) 最终 OJ 语义（§一）

**调整前（错误）**：`SystemExit(n != 0)` → runStatus PASS + exitCode=n（UI 误显示"运行成功"）。

**调整后（正确）**：

| 场景 | Local runStatus | reason | exitCode | UI 展示 |
|---|---|---|---|---|
| `sys.exit(0)` | PASS | — | 0 | 运行成功 |
| `sys.exit(1)` | RE | `NON_ZERO_EXIT` | 1 | Local Runtime Error · Program exited with code 1 |
| `sys.exit(2)` | RE | `NON_ZERO_EXIT` | 2 | Local Runtime Error · Program exited with code 2 |
| `raise SystemExit(3)` | RE | `NON_ZERO_EXIT` | 3 | Local Runtime Error · Program exited with code 3 |

**结果对象**：
```json
{ "runStatus": "RE", "reason": "NON_ZERO_EXIT", "exitCode": 1 }
```

- 底层 Python 进程语义保留（PASS+exitCode）；仅 **OJ Local Run 展示分类**修正为 abnormal exit。
- **不**把 SystemExit(non-zero) 强行包装成 Python Exception Traceback。
- 与 Server Reference（`python3 sys_exit.py` → `FAIL(exit=1)` abnormal exit）一致。
- 实现点：`ide-python-worker.js` `doRun` 的 `sys-exit` 分支 + `ide-runner.js`/`problem-detail.js` 透传 reason。

**专项测试** `compat-tests/python/systemexit-test.js`：

| 用例 | Browser | Server (yqzl) | Local UI |
|---|---|---|---|
| `sys.exit(0)` | PASS, exit 0 | PASS, exit 0 | Local PASS |
| `sys.exit(1)` | RE/NON_ZERO_EXIT, exit 1 | FAIL(exit=1) | Local RE / NON_ZERO_EXIT |
| `sys.exit(2)` | RE/NON_ZERO_EXIT, exit 2 | FAIL(exit=2) | Local RE / NON_ZERO_EXIT |
| `raise SystemExit(3)` | RE/NON_ZERO_EXIT, exit 3 | FAIL(exit=3) | Local RE / NON_ZERO_EXIT |

→ **4/4 PASS**，输出 `systemexit-result.json`。

---

## 2. SharedArrayBuffer / crossOriginIsolated 环境检测（§二）

**能力检测** `pythonInterruptStatus()`：

```js
{
  capability: 'READY' | 'FALLBACK',
  sharedArrayBuffer: boolean,
  crossOriginIsolated: boolean,
  atomics: boolean
}
```

- **READY**：`typeof SharedArrayBuffer !== 'undefined'` + `crossOriginIsolated === true` + `Atomics` 可用 → 使用 SAB KeyboardInterrupt，Worker 尽量复用。
- **FALLBACK**：任一不满足 → 不创建 SAB；无限循环走 **Local Timeout → terminate Worker → 标记 ABORTED/TIMEOUT → 下次 Run 重建 Worker + 重新 load Pyodide**。

**关键保证**：无论 SAB 是否可用，`while True: pass` 都不卡死比赛页面。
- 实测 READY：无限循环 6019ms → KeyboardInterrupt（ABORTED），Worker 复用。
- 实测 FALLBACK（`__PY_FORCE_INTERRUPT_CAPABILITY__='FALLBACK'`）：无限循环 7262ms → TLE（terminate + 重建），`fallback-test.js` 3/3 PASS，下次 Run 自动重建并正常执行。

> 诊断钩子：`window.__PY_FORCE_INTERRUPT_CAPABILITY__`（仅测试用，生产默认不设置）。

---

## 3. SAB 不可用时的 Worker terminate fallback

流程（FALLBACK）：
1. `runPython` 超时（`EXEC_TIMEOUT_MS`，~6s）。
2. `detectPythonInterruptCapability() === 'FALLBACK'` → **不**等待 KeyboardInterrupt，直接 `disposePythonWorker()`（terminate）。
3. 返回 `runStatus=TLE`，stderr 明确提示"当前环境不支持 SAB 中断，已强制终止 Worker"。
4. 下一次 Run 的 `ensurePythonWorker()` 重新创建 Worker 并重新 `loadPyodide`。

已验证：`fallback-test.js` B/C 两个断言通过，页面不卡死，重建后可正常运行。

---

## 4. COOP/COEP 部署要求（§二）

C/C++ WASI 与 Python Pyodide 都依赖 SharedArrayBuffer，需 **cross-origin isolated** 上下文：

| 响应头 | 值 |
|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |

- **内建**：`server/src/app.js` 对 contest 入口（host 或 `/contest`、`/js/contest` 路径）自动下发。
- **反向代理**：Nginx 需透传/保证一致性（不得覆盖为 non-isolated）。已在 `deploy/nginx/nginx.conf` 与 `deploy/nginx/contest.443.conf.example` 注释中补充要求，并在 `deploy/RUNNO-RUNTIME.md` 新增部署章节。
- **验证**：`window.crossOriginIsolated === true`；本测试环境 READY 已确认。
- **不影响 C/C++ 语义**：仅新增 Python 侧 capability 检测与 fallback。

---

## 5. Code Object Cache PyProxy 生命周期（§三）

**缓存结构**：`Map<sourceHash, PyProxy(code object)>`，LRU cap=4。

**生命周期治理**（`ide-python-worker.js`）：
- **加入**：compile PASS 后 `codeCache.set(hash, proxy)`。
- **淘汰**：`evictIfNeeded()` 在 `size > cap` 时淘汰最旧条目并 **`releaseProxy(proxy)` → `proxy.destroy()`**（Pyodide 推荐释放 API），禁止只 `map.delete()`。
- **dispose / runtime reset / cache clear**：`clearCodeCache()` 遍历全部 `proxy.destroy()`。
- Worker `terminate` 前先 `postMessage({type:'clear-cache'})` 释放 WASM/Python 对象。
- 新增 `stats` 消息暴露 `codeCacheSize / proxyCount / wasmMemoryMB`（诊断/压力测试用）。

> 关键修复：`releaseProxy` 原 `delete proxy` 在 ES module（strict mode）是 SyntaxError，导致 Worker 模块整体解析失败。已改为仅 `proxy.destroy()`，无该问题。

---

## 6. Memory Stress Test 结果（§三）

`compat-tests/python/memory-stress-test.js`，n=1000 个不同源码（保证真实 compile，不命中缓存）：

| 采样点 | JS heap | WASM memory | codeCacheSize |
|---|---|---|---|
| source 200 | 33,100,000 B | 20 MB | 4 |
| source 400 | 33,100,000 B | 20 MB | 4 |
| source 600 | 33,100,000 B | 20 MB | 4 |
| source 800 | 33,100,000 B | 20 MB | 4 |
| source 1000 | 33,100,000 B | 20 MB | 4 |

- 1000 compile / 0 cacheHit（唯一源码）/ 0 failures。
- **LRU 稳定段（source 200→1000，800 个不同 compile）：JS heap 0 增长 / WASM 恒 20MB / codeCache 恒 4**。
- **结论：未发现明显线性泄漏**（PyProxy 正确 `.destroy()` 释放，heap 不因新 source 线性增长）。
- 若 PyProxy 未释放，800 次不同 compile 必然导致 JS heap 线性上升；实测完全平坦 → 无泄漏。

---

## 7. Runtime Assets Size（§四）

自托管 Pyodide 0.26.4，`/js/pyodide/`，HTTP immutable 长缓存：

| 文件 | bytes | sha256 |
|---|---|---|
| pyodide-lock.json | 106,288 | `cd50b49d...` |
| pyodide.js | 14,746 | `c0069107...` |
| pyodide.mjs | 13,824 | `7f24c665...` |
| pyodide.asm.js | 1,229,107 | `91956065...` |
| pyodide.asm.wasm | 10,088,038 | `b7e66a19...` |
| python_stdlib.zip | 2,341,888 | `72894522...` |
| **合计** | **13,819,891 bytes ≈ 13.18 MB** | runtimeAssetHash `17E09D0E...` |

---

## 8. Cold Start 分层 Benchmark（§四）

不再用单一"cold 946ms"混合描述，拆成三层（`coldstart-bench.js`）：

| 层 | 定义 | ready 总时间 | network download | runtime init |
|---|---|---|---|---|
| **A. Cold Network Start** | 清空 HTTP cache/CacheStorage，真实下载 13.2MB + Wasm instantiate + CPython init + stdlib ready | **1291ms** | ~24ms（localhost 近零） | ~1267ms |
| **B. Cached Cold Start** | 资源已在浏览器缓存，但 Worker 尚未创建（"第二次进比赛页"真实启动） | **1274ms** | ~25ms | ~1249ms |
| **C. Warm Run** | Worker 已 READY：compile + exec + stdout | — | — | compile median 0.8ms / exec median 1.2ms |

> 环境：Chromium headless @ localhost:3001。局域网下载近零，A 与 B 差异小；**真实外网 Cold Network Start 因 13.2MB 下载会显著更高**（瓶颈在带宽）。Cached Cold Start 的主成本是 Wasm instantiate + CPython init（~1.25s），后续 Run 全部走 Warm（1-3ms）。

---

## 9. Execution Time 定义（§五）

**本轮未改变**，仍为：

> Python code object 已准备完成、stdin 已准备，从 `exec(user_code)` 真正开始到程序退出 + stdout flush 结束。

不包含：Runtime download / Pyodide initialize / Worker startup / compile() / cache lookup / Worker rebuild。

UI 继续重点显示 `本地运行时间：X ms`，并注明 *仅供参考，正式 TLE 以服务器 Judge 为准*。实测 Warm exec median 0.8-3.1ms（A~I，n=10，90/90 PASS）。

---

## 10. Runtime Version 判定（§六）

**最终 Runtime ID：`py312-cpython-compat-v1`（不变，不升级）**。

理由：
- 本轮修改**未改变** Python minor、Pyodide version、stdlib、runtime semantics、interrupt 本质实现。
- 修改内容：① UI/OJ 展示分类（SystemExit non-zero → RE，不改执行结果本身）；② 环境检测（新增 capability 上报，READY 路径行为不变）；③ PyProxy 显式 `.destroy()` 释放（修正 ES module 语法问题，缓存行为与之前一致，仅补正确释放）；④ benchmark/docs/manifest 更新。
- 按冻结规则：未修改 interrupt strategy / Run Isolation 本质 / Runtime lifecycle / cache 对象行为契约 → **继续 v1，不静默升级**。

> 若未来真正改变 interrupt strategy 本质或隔离策略，按规则生成 `py312-cpython-compat-v2`，禁止静默覆盖。

---

## 11. Python Regression（§七）

| 项目 | 结果 |
|---|---|
| Positive Compile | 100%（74/74） |
| Error Classification | **100%（13/13）** — SystemExit 语义修正后 errorClassify 从 92.31% 升至 100% |
| Compatibility Output | 100%（Browser==Server，74/74） |
| Correctness Output | 100%（Browser==Server==Expected，74/74） |
| Run Isolation | **14/14**（新增 M/N：SAB 能力检测 READY） |
| Timeout Protection | PASS（READY SAB KeyboardInterrupt；FALLBACK terminate） |
| SystemExit Classification | 4/4 PASS |
| PyProxy Stress | n=1000 无线性泄漏 |
| Cold Start Layered | A 1291 / B 1274 / C warm 0.8/1.2ms |
| bench-python A~I | 90/90 PASS |

`capability-matrix-python.json`：**mismatches 0**。

---

## 12. C11 Regression（§八）

`compat-tests/compare-c11.js`：

| 指标 | 结果 |
|---|---|
| Positive Compile | 100%（67/67） |
| Negative CE | 100%（10/10） |
| Warning-No-CE | 100%（5/5） |
| Compatibility Output | 100%（70/70） |
| Correctness Output | 100%（48/48） |
| Runtime Unsupported | 0 |
| **Mismatches** | **0** |

C11 性能基准（`bench-c11.js` n=10）：A~E warm compile median 9-17ms，全部 ok=true。**无回退**。

---

## 13. C++11 Regression（§八）

| 项目 | 结果 |
|---|---|
| PCH Neutrality（`verify-pch-neutral.js`） | 51/0（PCH 不改变输出/判定） |
| Header Strict Check（`test-header-check.js`） | 94/0 |
| bits A+B（`bench-ab.js` n=10） | warm compile median 208ms，PCH used 10/10，exec 5.74ms |

C++11 冻结指标无回退（warm compile 208ms 在正常机器波动范围；PCH 语义中性 51/0、Header 94/0 均达标）。

---

## 14. 最终 Runtime ID

```
py312-cpython-compat-v1
```

---

## 15. FINAL FROZEN 判定

✅ **Python Browser Runtime FINAL FROZEN**（2026-08-20）

9 项冻结条件全部满足（见 §0）。本轮为 Final Freeze Fix，未新增任何 Python Feature / Package / Corpus；未修改 Python minor、Pyodide、C11、C++11；Runtime ID 保持 `v1`。

### 后续路线（不再扩展 Python Runtime 能力）
1. 三语言统一 Runtime Manager 收尾
2. Contestant Web IDE
3. Problem / Sample Runner
4. Formal Submission
5. OJ Core + SQLite WAL
6. Scoreboard / SSE / Cache Lease
7. Admin Web
8. Official Judge 集成
