/* ============================================================
 * Web IDE 运行管线主线程调度（ES Module）—— OJCompiler Service 架构
 *
 * 架构（Compile Once, Run Many / Heavy Compiler · Light Runner 分层）：
 *  - Persistent Compiler Worker（ide-wasi-worker.js，常驻）：
 *    clang/wasm-ld 的 WebAssembly.Module + 解包后的 VFS/Sysroot 只初始化一次；
 *    PCH（/bits.pch）生成后常驻 VFS；编译与链接在同一 Worker 内完成，无中间文件复制。
 *  - Artifact Cache：SHA-256(runtime+lang+optLevel+pch+source) →
 *    { bytes, WebAssembly.Module }（Module 主线程只 compile 一次，postMessage 给执行器）。
 *  - Exec Worker（每次运行新建，干净状态）：精确测量 executionMs
 *    （wasi.start() 前后打点，stdin 已就位、计时区间内零 IPC）。
 *  - 后台 speculative compile：编辑器停止输入后预编译，Run 直接命中缓存。
 *
 * 计时定义（严格）：
 *  - Compile Time = 编译+链接得到 submission.wasm（compileMs/linkMs 等，仅未命中时发生）
 *  - Execution Time = 用户程序 _start() 起止（executionMs）——页面主指标
 * 暴露 window.__IDE_RUNNER__，就绪后派发 ide-runner-ready 事件。
 * ============================================================ */
import { fetchWASIFS } from '/js/runno/runno-runtime.js';

const RUNNO_VERSION = '0.10.0-ojc2';
const ORIGIN = (typeof location !== 'undefined' && location.origin) || '';
const LANGS = ORIGIN + '/js/runno/langs';
const CLANG_WASM_URL = LANGS + '/clang.wasm';
const LD_WASM_URL = LANGS + '/wasm-ld.wasm';
const CLANG_FS_URL = LANGS + '/clang-fs.tar.gz';
const PY_WASM_URL = LANGS + '/python-3.11.3.wasm';
const PY_FS_URL = LANGS + '/python-3.11.3.tar.gz';
const WORKER_URL = '/js/contest/ide-wasi-worker.js';

const COMPILE_TIMEOUT_MS = 90000; // 编译兜底（首次含 clang.wasm 下载+Module 编译）
const EXEC_TIMEOUT_MS = 6000;     // 程序执行本地限制
const ARTIFACT_CACHE_MAX = 8;
const VALID_OPTS = { '-O0': 1, '-O1': 1, '-O2': 1 };

/* 显式 #include 扫描：决定自动 PCH 层级。
 * 规则（与你的设计一致）：
 *   含 bits/stdc++.h  → bits.pch
 *   否则含 iostream   → iostream.pch
 *   否则              → none（正常 Header Parse）
 * 只匹配显式 include 行（跳过宏条件内写法），忽略 #include_next / 双引号相对 include。
 */
function detectPchLevel(code) {
  const re = /#\s*include\s*[<"]([^>"]+)[>"]/g;
  let m;
  while ((m = re.exec(code))) {
    const h = m[1];
    if (h === 'bits/stdc++.h') return 'bits';
    if (h === 'iostream') return 'iostream';
  }
  return 'none';
}

/* 解析最终 PCH 层级：显式 pchLevel 优先；否则 auto 扫描；兼容旧 usePch 布尔 */
function resolvePchLevel(code, lang, opts) {
  if (lang !== 'cpp') return 'none';
  if (opts.pchLevel && opts.pchLevel !== 'auto') return (opts.pchLevel === 'iostream' || opts.pchLevel === 'bits') ? opts.pchLevel : 'none';
  if (opts.pchLevel === 'auto' || opts.usePch === true || opts.pchEnabled) return detectPchLevel(code || '');
  return 'none';
}

/* ---------------- sysroot 加载（主线程，会话级一次） ---------------- */
let clangFsPromise = null;
let pythonFsPromise = null;

