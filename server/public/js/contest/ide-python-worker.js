/* ============================================================
 * Python 3 Runtime —— Persistent Web Worker（Pyodide / CPython WASM）
 *
 * 角色：比赛页面 Local Run / Sample Run / Debug 专用 Python 解释器。
 *  - 页面生命周期内常驻：loadPyodide → 初始化 CPython → 加载 stdlib → READY，
 *    之后所有 Run 复用同一解释器（禁止每次 Run 重新加载 WASM）。
 *  - 懒加载：仅当页面首次选择 Python 或 prewarm('python') 时创建。
 *  - Compile Once, Run Many：sourceHash → code object（PyProxy）内存缓存。
 *  - Run Isolation（P0 Reset Strategy）：每次 Run 模拟"新 Python 进程"——
 *    fresh globals / stdin·out·err 重建 / sys.argv·path·recursionlimit·cwd 恢复 /
 *    清理新增 sys.modules 与 builtins 改动 / random 重播种。
 *  - CE/RE 分类：compile() 失败（SyntaxError 家族）→ Local CE；
 *    exec() 运行时异常 → Local RE + 完整 Traceback（进 stderr）。
 *  - Interrupt：setInterruptBuffer(SharedArrayBuffer)，主线程超时置 2 →
 *    KeyboardInterrupt；仍无响应则由主线程 terminate 并重建本 Worker。
 *
 * 计时（Worker 内零 IPC 打点）：
 *  - compileTime = compile() 生成 code object 的时间（缓存命中 ≈0）
 *  - executionTime = exec() 开始到程序结束并完成 stdout flush
 *  - resetMs / overhead 不计入运行时间
 *
 * 消息协议：
 *  主线程 → { type:'init', interruptBuffer }         → { type:'inited', initMs, pythonVersion }
 *  主线程 → { type:'run', sourceHash, source, stdin } → { type:'run-result', ... }
 *  主线程 → { type:'ping' }                          → { type:'pong' }
 * 任何未捕获异常 → { type:'error', message }
 * ============================================================ */

const PYODIDE_INDEX_URL = '/runtime/pyodide/0.26.4/';
const SUBMISSION_FILENAME = '<submission>';
const CODE_CACHE_MAX = 4;

let pyodide = null;
let interruptBuffer = null; // Int32Array(SharedArrayBuffer)
let ready = false;
const codeCache = new Map(); // sourceHash -> PyProxy(code object)

/* ---------------- codeCache LRU 辅助 ----------------
 * 放入时若超出上限，淘汰最旧条目并显式释放其 PyProxy（避免 WASM/Python 对象泄漏）。
 * 禁止只 map.delete(key) 而不 destroy() 对应 PyProxy。
 */
function evictIfNeeded() {
  while (codeCache.size > CODE_CACHE_MAX) {
    const oldestKey = codeCache.keys().next().value;
    const proxy = codeCache.get(oldestKey);
    codeCache.delete(oldestKey);
    releaseProxy(proxy);
  }
}
/* 释放 PyProxy：destroy()（Pyodide 推荐）。忽略二次释放/已释放的异常。
 * 注意：不可使用 `delete proxy`——在 ES module（strict mode）下对标识符 delete 是 SyntaxError，
 * 会致整个 Worker 模块解析失败；且对普通变量 delete 本就不生效。 */
function releaseProxy(proxy) {
  if (!proxy) return;
  if (typeof proxy.destroy === 'function') {
    try { proxy.destroy(); } catch (_) { /* ignore */ }
  }
}
/* 清空整个 codeCache 并释放全部 PyProxy（Worker dispose / runtime reset / cache clear 共用）。 */
function clearCodeCache() {
  for (const proxy of codeCache.values()) releaseProxy(proxy);
  codeCache.clear();
}

/* ---------------- Python 脚本常量 ----------------
 * 注意：Pyodide 的 runPython 共享同一组内部 globals（变量跨调用保留），
 * 我们约定所有内部变量以 _ 前缀命名，由 JS 侧每次覆盖，不混入用户 globals。
 */