function loadClangFS() {
  if (!clangFsPromise) {
    clangFsPromise = fetchWASIFS(CLANG_FS_URL).catch(function (e) { clangFsPromise = null; throw e; });
  }
  return clangFsPromise;
}
function loadPythonFS() {
  if (!pythonFsPromise) {
    pythonFsPromise = fetchWASIFS(PY_FS_URL).catch(function (e) { pythonFsPromise = null; throw e; });
  }
  return pythonFsPromise;
}

/* Python runtime Module（会话级一次） */
let pythonModulePromise = null;
function loadPythonModule() {
  if (!pythonModulePromise) {
    pythonModulePromise = fetch(PY_WASM_URL)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (b) { return WebAssembly.compile(b); })
      .catch(function (e) { pythonModulePromise = null; throw e; });
  }
  return pythonModulePromise;
}

/* ---------------- Persistent Compiler Worker 单例 ---------------- */
let compilerWorker = null;
let compilerReadyPromise = null;
let compilerInitMs = null; // 首次 init 耗时（含 Module 编译，仅一次）

function ensureCompiler() {
  if (compilerReadyPromise) return compilerReadyPromise;
  compilerReadyPromise = (async function () {
    const t0 = performance.now();
    const fs = await loadClangFS(); // sysroot 解包（会话级一次）
    const vfsLoadMs = Math.round(performance.now() - t0);

    const worker = new Worker(WORKER_URL, { type: 'module' });
    compilerWorker = worker;
    const initMsg = await new Promise(function (resolve, reject) {
      const onMsg = function (e) {
        if (e.data && e.data.type === 'inited') { cleanup(); resolve(e.data); }
        else if (e.data && e.data.type === 'init-failed') { cleanup(); reject(new Error(e.data.error)); }
      };
      const onErr = function (e) { cleanup(); reject(new Error('编译器 Worker 启动失败: ' + (e.message || 'unknown'))); };
      function cleanup() {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
      }
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ type: 'init-compiler', fs: fs, clangUrl: CLANG_WASM_URL, lldUrl: LD_WASM_URL });
    });
    compilerInitMs = { vfsLoadMs: vfsLoadMs, moduleInitMs: initMsg.moduleInitMs };
    console.debug('[ide-runner] 编译器常驻 Worker 已初始化（仅一次）', compilerInitMs);
    return worker;
  })();
  compilerReadyPromise.catch(function () {
    // init 失败：允许下次重试
    if (compilerWorker) { try { compilerWorker.terminate(); } catch (_) { /* ignore */ } }
    compilerWorker = null;
    compilerReadyPromise = null;
  });
  return compilerReadyPromise;
}

/* 编译串行队列 + 同 key 在途复用 */
let compileChain = Promise.resolve();
const inFlightCompiles = new Map(); // key -> Promise<result>

function enqueueCompile(key, job) {
  if (inFlightCompiles.has(key)) return inFlightCompiles.get(key);
  const p = compileChain.then(job);
  compileChain = p.catch(function () { /* 队列不断链 */ });
  inFlightCompiles.set(key, p);
  p.finally(function () { inFlightCompiles.delete(key); });
  return p;
}

function compileInWorker(job) {
  return new Promise(function (resolve, reject) {
    ensureCompiler().then(function (worker) {
      const timer = setTimeout(function () {
        disposeCompiler();
        reject(new Error('编译超时'));
      }, COMPILE_TIMEOUT_MS);
      const onMsg = function (e) {
        const d = e.data;
        if (!d) return;
        if (d.type === 'pch-failed') { console.debug('[ide-runner] PCH 生成失败，已跳过实验', d.stderr); return; }
        if (d.type !== 'compile-result') return;
        cleanup();
        clearTimeout(timer);
        resolve(d);
      };
      const onErr = function (e) { cleanup(); clearTimeout(timer); reject(new Error(e.message || '编译 Worker 异常')); };
      function cleanup() {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
      }
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage(job);
    }).catch(reject);
  });
}