/* 初始化快照（Worker 初始化时执行一次）：记录"干净进程"基线状态。 */
const SETUP_SCRIPT = `
import io, sys, builtins, os, random
sys.stdin = io.TextIOWrapper(io.BytesIO(), encoding='utf-8')
sys.stdout = io.TextIOWrapper(io.BytesIO(), encoding='utf-8', write_through=True)
sys.stderr = io.TextIOWrapper(io.BytesIO(), encoding='utf-8', write_through=True)
_INIT_STATE = {
    'argv': list(sys.argv),
    'path': list(sys.path),
    'recursionlimit': sys.getrecursionlimit(),
    'cwd': os.getcwd(),
    'module_keys': frozenset(sys.modules.keys()),
    'builtins_keys': frozenset(builtins.__dict__.keys()),
    'builtins_items': dict(builtins.__dict__),
}
'ok'
`;

/* P0 Reset（每次 Run 前执行）：把解释器状态恢复为接近新进程。 */
const RESET_SCRIPT = `
import io, sys, builtins, os, random
sys.stdin = io.TextIOWrapper(io.BytesIO(_stdin_bytes), encoding='utf-8')
class _CappedBytesIO(io.BytesIO):
    _limit = 1024 * 1024
    def __init__(self):
        super().__init__()
        self.truncated = False
    def write(self, value):
        remaining = self._limit - self.tell()
        if remaining <= 0:
            self.truncated = True
            return len(value)
        if len(value) > remaining:
            super().write(value[:remaining])
            self.truncated = True
            return len(value)
        return super().write(value)
_out = _CappedBytesIO()
_err = _CappedBytesIO()
sys.stdout = io.TextIOWrapper(_out, encoding='utf-8', write_through=True)
sys.stderr = io.TextIOWrapper(_err, encoding='utf-8', write_through=True)
sys.argv[:] = list(_INIT_STATE['argv'])
sys.path[:] = list(_INIT_STATE['path'])
sys.setrecursionlimit(_INIT_STATE['recursionlimit'])
try:
    os.chdir(_INIT_STATE['cwd'])
except Exception:
    pass
for _k in list(sys.modules.keys()):
    if _k not in _INIT_STATE['module_keys']:
        del sys.modules[_k]
for _k in list(builtins.__dict__.keys()):
    if _k not in _INIT_STATE['builtins_keys']:
        del builtins.__dict__[_k]
for _k, _v in _INIT_STATE['builtins_items'].items():
    if builtins.__dict__.get(_k) is not _v:
        builtins.__dict__[_k] = _v
try:
    random.seed()
except Exception:
    pass
'ok'
`;

/* 编译阶段：compile(source) → code object。失败（SyntaxError 家族等）→ Local CE。 */
const COMPILE_SCRIPT = `
import sys
try:
    _compiled = compile(_source, '<submission>', 'exec')
    _RESULT = {'status': 'ok'}
except BaseException as _e:
    import traceback
    sys.stderr.write(traceback.format_exc())
    _RESULT = {'status': 'ce', 'cls': type(_e).__name__, 'msg': str(_e)}
_RESULT
`;

/* 执行阶段：fresh globals + exec(code object)。运行时异常 → Local RE。 */
const EXEC_SCRIPT = `
import sys, traceback
_g = {'__name__': '__main__', '__file__': '<submission>', '__package__': None}
try:
    exec(_code_proxy, _g)
    _RESULT = {'status': 'ok'}
except SystemExit as _e:
    _c = _e.code
    if _c is None:
        _code_n = 0
    elif isinstance(_c, int):
        _code_n = _c
    else:
        sys.stderr.write(str(_c) + '\\n')
        _code_n = 1
    _RESULT = {'status': 'sys-exit', 'code': _code_n}
except KeyboardInterrupt:
    sys.stderr.write(traceback.format_exc())
    _RESULT = {'status': 'interrupted', 'cls': 'KeyboardInterrupt'}
except BaseException as _e:
    sys.stderr.write(traceback.format_exc())
    _RESULT = {'status': 're', 'cls': type(_e).__name__}
sys.stdout.flush()
sys.stderr.flush()
_RESULT
`;