function disposeCompiler() {
  if (compilerWorker) { try { compilerWorker.terminate(); } catch (_) { /* ignore */ } }
  compilerWorker = null;
  compilerReadyPromise = null;
}

/* ---------------- Artifact Cache（bytes + WebAssembly.Module） ---------------- */
const artifactCache = new Map(); // key -> { bytes, modulePromise }

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function artifactKey(lang, optLevel, pchLevel, codeHash) {
  return RUNNO_VERSION + '|' + lang + '|' + optLevel + '|' + (pchLevel || 'none') + '|' + codeHash;
}

function cachePut(key, bytes) {
  if (artifactCache.has(key)) artifactCache.delete(key);
  const entry = { bytes: bytes, modulePromise: Promise.resolve().then(function () { return WebAssembly.compile(bytes); }) };
  artifactCache.set(key, entry);
  while (artifactCache.size > ARTIFACT_CACHE_MAX) artifactCache.delete(artifactCache.keys().next().value);
  return entry;
}

/* ---------------- stdin SAB 推送（与 Runno WASIWorkerHost 相同协议） ---------------- */
async function pushStdin(sab, text) {
  const dv = new DataView(sab);
  while (dv.getInt32(0) !== 0) await new Promise(function (r) { setTimeout(r, 0); });
  const bytes = new TextEncoder().encode(text);
  // SAB 容量 8KB（与 Runno 一致）；样例/自定义输入远低于此
  new Uint8Array(sab, 4).set(bytes.subarray(0, 8100));
  dv.setInt32(0, Math.min(bytes.byteLength, 8100));
  Atomics.notify(new Int32Array(sab), 0);
}
async function pushEOF(sab) {
  const dv = new DataView(sab);
  while (dv.getInt32(0) !== 0) await new Promise(function (r) { setTimeout(r, 0); });
  dv.setInt32(0, -1);
  Atomics.notify(new Int32Array(sab), 0);
}

/* ---------------- 干净 Exec Worker 执行 artifact ----------------
 * 返回 { stdout, stderr, exitCode, timedOut, aborted, wasmCompileMs, instantiateMs, executionMs }
 */
function execArtifact(opts) {
  return new Promise(function (resolve, reject) {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    const sab = new SharedArrayBuffer(8 * 1024);
    let settled = false;
    let timedOut = false;
    let aborted = false;

    function finish(res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (_) { /* ignore */ }
      resolve(res);
    }
    const timer = setTimeout(function () {
      timedOut = true;
      finish({ stdout: '', stderr: '', exitCode: -1, timedOut: true, aborted: false, executionMs: 0, instantiateMs: 0, wasmCompileMs: 0 });
    }, opts.timeoutMs || EXEC_TIMEOUT_MS);

    if (opts.killers) {
      opts.killers.push(function () {
        aborted = true;
        finish({ stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true, executionMs: 0, instantiateMs: 0, wasmCompileMs: 0 });
      });
    }

    worker.addEventListener('message', function (e) {
      const d = e.data;
      if (!d || d.type !== 'run-result') return;
      finish({
        stdout: d.stdout || '', stderr: d.stderr || (d.error ? d.error.message : ''),
        exitCode: d.exitCode, timedOut: false, aborted: false,
        wasmCompileMs: d.timing.wasmCompileMs, instantiateMs: d.timing.instantiateMs,
        executionMs: d.timing.executionMs
      });
    });
    worker.addEventListener('error', function (e) {
      if (settled) return;
      reject(new Error('执行 Worker 异常: ' + (e.message || 'unknown')));
    });

    worker.postMessage({
      type: 'run', module: opts.module || null, bytes: opts.bytes || null,
      args: opts.args || ['program'], env: {}, fs: opts.fs || {}, stdinBuffer: sab
    });
    // stdin 推送（先数据后 EOF，后台自旋等待消费 —— 与 Runno 相同次序）
    if (opts.stdin) pushStdin(sab, opts.stdin).catch(function () { /* ignore */ });
    pushEOF(sab).catch(function () { /* ignore */ });
  });
}

/* ---------------- 对外：C/C++ 编译+运行 ----------------
 * 返回 { stdout, stderr, exitCode, timedOut, aborted, compileFailed,
 *        executionMs（主指标）, timeMs（总耗时，兼容字段）, timing（完整 profile） }
 */
async function runC(opts) {
  const lang = opts.lang === 'c' ? 'c' : 'cpp';
  const optLevel = VALID_OPTS[opts.optLevel] ? opts.optLevel : '-O0';
  // PCH 层级：none | iostream | bits（opts.pchLevel='auto' 或 usePch 时自动扫描 include）
  const pchLevel = resolvePchLevel(opts.code, lang, opts);
  const killers = opts.killers || null;
  const t0 = performance.now();
  const timing = {
    cacheHit: false, hash: '', optLevel: optLevel, pchUsed: false,
    compilerInitMs: null, clangInitMs: null, pchMs: 0,
    frontendMs: null, backendMs: null, compileMs: 0, linkMs: 0,
    wasmCompileMs: 0, instantiateMs: 0, executionMs: 0, totalMs: 0
  };

  const codeHash = await sha256Hex(opts.code || '');
  timing.hash = codeHash.slice(0, 8);
  timing.pchLevel = pchLevel;
  const key = artifactKey(lang, optLevel, pchLevel, codeHash);

  let entry = artifactCache.get(key) || null;
  if (!entry) {
    // —— Compile Time（仅未命中时发生一次） ——
    const compileResult = await enqueueCompile(key, function () {
      return compileInWorker({ type: 'compile', code: opts.code || '', lang: lang, optLevel: optLevel, pchLevel: pchLevel });
    });
    if (compilerInitMs) {
      timing.compilerInitMs = compilerInitMs; // 含 vfsLoadMs + moduleInitMs（仅初始化发生的那次编译附带）
      compilerInitMs = null;
    }
    const ct = compileResult.timing || {};
    timing.pchUsed = !!ct.pchUsed;
    timing.pchLevel = ct.pchLevel || pchLevel;
    timing.pchMs = ct.pchMs || 0;
    timing.clangInitMs = ct.clangInitMs != null ? ct.clangInitMs : null;
    timing.compileMs = ct.compileMs || 0;
    timing.linkMs = ct.linkMs || 0;
    timing.frontendMs = ct.frontendMs != null ? ct.frontendMs : null;
    timing.backendMs = ct.backendMs != null ? ct.backendMs : null;

    if (!compileResult.ok) {
      timing.totalMs = Math.round(performance.now() - t0);
      return {
        compileFailed: true, stage: compileResult.stage,
        stdout: compileResult.stdout || '', stderr: compileResult.stderr || '编译失败',
        exitCode: compileResult.exitCode != null ? compileResult.exitCode : -1,
        executionMs: 0, timeMs: timing.totalMs, timing: timing
      };
    }
    entry = cachePut(key, compileResult.bytes);
  } else {
    timing.cacheHit = true;
  }

  // —— Execution：干净 Worker + 缓存 Module ——
  let module = null;
  try {
    const m0 = performance.now();
    module = await entry.modulePromise;
    timing.wasmCompileMs = Math.round((performance.now() - m0) * 10) / 10; // 仅首次实际耗时，之后≈0
  } catch (e) {
    module = null; // 兜底：直接传 bytes 给 worker 编译
  }
  const r = await execArtifact({
    module: module, bytes: module ? null : entry.bytes,
    stdin: opts.stdin || '', timeoutMs: EXEC_TIMEOUT_MS, killers: killers
  });
  if (timing.wasmCompileMs === 0 && r.wasmCompileMs) timing.wasmCompileMs = r.wasmCompileMs;
  timing.instantiateMs = r.instantiateMs;
  timing.executionMs = r.executionMs;
  timing.totalMs = Math.round(performance.now() - t0);
  return {
    stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode,
    timedOut: r.timedOut, aborted: r.aborted,
    executionMs: r.executionMs, timeMs: timing.totalMs, timing: timing
  };
}