function post(msg) {
  self.postMessage(msg);
}

/* ---------------- 初始化：loadPyodide → 快照 → READY ---------------- */
async function init(d) {
  const t0 = performance.now();
  const mod = await import(PYODIDE_INDEX_URL + 'pyodide.mjs');
  pyodide = await mod.loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  if (d.interruptBuffer && pyodide.setInterruptBuffer) {
    interruptBuffer = d.interruptBuffer;
    pyodide.setInterruptBuffer(interruptBuffer);
  }
  pyodide.runPython(SETUP_SCRIPT);
  ready = true;
  const pythonVersion = String(pyodide.runPython('import sys; sys.version.split(" ")[0]'));
  post({
    type: 'inited',
    initMs: Math.round((performance.now() - t0) * 10) / 10,
    pythonVersion: pythonVersion
  });
}

/* ---------------- 一次 Run：Reset → Compile(缓存) → Exec → 输出 ---------------- */
function doRun(d) {
  if (!pyodide || !ready) {
    return { status: 'not-ready', error: 'Python Runtime 未就绪' };
  }
  const source = String(d.source || '');
  const sourceHash = String(d.sourceHash || '');
  const stdin = String(d.stdin || '');

  const out = {
    status: 'ok', compileStatus: 'SKIP', runStatus: 'PASS',
    compileTime: 0, executionTime: 0, resetMs: 0, overheadMs: 0,
    stdout: '', stderr: '', exitCode: 0, cacheHit: false,
    ce: null, tracebackClass: null, reason: null
  };

  // —— P0 Reset（隔离，不计入运行时间） ——
  let t0 = performance.now();
  pyodide.globals.set('_stdin_bytes', pyodide.toPy(new TextEncoder().encode(stdin)));
  pyodide.runPython(RESET_SCRIPT);
  out.resetMs = Math.round((performance.now() - t0) * 10) / 10;

  // —— Compile（Compile Once, Run Many） ——
  let codeProxy = codeCache.get(sourceHash) || null;
  out.cacheHit = !!codeProxy;
  if (!codeProxy) {
    pyodide.globals.set('_source', source);
    t0 = performance.now();
    const res = pyodide.runPython(COMPILE_SCRIPT);
    out.compileTime = Math.round((performance.now() - t0) * 10) / 10;
    const st = String(res.get('status'));
    if (st === 'ok') {
      codeProxy = pyodide.globals.get('_compiled');
      if (codeProxy) {
        codeCache.set(sourceHash, codeProxy);
        evictIfNeeded(); // 超上限：淘汰最旧 + 显式 releaseProxy
      }
      out.compileStatus = 'PASS';
    } else {
      out.compileStatus = 'CE';
      out.status = 'ce';
      out.ce = { cls: String(res.get('cls') || 'SyntaxError'), msg: String(res.get('msg') || '') };
      out.tracebackClass = out.ce.cls;
      out.stdout = readBuffer('_out');
      out.stderr = readBuffer('_err');
      out.outputTruncated = bufferWasTruncated('_out') || bufferWasTruncated('_err');
      if (out.outputTruncated) out.stderr += '\n[本地输出超过 1 MiB，已截断]';
      out.exitCode = -1;
      res.destroy();
      pyodide.globals.delete('_source');
      return out;
    }
    res.destroy();
    pyodide.globals.delete('_source');
    pyodide.globals.delete('_compiled');
  }

  // —— Exec（Execution Time 主指标） ——
  // PyProxy 传回 Python 侧必须解引用为原始 code object
  pyodide.globals.set('_code_proxy', typeof codeProxy.toPython === 'function' ? codeProxy.toPython() : codeProxy);
  t0 = performance.now();
  let res;
  try {
    res = pyodide.runPython(EXEC_SCRIPT);
    out.executionTime = Math.round((performance.now() - t0) * 10) / 10;
    const st = String(res.get('status'));
    if (st === 'sys-exit') {
      out.status = 'sys-exit';
      out.exitCode = Number(res.get('code')) || 0;
      if (out.exitCode === 0) {
        // SystemExit(0)：OJ 语义 = 正常结束 → Local PASS, exitCode 0
        out.runStatus = 'PASS';
        out.reason = null;
      } else {
        // SystemExit(non-zero)：正式 Judge 视为 abnormal exit → Local RE / NON_ZERO_EXIT
        // 保留真实 exitCode，不强行包装成 Python Exception Traceback
        out.runStatus = 'RE';
        out.reason = 'NON_ZERO_EXIT';
      }
    } else if (st === 'interrupted') {
      out.status = 'interrupted';
      out.runStatus = 'ABORTED';
      out.tracebackClass = 'KeyboardInterrupt';
      out.exitCode = -1;
    } else if (st === 're') {
      out.status = 're';
      out.runStatus = 'RE';
      out.tracebackClass = String(res.get('cls') || 'Exception');
      out.exitCode = 1;
    } else {
      out.status = 'ok';
      out.runStatus = 'PASS';
      out.exitCode = 0;
    }
  } catch (e) {
    out.executionTime = Math.round((performance.now() - t0) * 10) / 10;
    out.status = 'crash';
    out.runStatus = 'ABORTED';
    out.error = 'Python exec 异常: ' + String(e && e.message || e);
    out.exitCode = -1;
  } finally {
    if (interruptBuffer) Atomics.store(interruptBuffer, 0, 0);
    pyodide.globals.delete('_code_proxy');
    try { if (res && res.destroy) res.destroy(); } catch (_) { /* ignore */ }
  }

  out.stdout = readBuffer('_out');
  out.stderr = readBuffer('_err');
  out.outputTruncated = bufferWasTruncated('_out') || bufferWasTruncated('_err');
  if (out.outputTruncated) out.stderr += '\n[本地输出超过 1 MiB，已截断]';
  return out;
}

function readBuffer(name) {
  try {
    return String(pyodide.runPython(name + '.getvalue().decode("utf-8", "replace")'));
  } catch (_) {
    return '';
  }
}

function bufferWasTruncated(name) {
  try {
    return !!pyodide.runPython('bool(' + name + '.truncated)');
  } catch (_) {
    return false;
  }
}

/* ---------------- 消息入口 ---------------- */
self.addEventListener('message', function (e) {
  const d = e.data || {};
  if (d.type === 'init') {
    init(d).catch(function (err) {
      ready = false;
      post({ type: 'init-failed', error: String(err && err.message || err) });
    });
  } else if (d.type === 'run') {
    let result;
    try {
      result = doRun(d);
      post({ type: 'run-result', result: result });
    } catch (err) {
      ready = false;
      console.error('[py-worker] run crashed:', err && err.message, err && err.stack);
      post({
        type: 'run-result',
        result: {
          status: 'crash', compileStatus: 'SKIP', runStatus: 'ABORTED',
          compileTime: 0, executionTime: 0, stdout: '', stderr: '',
          exitCode: -1, cacheHit: false, error: String(err && err.message || err)
        }
      });
    }
  } else if (d.type === 'ping') {
    post({ type: 'pong', t: performance.now() });
  } else if (d.type === 'clear-cache') {
    // 显式释放全部 code object PyProxy（Runtime reset / dispose 用）
    clearCodeCache();
    post({ type: 'cache-cleared' });
  } else if (d.type === 'stats') {
    // 暴露内存/代理统计（内存压力测试用）。非核心路径，缺省字段返回 0。
    let proxyCount = null, wasmMemoryMB = null;
    try {
      if (pyodide && pyodide._api && typeof pyodide._api.proxyRegistry === 'object') {
        proxyCount = pyodide._api.proxyRegistry.size;
      }
    } catch (_) { /* ignore */ }
    try {
      if (pyodide && pyodide._module && pyodide._module.HEAPU8) {
        wasmMemoryMB = Math.round(pyodide._module.HEAPU8.length / 1024 / 1024 * 100) / 100;
      }
    } catch (_) { /* ignore */ }
    post({ type: 'stats', proxyCount, wasmMemoryMB, codeCacheSize: codeCache.size });
  }
});