/* ---------------- 对外：Python 运行（无编译阶段；runtime Module 会话级一次） ---------------- */
async function runPython(opts) {
  const killers = opts.killers || null;
  const t0 = performance.now();
  const timing = {
    cacheHit: true, hash: '', optLevel: null, pchUsed: false,
    runtimeLoadMs: 0, moduleInitMs: 0,
    wasmCompileMs: 0, instantiateMs: 0, executionMs: 0, totalMs: 0
  };
  const f0 = performance.now();
  const baseFs = await loadPythonFS();
  const module = await loadPythonModule();
  timing.runtimeLoadMs = Math.round(performance.now() - f0); // 首次后 ≈0（内存缓存）

  const fs = Object.assign({}, baseFs, {
    '/program': {
      path: 'program', content: opts.code || '', mode: 'string',
      timestamps: { access: new Date(), modification: new Date(), change: new Date() }
    }
  });
  const r = await execArtifact({
    module: module, args: ['python', '/program'], fs: fs,
    stdin: opts.stdin || '', timeoutMs: EXEC_TIMEOUT_MS, killers: killers
  });
  timing.instantiateMs = r.instantiateMs;
  timing.executionMs = r.executionMs;
  timing.totalMs = Math.round(performance.now() - t0);
  return {
    stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode,
    timedOut: r.timedOut, aborted: r.aborted,
    executionMs: r.executionMs, timeMs: timing.totalMs, timing: timing
  };
}

/* ---------------- 后台 speculative compile（编辑停止后预编译，错误静默） ---------------- */
let lastSpeculatedKey = '';

async function speculate(opts) {
  try {
    const lang = opts.lang === 'c' ? 'c' : 'cpp';
    if (lang === 'python') return;
    const optLevel = VALID_OPTS[opts.optLevel] ? opts.optLevel : '-O0';
    const pchLevel = resolvePchLevel(opts.code, lang, opts);
    const code = opts.code || '';
    if (!code.trim() || code.length > 200 * 1024) return;
    const key = artifactKey(lang, optLevel, pchLevel, await sha256Hex(code));
    if (artifactCache.has(key) || key === lastSpeculatedKey) return;
    lastSpeculatedKey = key;
    const result = await enqueueCompile(key, function () {
      return compileInWorker({ type: 'compile', code: code, lang: lang, optLevel: optLevel, pchLevel: pchLevel });
    });
    if (result && result.ok) {
      cachePut(key, result.bytes);
      console.debug('[ide-runner] 后台预编译完成', { hash: key.slice(-8), compileMs: result.timing && result.timing.compileMs });
    }
  } catch (_) { /* 预编译失败静默：用户手动运行时会得到正式报错 */ }
}

/* ---------------- 预热：语言选中即后台初始化对应运行时 ---------------- */
function warm(url) {
  try { fetch(url, { cache: 'force-cache' }).then(function (r) { return r.arrayBuffer(); }).catch(function () { /* ignore */ }); } catch (_) { /* ignore */ }
}

function prewarm(lang) {
  try {
    if (lang === 'python') {
      loadPythonFS().catch(function () { /* ignore */ });
      loadPythonModule().catch(function () { /* ignore */ });
    } else {
      ensureCompiler().catch(function () { /* ignore */ });
    }
  } catch (_) { /* ignore */ }
}

window.__IDE_RUNNER__ = {
  version: RUNNO_VERSION,
  runC: runC,
  runPython: runPython,
  speculate: speculate,
  prewarm: prewarm
};
window.dispatchEvent(new CustomEvent('ide-runner-ready'));
