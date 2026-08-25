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
import { fetchWASIFS } from '/runtime/runno/0.10.0-ojc4/runno-runtime.js';
import { check as gcc11HeaderCheck } from '/js/contest/gcc11-header-check.js';
import { check as gcc14HeaderCheck } from '/js/contest/gcc14-header-check.js';

const RUNNO_VERSION = '0.10.0-ojc4';
const ORIGIN = (typeof location !== 'undefined' && location.origin) || '';
const LANGS = ORIGIN + '/runtime/runno/0.10.0-ojc4/langs';
const CLANG_WASM_URL = LANGS + '/clang.wasm';
const LD_WASM_URL = LANGS + '/wasm-ld.wasm';
const CLANG_FS_URL = LANGS + '/clang-fs.tar.gz';
const WORKER_URL = '/js/contest/ide-wasi-worker.js';

/* ---------------- Python 3 Runtime 常量（Pyodide Persistent Worker，解释型 WASM） ----------------
 * 版本已冻结：Pyodide 0.26.4 / CPython 3.12.1（与服务器 CPython 3.12.3 minor 对齐）
 * runtimeId 由实测版本生成，禁止凭印象改号；任一组件变化必须升级 Runtime ID。
 */
const PY_RUNTIME_ID = 'py312-cpython-compat-v1';
const JAVA_RUNTIME_ID_PRIMARY = 'java21-browserjdk-compat-v2';
const MODERN_ENGINE_ID = 'cpp-modern-engine-v2';
const MODERN_WORKER_URL = '/js/contest/ide-wasi-worker-modern.js';
const MODERN_EXECUTION_WORKER_URL = '/js/contest/ide-wasi-execution-worker-modern.js';
const PY_WORKER_URL = '/js/contest/ide-python-worker.js';
const PY_INIT_TIMEOUT_MS = 60000;  // 首次含 pyodide wasm 下载 + CPython 初始化兜底
const PY_INTERRUPT_GRACE_MS = 800; // SAB interrupt 后等待 KeyboardInterrupt 生效窗口
const PY_FALLBACK_TIMEOUT_MS = 6000; // SAB 不可用时：Local Timeout → terminate + 重建 Worker 的兜底窗口

/* Python Runtime 中断能力检测（正式比赛 Environment Check）：
 * READY   —— SharedArrayBuffer + crossOriginIsolated + Atomics 全部满足 → SAB KeyboardInterrupt，
 *            Worker 尽量复用。
 * FALLBACK—— 任一不满足 → 不依赖 SAB，Local Timeout 到点 terminate Worker + 下次 Run 重建
 *            （绝不卡死比赛页面）。
 * 与 C/C++ Runtime 语义无关，仅影响 Python 解释型 Worker 的中断策略。
 */
let pythonInterruptCapability = null; // lazy: 'READY' | 'FALLBACK'
/* 诊断/测试钩子：仅当显式设置 window.__PY_FORCE_INTERRUPT_CAPABILITY__ 时才覆盖检测结果，
 * 用于在未部署 COOP/COEP 的环境中验证 FALLBACK 兜底路径。生产默认不使用。 */
function forcedInterruptCapability() {
  try {
    const f = window.__PY_FORCE_INTERRUPT_CAPABILITY__;
    if (f === 'READY' || f === 'FALLBACK') return f;
  } catch (_) { /* ignore */ }
  return null;
}
function detectPythonInterruptCapability() {
  if (pythonInterruptCapability) return pythonInterruptCapability;
  const forced = forcedInterruptCapability();
  if (forced) { pythonInterruptCapability = forced; return pythonInterruptCapability; }
  const hasSab = typeof SharedArrayBuffer !== 'undefined';
  const isolated = typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false;
  const hasAtomics = typeof Atomics !== 'undefined' && typeof Atomics.store === 'function';
  pythonInterruptCapability = (hasSab && isolated && hasAtomics) ? 'READY' : 'FALLBACK';
  return pythonInterruptCapability;
}

/* Runtime ID 注册表：冻结 C/C++/Python 不变；Java 21 v2 为 BETA_FROZEN；Modern 使用独立 engine。 */
const runtimeIds = {
  cpp: 'cpp11-gcc11-compat-v5',
  c: 'c11-gcc11-compat-v3',
  c17: 'c17-gcc14-compat-v2',
  cpp17: 'cpp17-gcc14-compat-v2',
  modernEngine: MODERN_ENGINE_ID,
  python: PY_RUNTIME_ID,
  java: JAVA_RUNTIME_ID_PRIMARY
};

const COMPILE_TIMEOUT_MS = 90000; // 编译兜底（首次含 clang.wasm 下载+Module 编译）
const EXEC_TIMEOUT_MS = 6000;     // 程序执行本地限制
const ARTIFACT_CACHE_MAX = 8;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024;
const JAVA_SCANNER_WARNING_INPUT_BYTES = 1 * 1024 * 1024;
const VALID_OPTS = { '-O0': 1, '-O1': 1, '-O2': 1 };

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value == null ? '' : value)).byteLength;
}

function createLocalInputLimitResult(opts, actualBytes) {
  const options = opts || {};
  const language = options.language || options.lang || 'python';
  const message = '浏览器环境无法覆盖：stdin 实际 UTF-8 ' + actualBytes +
    ' 字节，超过本地上限 ' + MAX_STDIN_BYTES + ' 字节（4 MiB）。';
  return {
    language: language,
    runtimeId: null,
    compileStatus: 'SKIP', compileTime: 0, compileFailed: false,
    runStatus: 'LOCAL_UNSUPPORTED', executionTime: 0, executionMs: 0, timeMs: 0,
    stdout: '', stderr: message, exitCode: -1,
    cacheHit: false, linkTime: null, timedOut: false, aborted: false,
    outputTruncated: false, failureLayer: 'input',
    reason: 'LOCAL_INPUT_LIMIT', coverageLimited: true,
    limitField: 'stdin', limitBytes: MAX_STDIN_BYTES, actualBytes: actualBytes,
    coverageMessage: message
  };
}

function normalizeLocalOutputLimitResult(result) {
  if (!result || result.outputTruncated !== true) return result;
  if (result.compileFailed === true || result.compileStatus === 'CE' || result.runStatus === 'CE') return result;
  const message = '浏览器环境无法覆盖：浏览器本地输出能力上限为 1 MiB（' +
    MAX_OUTPUT_BYTES + ' 字节），输出已截断。';
  const stderr = String(result.stderr == null ? '' : result.stderr);
  return Object.assign({}, result, {
    stderr: stderr.indexOf(message) >= 0 ? stderr : (stderr ? stderr + '\n' : '') + message,
    runStatus: 'LOCAL_UNSUPPORTED',
    reason: 'LOCAL_OUTPUT_LIMIT',
    coverageLimited: true,
    coverageMessage: message,
    limitField: result.limitField || 'stdout/stderr',
    limitBytes: MAX_OUTPUT_BYTES,
    outputLimitBytes: MAX_OUTPUT_BYTES,
    timedOut: false,
    aborted: false,
    runtimeError: false
  });
}

function javaScannerWarnings(source, stdin) {
  const sourceText = String(source == null ? '' : source);
  const inputBytes = utf8ByteLength(stdin);
  if (inputBytes <= JAVA_SCANNER_WARNING_INPUT_BYTES) return [];
  let code = '';
  let mode = 'code';
  let quote = '';
  for (let i = 0; i < sourceText.length; i += 1) {
    const ch = sourceText[i];
    const next = sourceText[i + 1];
    if (mode === 'line') {
      if (ch === '\n' || ch === '\r') mode = 'code';
      code += ' ';
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code'; code += '  '; i += 1;
      } else {
        code += ' ';
      }
      continue;
    }
    if (mode === 'literal') {
      if (ch === '\\') {
        code += '  '; i += 1;
      } else {
        if (ch === quote) { mode = 'code'; quote = ''; }
        code += ' ';
      }
      continue;
    }
    if (mode === 'text') {
      if (ch === '"' && next === '"' && sourceText[i + 2] === '"') {
        mode = 'code'; code += '   '; i += 2;
      } else {
        code += ' ';
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = 'line'; code += '  '; i += 1;
    } else if (ch === '/' && next === '*') {
      mode = 'block'; code += '  '; i += 1;
    } else if (ch === '"' && next === '"' && sourceText[i + 2] === '"') {
      mode = 'text'; code += '   '; i += 2;
    } else if (ch === '"' || ch === "'") {
      mode = 'literal'; quote = ch; code += ' ';
    } else {
      code += ch;
    }
  }
  const usesScanner = /\bnew\s+(?:(?:java\s*\.\s*util\s*\.)?Scanner)\s*\(/.test(code);
  if (!usesScanner) return [];
  return [{
    code: 'JAVA_SCANNER_LARGE_INPUT',
    severity: 'warning',
    actualBytes: inputBytes,
    limitBytes: JAVA_SCANNER_WARNING_INPUT_BYTES,
    message: 'stdin 超过 1 MiB 且源码使用 Scanner；浏览器本地运行可能较慢，建议使用 BufferedReader 或快速输入。'
  }];
}

function appendJavaScannerWarnings(result, opts) {
  if (!result) return result;
  const options = opts || {};
  const language = options.language || options.lang || '';
  if (language !== 'java' && language !== 'java21') return result;
  const warnings = javaScannerWarnings(
    options.source != null ? options.source : options.code,
    options.stdin
  );
  if (!warnings.length) return result;
  const existing = Array.isArray(result.warnings) ? result.warnings : [];
  return Object.assign({}, result, { warnings: existing.concat(warnings) });
}

function normalizeBrowserRunResult(result, opts) {
  return normalizeLocalOutputLimitResult(appendJavaScannerWarnings(result, opts));
}

/* ---------------- 语言 profile 表（§15：语言配置驱动，复用统一 Runner） ----------------
 * 公共流程 source → profile → compile → link → artifact cache → run → stdout/stderr/executionTime
 * 由 profile 承载语言差异；不复制 c-runner.js / cpp-runner.js 两套 Worker。
 * 冻结原则：cpp11 profile 保持 C++ Runtime 冻结行为（bits PCH + -Werror + Header Check），
 * c11 profile 为 C11（无 PCH + 无 -Werror + 默认 long double）。预留 python3 位。
 */
const LANG_PROFILES = {
  cpp11: {
    extension: '.cpp', standard: 'c++11',
    pchPolicy: 'explicit-bits-only',
    compatGuard: 'gcc11-cpp-header-check',
    werror: true,
    defaultLongDouble: false  // 冻结：C++ long double iostream 路径不完整，不默认启用
  },
  c11: {
    extension: '.c', standard: 'c11',
    pchPolicy: 'none',
    compatGuard: 'none-unless-proven-needed',
    werror: false,  // §8：不默认 -Werror，以 GCC11 实际 exit code 为准
    defaultLongDouble: true  // §6 A/B 评测：C long double %Lf 完整支持 + 无回退，默认启用
  },
  c17: {
    extension: '.c', standard: 'c17', profileId: 'c17-gcc14-compat-v2',
    pchPolicy: 'none', compatGuard: 'none', werror: false, defaultLongDouble: true,
    defaultOptimization: '-O2'
  },
  cpp17: {
    extension: '.cpp', standard: 'c++17', profileId: 'cpp17-gcc14-compat-v2',
    pchPolicy: 'none', compatGuard: 'none', werror: false, defaultLongDouble: false,
    defaultOptimization: '-O2'
  }
  // python3: { extension: '.py', standard: 'python3', pchPolicy: 'none', compatGuard: 'none', werror: false }  // 预留
};

/* 显式 #include 扫描：决定自动 PCH 层级（严格 Gate）。
 * 规则（严格，优先级高于性能）：
 *   只有源码显式 #include <bits/stdc++.h>  → bits.pch
 *   否则一律            → none（不自动注入 iostream/common，不猜测）
 * 禁止：给无 bits/stdc++.h 的源码偷偷加载包含额外标准库声明的 PCH。
 * 只匹配显式 include 行，忽略 #include_next / 双引号相对 include。
 */
function detectPchLevel(code) {
  const re = /#\s*include\s*[<"]([^>"]+)[>"]/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1] === 'bits/stdc++.h') return 'bits';
  }
  return 'none';
}

/* 解析最终 PCH 层级：显式 pchLevel 优先（bits|none）；否则 auto 扫描。
 * iostream/common 不再作为自动 PCH 选项（strict gate）。 */
function resolvePchLevel(code, lang, opts) {
  if (lang !== 'cpp') return 'none';
  if (opts.pchLevel && opts.pchLevel !== 'auto') return opts.pchLevel === 'bits' ? 'bits' : 'none';
  if (opts.pchLevel === 'auto' || opts.usePch === true || opts.pchEnabled) return detectPchLevel(code || '');
  return 'none';
}

/* ---------------- sysroot 加载（主线程，会话级一次） ---------------- */
let clangFsPromise = null;

function loadClangFS() {
  if (!clangFsPromise) {
    clangFsPromise = fetchWASIFS(CLANG_FS_URL).catch(function (e) { clangFsPromise = null; throw e; });
  }
  return clangFsPromise;
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

/* ---------------- Modern Clang 19 Browser Worker（独立于冻结 Clang 8） ---------------- */
let modernWorker = null;
let modernReadyPromise = null;
let modernRequestSeq = 0;
const modernPending = new Map();

function disposeModernWorker(reason) {
  if (modernWorker) { try { modernWorker.terminate(); } catch (_) { /* ignore */ } }
  modernWorker = null;
  modernReadyPromise = null;
  const error = new Error(reason || 'Modern Compiler Worker 已关闭');
  modernPending.forEach(function (pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
  });
  modernPending.clear();
}

function armModernExecutionTimeout(state) {
  modernPending.forEach(function (pending, requestId) {
    if (pending.profileId !== state.profileId || pending.sourceHash !== state.sourceHash) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(function () {
      if (!modernPending.has(requestId)) return;
      modernPending.delete(requestId);
      const timeoutResult = {
        runtimeId: MODERN_ENGINE_ID,
        profileId: pending.profileId,
        sourceHash: pending.sourceHash,
        cacheHit: !!state.cacheHit,
        runtimeAssetHash: state.runtimeAssetHash || null,
        cacheKey: state.cacheKey || null,
        compileStatus: 'PASS', runStatus: 'LOCAL_TIMEOUT', exitCode: -1,
        compilerInitMs: state.compilerInitMs || 0,
        compileMs: state.compileMs || 0, linkMs: state.linkMs || 0,
        executionMs: EXEC_TIMEOUT_MS, timedOut: true, outputTruncated: false,
        stdout: '', stderr: '运行超时（浏览器本地 6s 限制）', failureLayer: 'execution'
      };
      disposeModernWorker('Modern execution timeout; worker will be recreated');
      pending.resolve(timeoutResult);
    }, EXEC_TIMEOUT_MS);
  });
}

function ensureModernWorker() {
  if (modernReadyPromise) return modernReadyPromise;
  modernReadyPromise = (async function () {
    await prewarmModernRuntime(MODERN_ENGINE_ID);
    const worker = new Worker(MODERN_WORKER_URL, { type: 'module' });
    modernWorker = worker;
    worker.addEventListener('message', function (event) {
      const data = event.data || {};
      if (data.type === 'state' || data.type === 'progress') {
        const snapshot = Object.assign({ runtimeId: MODERN_ENGINE_ID }, data.snapshot || data);
        if (!snapshot.stage && snapshot.state) snapshot.stage = snapshot.state;
        if (snapshot.stage === 'FAILED') snapshot.stage = 'ERROR';
        if (!Number.isFinite(snapshot.percent)) {
          snapshot.percent = snapshot.stage === 'READY' ? 100 : -1;
          snapshot.indeterminate = snapshot.stage !== 'READY' && snapshot.stage !== 'ERROR';
        }
        broadcastProgress(snapshot);
        if (data.type === 'state' && data.state === 'RUNNING') armModernExecutionTimeout(data);
        return;
      }
      if (data.type !== 'compile-result' || data.requestId == null) return;
      const pending = modernPending.get(data.requestId);
      if (!pending) return;
      modernPending.delete(data.requestId);
      clearTimeout(pending.timer);
      pending.resolve(data.result || data);
    });
    worker.addEventListener('error', function (event) {
      disposeModernWorker('Modern Compiler Worker 异常: ' + (event.message || 'unknown'));
    });
    const initResult = await new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        cleanup();
        reject(new Error('Modern Compiler 初始化超时'));
      }, COMPILE_TIMEOUT_MS);
      const onMessage = function (event) {
        const data = event.data || {};
        if (data.type !== 'inited') return;
        cleanup();
        if (data.ok === false) reject(new Error(data.error || 'Modern Compiler 初始化失败'));
        else resolve(data);
      };
      const onError = function (event) {
        cleanup();
        reject(new Error(event.message || 'Modern Compiler Worker 启动失败'));
      };
      function cleanup() {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      }
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type: 'init' });
    });
    return { worker: worker, init: initResult };
  })();
  modernReadyPromise.catch(function () { disposeModernWorker('Modern Compiler 初始化失败'); });
  return modernReadyPromise;
}

async function runModern(opts) {
  const requestedProfile = String(opts.profileId || '');
  const requestedLanguage = String(opts.language || opts.lang || '');
  const lang = requestedProfile === 'c17-gcc14-compat-v1' || requestedProfile === 'c17-gcc14-compat-v2' || requestedLanguage === 'c17' ||
    (requestedLanguage === 'c' && opts.standard === 'c17') ? 'c17' : 'cpp17';
  const profile = LANG_PROFILES[lang];
  const source = opts.source != null ? opts.source : (opts.code || '');
  const sourceHash = await sha256Hex(source);
  if (lang === 'cpp17') {
    const guard = gcc14HeaderCheck(source);
    if (!guard.ok) {
      return {
        language: 'cpp', runtimeId: MODERN_ENGINE_ID, profileId: profile.profileId,
        sourceHash: sourceHash, compileStatus: 'CE', runStatus: 'CE', compileFailed: true,
        stage: 'gcc14-header', failureLayer: 'precheck', exitCode: -1,
        stdout: '', stderr: 'Local GCC14 compatibility CE: ' + guard.reason,
        headerGuard: {policy: 'proven-mismatch-v1', missing: guard.missing},
        cacheHit: false, timedOut: false, outputTruncated: false,
        compileTime: 0, linkTime: 0, executionTime: 0,
        timing: {optimizationLevel: profile.defaultOptimization, compileMs: 0, linkMs: 0,
          executionMs: 0, cacheHit: false, headerGuard: 'ENABLED'}
      };
    }
  }
  const ready = await ensureModernWorker();
  const requestId = ++modernRequestSeq;
  const compileResult = await new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      modernPending.delete(requestId);
      disposeModernWorker('Modern compile timeout');
      reject(new Error('Modern compile timeout'));
    }, COMPILE_TIMEOUT_MS);
    modernPending.set(requestId, {
      resolve: resolve, reject: reject, timer: timer,
      profileId: profile.profileId, sourceHash: sourceHash
    });
    ready.worker.postMessage({
      type: 'compile', requestId: requestId,
      source: source, sourceHash: sourceHash,
      profileId: profile.profileId,
      language: lang === 'c17' ? 'c' : 'cpp', standard: profile.standard,
      stdin: opts.stdin || '', optLevel: profile.defaultOptimization
    });
  });
  let result = compileResult;
  if (compileResult && compileResult.ok && compileResult.bytes) {
    result = await new Promise(function (resolve) {
      const executionWorker = new Worker(MODERN_EXECUTION_WORKER_URL, {type: 'module'});
      const artifactBytes = compileResult.bytes.byteLength;
      let settled = false;
      let killFn = null;
      const finish = function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killFn && Array.isArray(opts.killers)) {
          const index = opts.killers.indexOf(killFn);
          if (index >= 0) opts.killers.splice(index, 1);
        }
        try { executionWorker.terminate(); } catch (_) { /* disposable worker */ }
        resolve(Object.assign({}, compileResult, value, {
          bytes: undefined,
          artifactBytes: artifactBytes,
          compilerWorkerPreserved: modernWorker === ready.worker
        }));
      };
      const timer = setTimeout(function () {
        finish({
          ok: false, compileStatus: 'PASS', runStatus: 'LOCAL_TIMEOUT', exitCode: -1,
          stdout: '', stderr: '本地运行超时（6s）已终止。Local Timeout 仅用于调试保护，正式 TLE 以服务器 Judge 为准。',
          executionMs: EXEC_TIMEOUT_MS, executionTime: EXEC_TIMEOUT_MS,
          timedOut: true, aborted: true, failureLayer: 'execution'
        });
      }, EXEC_TIMEOUT_MS);
      if (Array.isArray(opts.killers)) {
        killFn = function () {
          try { executionWorker.postMessage({type: 'cancel', requestId: requestId}); } catch (_) { /* terminate below */ }
          finish({ok: false, compileStatus: 'PASS', runStatus: 'ABORTED', exitCode: -1,
            stdout: '', stderr: '', aborted: true, timedOut: false, failureLayer: 'execution'});
        };
        opts.killers.push(killFn);
      }
      executionWorker.addEventListener('message', function (event) {
        const data = event.data || {};
        if (data.type === 'run-result' && data.requestId === requestId) finish(data.result || data);
        else if (data.type === 'error' && data.requestId === requestId) finish({
          ok: false, compileStatus: 'PASS', runStatus: 'ABORTED', exitCode: -1,
          stdout: '', stderr: data.message || 'Execution Worker error', aborted: true,
          timedOut: false, failureLayer: 'execution'
        });
      });
      executionWorker.addEventListener('error', function (event) {
        finish({ok: false, compileStatus: 'PASS', runStatus: 'ABORTED', exitCode: -1,
          stdout: '', stderr: event.message || 'Execution Worker crash', aborted: true,
          timedOut: false, failureLayer: 'execution'});
      });
      const artifact = compileResult.bytes;
      executionWorker.postMessage({type: 'run', requestId: requestId, bytes: artifact,
        stdin: opts.stdin || '', args: opts.args || ['program'], env: opts.env || {}}, [artifact.buffer]);
    });
  }
  const normalized = Object.assign({
    language: lang === 'c17' ? 'c' : 'cpp',
    runtimeId: result.runtimeId || MODERN_ENGINE_ID,
    profileId: profile.profileId,
    sourceHash: sourceHash,
    compileStatus: result.compileStatus || (result.compileFailed ? 'CE' : 'PASS'),
    runStatus: result.runStatus || (result.compileFailed ? 'CE' : 'PASS'),
    compileTime: result.compileMs || 0,
    linkTime: result.linkMs || 0,
    executionTime: result.executionMs || 0,
    stdout: result.stdout || '', stderr: result.stderr || '',
    cacheHit: !!result.cacheHit,
    exitCode: result.exitCode == null ? -1 : result.exitCode,
    timedOut: !!result.timedOut,
    outputTruncated: !!result.outputTruncated,
    compileFailed: result.compileStatus === 'CE' || !!result.compileFailed
  }, result);
  normalized.timing = Object.assign({}, result.timing || {}, {
    optimizationLevel: profile.defaultOptimization,
    compilerInitMs: result.compilerInitMs || (ready.init && ready.init.compilerInitMs) || 0,
    compileMs: result.compileMs || 0,
    linkMs: result.linkMs || 0,
    executionMs: result.executionMs || 0,
    cacheHit: !!result.cacheHit,
    artifactBytes: result.artifactBytes || 0
  });
  return normalized;
}

async function modernStats() {
  const ready = await ensureModernWorker();
  const requestId = ++modernRequestSeq;
  return new Promise(function (resolve) {
    const timer = setTimeout(function () { cleanup(); resolve({ready: false, timeout: true}); }, 2000);
    const onMessage = function (event) {
      const data = event.data || {};
      if (data.type !== 'stats' || data.requestId !== requestId) return;
      cleanup();
      resolve(data);
    };
    function cleanup() {
      clearTimeout(timer);
      ready.worker.removeEventListener('message', onMessage);
    }
    ready.worker.addEventListener('message', onMessage);
    try { ready.worker.postMessage({type: 'stats', requestId: requestId}); }
    catch (_) { cleanup(); resolve({ready: false, sendFailed: true}); }
  });
}

/* ---------------- Artifact Cache（bytes + WebAssembly.Module） ---------------- */
const artifactCache = new Map(); // key -> { bytes, modulePromise }

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function artifactKey(lang, optLevel, pchLevel, codeHash, longDouble) {
  return RUNNO_VERSION + '|' + lang + '|' + optLevel + '|' + (pchLevel || 'none') + '|' + (longDouble ? 'ld' : 'nold') + '|' + codeHash;
}

function cachePut(key, bytes) {
  if (artifactCache.has(key)) artifactCache.delete(key);
  const entry = { bytes: bytes, modulePromise: Promise.resolve().then(function () { return WebAssembly.compile(bytes); }) };
  artifactCache.set(key, entry);
  while (artifactCache.size > ARTIFACT_CACHE_MAX) artifactCache.delete(artifactCache.keys().next().value);
  return entry;
}

/* ---------------- GCC11 Header Strict Check（Local CE 预检） ----------------
 * 目标：在 Browser 正式显示"本地编译成功"前，尽量消灭
 *   "Browser libc++ 因传递 include 错误放行、但 GCC11 正式提交会 CE" 的负向误放行。
 * 判定依据：用户显式 include 集合 + P0 高频实体的标准头归属（Ownership Table），
 *   见 gcc11-header-check.js。bits/stdc++.h 显式包含 → 直接豁免。
 * 缓存：sourceHash + runtimeVersion + gccCompatVersion → PASS/CE，源码不变则不重跑。
 * 性能：纯 JS token 级扫描，<5ms 量级；对普通 Run 无感知。
 */
const gcc11CompatVersion = 'v1';
const gcc11CompatCache = new Map(); // key(sourceHash) -> { ok, reason, missing }

async function checkGcc11Headers(opts) {
  const code = opts.code || '';
  const lang = opts.lang === 'c' ? 'c' : 'cpp';
  const t0 = performance.now();
  let ret;
  try {
    const codeHash = await sha256Hex(code);
    const cacheKey = lang + '|' + gcc11CompatVersion + '|' + codeHash;
    if (gcc11CompatCache.has(cacheKey)) {
      ret = gcc11CompatCache.get(cacheKey);
      ret.cached = true;
      ret.latencyMs = Math.round(performance.now() - t0);
      return ret;
    }
    if (lang !== 'cpp') {
      ret = { ok: true, skipped: true, reason: '非 C++，跳过', missing: [], cached: false };
    } else {
      const r = gcc11HeaderCheck(code);
      ret = { ok: r.ok, skipped: !!r.skipped, reason: r.reason || '', missing: r.missing || [], cached: false };
    }
    // 缓存（含 negative 结果），避免重复扫描
    gcc11CompatCache.set(cacheKey, ret);
    ret.latencyMs = Math.round(performance.now() - t0);
    return ret;
  } catch (e) {
    // 任何异常都不阻断正常 Run：降级为放行
    ret = { ok: true, skipped: true, reason: 'strict check error: ' + String(e && e.message || e), missing: [], cached: false, latencyMs: Math.round(performance.now() - t0) };
    return ret;
  }
}

/* ---------------- stdin SAB 推送（与 Runno WASIWorkerHost 相同协议） ---------------- */
function stdinBufferByteLength(inputByteLength) {
  // The first four bytes are the Atomics/DataView length word. The complete
  // SharedArrayBuffer must also be Int32-aligned because both sides create an
  // Int32Array view over the whole buffer.
  const required = Math.max(8 * 1024, inputByteLength + 4);
  return Math.ceil(required / Int32Array.BYTES_PER_ELEMENT) * Int32Array.BYTES_PER_ELEMENT;
}

async function waitForStdinSlot(sab, shouldAbort) {
  const dv = new DataView(sab);
  while (dv.getInt32(0) !== 0) {
    if (shouldAbort && shouldAbort()) throw new Error('stdin worker stopped');
    await new Promise(function (r) { setTimeout(r, 0); });
  }
  if (shouldAbort && shouldAbort()) throw new Error('stdin worker stopped');
  return dv;
}
async function pushStdin(sab, bytes, shouldAbort) {
  const dv = await waitForStdinSlot(sab, shouldAbort);
  new Uint8Array(sab, 4).set(bytes);
  dv.setInt32(0, bytes.byteLength);
  Atomics.notify(new Int32Array(sab), 0);
}
async function pushEOF(sab, shouldAbort) {
  const dv = await waitForStdinSlot(sab, shouldAbort);
  dv.setInt32(0, -1);
  Atomics.notify(new Int32Array(sab), 0);
}

/* ---------------- 干净 Exec Worker 执行 artifact ----------------
 * 返回 { stdout, stderr, exitCode, timedOut, aborted, runtimeError, runStatus,
 *        wasmCompileMs, instantiateMs, executionMs }
 */
function execArtifact(opts) {
  return new Promise(function (resolve) {
    const worker = new Worker(WORKER_URL, { type: 'module' });
    const stdinBytes = new TextEncoder().encode(opts.stdin || '');
    if (stdinBytes.byteLength > MAX_STDIN_BYTES) {
      try { worker.terminate(); } catch (_) { /* ignore */ }
      resolve({
        stdout: '', stderr: '本地输入超过 4 MB 限制', exitCode: -1,
        timedOut: false, aborted: false, inputTooLarge: true,
        executionMs: 0, instantiateMs: 0, wasmCompileMs: 0
      });
      return;
    }
    // 输入缓冲按 UTF-8 实际字节数分配，避免旧固定 8KB 缓冲静默截断大输入；
    // 长度同时向上取整到 Int32 的倍数，保证 Worker 侧 Int32Array 构造合法。
    const sab = new SharedArrayBuffer(stdinBufferByteLength(stdinBytes.byteLength));
    let settled = false;

    function finish(res) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (_) { /* ignore */ }
      resolve(res);
    }
    const timer = setTimeout(function () {
      finish({ stdout: '', stderr: '', exitCode: -1, timedOut: true, aborted: false, executionMs: 0, instantiateMs: 0, wasmCompileMs: 0 });
    }, opts.timeoutMs || EXEC_TIMEOUT_MS);

    if (opts.killers) {
      opts.killers.push(function () {
        finish({ stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true, executionMs: 0, instantiateMs: 0, wasmCompileMs: 0 });
      });
    }

    worker.addEventListener('message', function (e) {
      const d = e.data;
      if (!d || d.type !== 'run-result') return;
      const exitCode = d.exitCode == null ? -1 : d.exitCode;
      const runtimeError = d.ok === false || exitCode !== 0;
      const errorMessage = d.error && d.error.message ? d.error.message : '';
      const timing = d.timing || {};
      finish({
        ok: !runtimeError, stdout: d.stdout || '', stderr: d.stderr || errorMessage,
        exitCode: exitCode, timedOut: false, aborted: false,
        runtimeError: runtimeError, runStatus: runtimeError ? 'RE' : 'PASS',
        failureLayer: runtimeError ? 'execution' : null,
        outputTruncated: !!d.outputTruncated,
        wasmCompileMs: timing.wasmCompileMs || 0, instantiateMs: timing.instantiateMs || 0,
        executionMs: timing.executionMs || 0
      });
    });
    worker.addEventListener('error', function (e) {
      if (settled) return;
      finish({ ok: false, stdout: '', stderr: '执行 Worker 异常: ' + (e.message || 'unknown'),
        exitCode: -1, timedOut: false, aborted: false, runtimeError: true,
        runStatus: 'RE', failureLayer: 'execution', executionMs: 0,
        instantiateMs: 0, wasmCompileMs: 0 });
    });

    try {
      worker.postMessage({
        type: 'run', module: opts.module || null, bytes: opts.bytes || null,
        args: opts.args || ['program'], env: {}, fs: opts.fs || {}, stdinBuffer: sab
      });
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: '执行 Worker 发送失败: ' + String(error && error.message || error),
        exitCode: -1, timedOut: false, aborted: false, runtimeError: true,
        runStatus: 'RE', failureLayer: 'execution', executionMs: 0,
        instantiateMs: 0, wasmCompileMs: 0 });
      return;
    }
    // stdin 推送必须串行：先数据后 EOF。任何推送失败都要显式作为 RE，
    // 不能被 catch 忽略后让上层把空 stdout 误判成 PASS。
    const shouldAbort = function () { return settled; };
    const stdinPush = stdinBytes.byteLength
      ? pushStdin(sab, stdinBytes, shouldAbort)
      : Promise.resolve();
    stdinPush.then(function () { return pushEOF(sab, shouldAbort); }).catch(function (error) {
      if (settled) return;
      finish({ ok: false, stdout: '', stderr: 'stdin 推送失败: ' + String(error && error.message || error),
        exitCode: -1, timedOut: false, aborted: false, runtimeError: true,
        runStatus: 'RE', failureLayer: 'stdin', executionMs: 0,
        instantiateMs: 0, wasmCompileMs: 0 });
    });
  });
}

/* ---------------- 对外：C/C++ 编译+运行 ----------------
 * 返回 { stdout, stderr, exitCode, timedOut, aborted, compileFailed,
 *        executionMs（主指标）, timeMs（总耗时，兼容字段）, timing（完整 profile） }
 */
async function runC(opts) {
  const lang = opts.lang === 'c' ? 'c' : 'cpp';
  const profile = lang === 'c' ? LANG_PROFILES.c11 : LANG_PROFILES.cpp11;
  const optLevel = VALID_OPTS[opts.optLevel] ? opts.optLevel : '-O0';
  // PCH 层级：none | iostream | bits（opts.pchLevel='auto' 或 usePch 时自动扫描 include）
  const pchLevel = resolvePchLevel(opts.code, lang, opts);
  // long double：C11 profile 默认启用 -lc-printscan-long-double（§6 A/B 评测确认完整支持+无回退）；
  // C++ 保持默认禁用（冻结，iostream 路径不完整）。opts.longDouble 可显式覆盖。
  const longDouble = (opts.longDouble !== undefined)
    ? !!opts.longDouble
    : (profile.defaultLongDouble === true);
  const killers = opts.killers || null;
  const t0 = performance.now();
  const timing = {
    cacheHit: false, hash: '', optLevel: optLevel, pchUsed: false,
    compilerInitMs: null, clangInitMs: null, pchMs: 0,
    frontendMs: null, backendMs: null, compileMs: 0, linkMs: 0,
    wasmCompileMs: 0, instantiateMs: 0, executionMs: 0, totalMs: 0,
    headerCheckMs: 0, headerCheckCached: false
  };

  const codeHash = await sha256Hex(opts.code || '');
  timing.hash = codeHash.slice(0, 8);
  timing.pchLevel = pchLevel;
  const key = artifactKey(lang, optLevel, pchLevel, codeHash, longDouble);

  // —— GCC11 Header Strict Check（Local CE 预检，严格 Gate） ——
  // 仅在非 bits/stdc++.h 的显式头模式下触发；bits 显式包含 → 豁免。
  // 失败 → 直接 Local CE / Missing Header，不进入正常 Browser Run。
  if (!opts.skipHeaderCheck) {
    const hc = await checkGcc11Headers({ code: opts.code || '', lang: lang });
    timing.headerCheckMs = hc.latencyMs;
    timing.headerCheckCached = !!hc.cached;
    if (!hc.ok) {
      timing.totalMs = Math.round(performance.now() - t0);
      const detail = (hc.missing || []).map(function (m) {
        return 'std::' + m.name + ' 需要 <' + m.header + '>';
      });
      const reason = detail.length ? detail.join('；') : (hc.reason || '');
      return {
        compileFailed: true, stage: 'gcc11-header',
        stdout: '', stderr: 'Local GCC11 compatibility CE: ' + reason,
        exitCode: -1, executionMs: 0, timeMs: timing.totalMs, timing: timing
      };
    }
  }

  let entry = artifactCache.get(key) || null;
  if (!entry) {
    // —— Compile Time（仅未命中时发生一次） ——
    const compileResult = await enqueueCompile(key, function () {
      return compileInWorker({ type: 'compile', code: opts.code || '', lang: lang, optLevel: optLevel, pchLevel: pchLevel, longDouble: longDouble });
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
  timing.artifactBytes = entry && entry.bytes ? entry.bytes.byteLength : null;
  timing.totalMs = Math.round(performance.now() - t0);
  return {
    stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode,
    timedOut: r.timedOut, aborted: r.aborted,
    runtimeError: !!r.runtimeError, runStatus: r.runStatus || null,
    outputTruncated: !!r.outputTruncated,
    executionMs: r.executionMs, timeMs: timing.totalMs, timing: timing
  };
}

/* ---------------- 对外：Java 21 运行（browserjdk-oj Persistent Worker，解释型 WASM） ----------------
 * Phase 7 Checkpoint 2：
 *   Persistent Java Web Worker（ide-java-worker.js）：
 *   - 懒加载：首次选择 Java 或 prewarm('java') 时创建 Worker + 初始化 JVM + CompileServer。
 *   - Compile Once, Run Many：runtimeId + SHA-256(source) → immutable bytecode LRU（cap=8）。
 *   - Run Isolation：每次 Run 走 fresh MemoryClassLoader、swap System.in/out/err 缓冲、reset 协议 stdin。
 *   - 超时保护：按 stdin UTF-8 字节数计算 timeoutMs（默认 15s，最大 120s）后置 SAB interrupt
 *     → CompileServer bytecode 边界抛 InternalInterrupt；宽限期仍无响应 → terminate + 重建 Worker，绝不卡死主 UI。
 *   - Java 与 C/C++/Python 语义不同：Persistent JVM 内部 CompileServer 同时承担 compile + run。
 *     self-built CompileServer 返回 compile/run 分离语义；cache hit 仍用 fresh MemoryClassLoader 执行。
 *   - 禁止 Server Fallback：Local 失败只显示"Java 本地运行环境不可用 [重试]"，
 *     正式提交仍正常走 server OpenJDK 21。
 */
const JAVA_WORKER_URL = '/js/contest/ide-java-worker.js';
const JAVA_RUNTIME_BASE_URL = '/runtime/' + JAVA_RUNTIME_ID_PRIMARY + '/';
const JAVA_RUNTIME_MANIFEST_URL = JAVA_RUNTIME_BASE_URL + 'runtime-manifest.json';
const JAVA_WORKER_BOOT_TIMEOUT_MS = 180000; // JVM/CompileServer 启动超时
const JAVA_INIT_TIMEOUT_MS = 195000;     // Worker 初始化超时，略大于 JVM boot timeout
const JAVA_ASSET_TIMEOUT_MS = 180000;     // 移动网络下载约 30 MiB 冻结资产的总超时
const JAVA_EXEC_TIMEOUT_MS = 15000;       // Java 小输入的默认本地保护
const JAVA_TIMEOUT_MIN_MS = 1000;
const JAVA_TIMEOUT_MAX_MS = 120000;
const JAVA_TIMEOUT_LARGE_INPUT_BYTES = 1024 * 1024;
const JAVA_TIMEOUT_INPUT_STEP_BYTES = 1024 * 1024;
const JAVA_INTERRUPT_GRACE_MS = 800;      // SAB interrupt 后等待 bytecode 边界生效窗口

function normalizeJavaTimeoutMs(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return Math.min(JAVA_TIMEOUT_MAX_MS, Math.max(JAVA_TIMEOUT_MIN_MS, Math.round(numeric)));
}

function javaInputByteLength(input) {
  return new TextEncoder().encode(String(input || '')).byteLength;
}

function resolveJavaTimeoutMs(opts) {
  const options = opts || {};
  const runtimeConfig = options.runtimeConfig;
  const requested = options.timeoutMs != null
    ? options.timeoutMs
    : (runtimeConfig && runtimeConfig.timeoutMs);
  if (requested != null) {
    const explicit = normalizeJavaTimeoutMs(requested);
    if (explicit != null) return explicit;
  }

  const inputBytes = javaInputByteLength(options.stdin);
  if (inputBytes <= JAVA_TIMEOUT_LARGE_INPUT_BYTES) return JAVA_EXEC_TIMEOUT_MS;
  const progress = Math.min(1, Math.max(0,
    (inputBytes - JAVA_TIMEOUT_LARGE_INPUT_BYTES) / (3 * JAVA_TIMEOUT_INPUT_STEP_BYTES)));
  return Math.round(JAVA_EXEC_TIMEOUT_MS + progress * (JAVA_TIMEOUT_MAX_MS - JAVA_EXEC_TIMEOUT_MS));
}

let javaWorker = null;
let javaReadyPromise = null;
let javaInitMs = null;
let javaInterruptBuf = null; // Int32Array(SharedArrayBuffer)
let javaRequestSequence = 1;
let javaRuntimeStatus = 'idle'; // idle | loading | preparing | ready | error
let javaAssetsReadyPromise = null;
const javaStatusListeners = new Set();

function setJavaStatus(s) {
  if (javaRuntimeStatus === s) return;
  javaRuntimeStatus = s;
  javaStatusListeners.forEach(function (fn) { try { fn(s); } catch (_) { /* ignore */ } });
}
/** 注册 Java Runtime 状态监听（UI 状态标签用）。返回注销函数。 */
function onJavaStatus(fn) {
  javaStatusListeners.add(fn);
  try { fn(javaRuntimeStatus); } catch (_) { /* ignore */ }
  return function () { javaStatusListeners.delete(fn); };
}

function javaProgress(stage, extra) {
  const snap = Object.assign({
    runtimeId: JAVA_RUNTIME_ID_PRIMARY,
    stage: stage,
    percent: -1,
    indeterminate: true
  }, extra || {});
  broadcastProgress(snap);
}

async function consumeJavaAsset(url, options, onChunk) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const body = await response.arrayBuffer();
    onChunk(body.byteLength);
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const part = await reader.read();
    if (part.done) return;
    if (part.value) onChunk(part.value.byteLength);
  }
}

/**
 * 在主页面预取 Java 冻结资产并上报真实字节进度。Worker/loader 随后的
 * force-cache 请求会复用同源 HTTP 缓存；不修改 BrowserJDK v2 二进制、
 * manifest 或 loader，也不上传源码和 stdin。
 */
function preloadJavaRuntimeAssets(forceReload) {
  if (forceReload) javaAssetsReadyPromise = null;
  if (javaAssetsReadyPromise) return javaAssetsReadyPromise;

  const attempt = (async function () {
    javaProgress('CHECK_CACHE', {message: '检查 Java 21 Runtime 缓存'});
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(function () { controller.abort(); }, JAVA_ASSET_TIMEOUT_MS) : null;
    const fetchOptions = {cache: forceReload ? 'reload' : 'force-cache'};
    if (controller) fetchOptions.signal = controller.signal;
    try {
      const manifestResponse = await fetch(JAVA_RUNTIME_MANIFEST_URL, Object.assign({}, fetchOptions, {cache: 'no-store'}));
      if (!manifestResponse.ok) throw new Error('HTTP ' + manifestResponse.status + ' runtime-manifest.json');
      const manifest = await manifestResponse.json();
      if (manifest.runtimeId !== JAVA_RUNTIME_ID_PRIMARY || !Array.isArray(manifest.assets)) {
        throw new Error('Java Runtime manifest 不兼容');
      }
      const assets = manifest.assets.filter(function (asset) {
        return asset && asset.file && asset.file !== 'loader.mjs' && asset.file !== 'runtime-manifest.json';
      });
      const totalBytes = assets.reduce(function (sum, asset) { return sum + (Number(asset.bytes) || 0); }, 0);
      let loadedBytes = 0;
      for (const asset of assets) {
        await consumeJavaAsset(JAVA_RUNTIME_BASE_URL + asset.file, fetchOptions, function (size) {
          loadedBytes += size;
          javaProgress('DOWNLOAD_RUNTIME', {
            asset: asset.file,
            message: '首次约 30 MB，后续使用浏览器缓存 · ' + asset.file,
            loadedBytes: loadedBytes,
            totalBytes: totalBytes,
            percent: totalBytes > 0 ? Math.min(100, loadedBytes * 100 / totalBytes) : -1,
            indeterminate: totalBytes <= 0
          });
        });
      }
      javaProgress('INITIALIZE_WASM', {message: '资产已就绪，正在初始化 WebAssembly'});
      return manifest;
    } catch (error) {
      const message = error && error.name === 'AbortError'
        ? 'Java Runtime 下载超时，请检查网络后重试'
        : 'Java Runtime 资产加载失败：' + String(error && error.message || error);
      javaProgress('ERROR', {error: message, message: message});
      throw new Error(message);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  })();
  javaAssetsReadyPromise = attempt;
  attempt.catch(function () {
    if (javaAssetsReadyPromise === attempt) javaAssetsReadyPromise = null;
  });
  return attempt;
}

function disposeJavaWorker() {
  if (javaWorker) {
    try { javaWorker.postMessage({ type: 'dispose' }); } catch (_) { /* ignore */ }
    try { javaWorker.terminate(); } catch (_) { /* ignore */ }
  }
  javaWorker = null;
  javaReadyPromise = null;
  javaInitMs = null;
  javaInterruptBuf = null;
  javaRequestSequence = 1;
  setJavaStatus('idle');
}

/* Java Worker 内存/统计（诊断用） */
function javaStats() {
  const w = javaWorker;
  if (!w) return Promise.resolve({});
  return new Promise(function (resolve) {
    const timer = setTimeout(function () { resolve({}); }, 2000);
    const h = function (e) {
      if (e.data && e.data.type === 'stats') { clearTimeout(timer); w.removeEventListener('message', h); resolve(e.data); }
    };
    w.addEventListener('message', h);
    try { javaWorker.postMessage({ type: 'stats' }); } catch (_) { clearTimeout(timer); w.removeEventListener('message', h); resolve({}); }
  });
}

/** 懒加载常驻 Java Worker；READY 后缓存，页面生命周期内复用。 */
function ensureJavaWorker() {
  if (javaReadyPromise) return javaReadyPromise;
  setJavaStatus('loading');
  const attempt = preloadJavaRuntimeAssets(false).then(function () { return new Promise(function (resolve, reject) {
    let worker;
    try {
      worker = new Worker(JAVA_WORKER_URL, { type: 'module' });
    } catch (e) { reject(e); return; }
    javaWorker = worker;
    setJavaStatus('loading');
    // SAB interrupt（仅当 Environment Check 满足时启用；否则走 Local Timeout fallback）
    if (detectPythonInterruptCapability() === 'READY') {
      // 复用 SAB 检测（同样适用于 Java Worker）
      const sab = new SharedArrayBuffer(4);
      javaInterruptBuf = new Int32Array(sab);
    } else {
      javaInterruptBuf = null;
      console.warn('[ide-runner] SAB 不可用，Java Local Timeout 走 FALLBACK terminate 兜底');
    }
    const initStartedAt = performance.now();
    let lastInitStage = 'INITIALIZING_WASM';
    let ready = false;
    let timer = null;
    function cleanupInit() {
      if (timer) { clearTimeout(timer); timer = null; }
      worker.removeEventListener('message', onMsg);
    }
    function failInit(message, extra) {
      cleanupInit();
      worker.removeEventListener('error', onWorkerError);
      javaProgress('ERROR', Object.assign({error: message, stage: lastInitStage}, extra || {}));
      disposeJavaWorker();
      setJavaStatus('error');
      reject(new Error(message));
    }
    function onWorkerError(e) {
      if (javaWorker !== worker) return;
      const message = 'Java Worker 异常: ' + (e.message || 'unknown');
      if (!ready) {
        failInit(message);
        return;
      }
      worker.removeEventListener('error', onWorkerError);
      javaProgress('ERROR', {error: message, stage: 'READY'});
      disposeJavaWorker();
      setJavaStatus('error');
    }
    timer = setTimeout(function () {
      const waitedMs = Math.max(0, Math.round(performance.now() - initStartedAt));
      const message = 'Java Runtime 初始化超时：阶段 ' + lastInitStage + '，已等待 ' + waitedMs + 'ms';
      failInit(message, {waitedMs: waitedMs});
    }, JAVA_INIT_TIMEOUT_MS);
    function onMsg(e) {
      if (javaWorker !== worker) return;
      const d = e.data;
      if (!d) return;
      if (d.type === 'state') {
        if (d.state === 'INITIALIZING_WASM') {
          lastInitStage = 'INITIALIZING_WASM';
          javaProgress('INITIALIZE_WASM', {message: '正在加载 BrowserJDK WebAssembly'});
        } else if (d.state === 'BOOTING_JVM') {
          lastInitStage = 'BOOT_JVM';
          javaProgress('BOOT_JVM', {message: '正在启动 OpenJDK 21 与 JavaCompiler，移动设备可能需要较长时间'});
        }
        return;
      }
      if (d.type === 'inited') {
        if (d.runtimeId !== JAVA_RUNTIME_ID_PRIMARY) {
          const actualRuntimeId = d.runtimeId == null ? '(missing)' : String(d.runtimeId);
          failInit('Java Runtime runtimeId 不匹配：收到 ' + actualRuntimeId + '，期望 ' + JAVA_RUNTIME_ID_PRIMARY);
          return;
        }
        cleanupInit();
        ready = true;
        javaInitMs = d.initMs;
        setJavaStatus('ready');
        javaProgress('READY', {percent: 100, indeterminate: false, message: 'Java 21 Runtime 已就绪'});
        console.debug('[ide-runner] Java Runtime READY', { runtimeId: d.runtimeId, javaVersion: d.javaVersion, initMs: d.initMs, source: d.runtimeSource, warning: d.warning });
        resolve(worker);
      } else if (d.type === 'init-failed' || d.type === 'error') {
        failInit('Java Runtime 初始化失败: ' + (d.error || d.message || 'unknown'));
      }
    }
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onWorkerError);
    try {
      worker.postMessage({ type: 'init', interruptBuffer: javaInterruptBuf, bootTimeoutMs: JAVA_WORKER_BOOT_TIMEOUT_MS });
      setJavaStatus('preparing');
    } catch (e) {
      console.error('[ide-runner] Java Worker postMessage 失败:', e && e.message, e && e.stack);
      failInit('Java Worker postMessage 失败: ' + (e && e.message || e));
    }
  }); });
  javaReadyPromise = attempt;
  attempt.catch(function () {
    setJavaStatus('error');
    if (javaReadyPromise === attempt) javaReadyPromise = null;
  });
  return attempt;
}

function retryJavaRuntime() {
  disposeJavaWorker();
  setJavaStatus('loading');
  return preloadJavaRuntimeAssets(false).then(function () { return ensureJavaWorker(); });
}

async function runJava(opts) {
  const killers = opts.killers || null;
  const t0 = performance.now();
  const timeoutMs = resolveJavaTimeoutMs(opts);
  const timing = {
    cacheHit: false, hash: '', optLevel: null, pchUsed: false,
    runtimeLoadMs: 0, compileTime: 0, executionTime: 0, resetMs: 0,
    interruptUsed: false, totalMs: 0
  };
  const source = opts.source != null ? opts.source : (opts.code || '');

  let worker;
  try {
    worker = await ensureJavaWorker();
  } catch (e) {
    timing.totalMs = Math.round(performance.now() - t0);
    return {
      compileFailed: true, stage: 'java-init',
      stdout: '', stderr: 'Java 本地运行环境不可用：' + (e && e.message || e) + '\n[重试]',
      exitCode: -1, executionMs: 0, timeMs: timing.totalMs, timing: timing,
      language: 'java', runtimeId: JAVA_RUNTIME_ID_PRIMARY,
      compileStatus: 'SKIP', runStatus: 'UNAVAILABLE',
      reason: 'RUNTIME_LOAD_FAILED',
      cacheHit: false
    };
  }
  timing.runtimeLoadMs = javaInitMs || 0;

  const codeHash = await sha256Hex(source);
  timing.hash = codeHash.slice(0, 8);

  const result = await new Promise(function (resolve) {
    let settled = false;
    let timer = null;
    let graceTimer = null;
    let killFn = null;
    const requestId = javaRequestSequence++;

    function finish(r) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      if (killFn && Array.isArray(killers)) {
        const i = killers.indexOf(killFn);
        if (i >= 0) killers.splice(i, 1);
      }
      resolve(r);
    }
    function onMsg(e) {
      const d = e.data;
      if (!d || d.type !== 'run-result' || !d.result) return;
      if (d.result.requestId !== requestId) return;
      finish(d.result);
    }
    function onErr(e) {
      finish({
        status: 'crash', compileStatus: 'SKIP', runStatus: 'ABORTED',
        stdout: '', stderr: 'Java Worker 异常: ' + (e.message || 'unknown'),
        exitCode: -1, compileTime: 0, executionTime: 0, cacheHit: false, error: e.message
      });
    }
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);

    if (Array.isArray(killers)) {
      killFn = function () {
        disposeJavaWorker();
        finish({
          status: 'aborted', compileStatus: 'SKIP', runStatus: 'ABORTED',
          stdout: '', stderr: '', exitCode: -1, compileTime: 0, executionTime: 0, cacheHit: false, aborted: true
        });
      };
      killers.push(killFn);
    }

    timer = setTimeout(function () {
      timing.interruptUsed = true;
      // 与 Python 一致的策略：READY → SAB interrupt + grace；FALLBACK → 直接 terminate
      if (detectPythonInterruptCapability() === 'READY' && javaInterruptBuf) {
        try { Atomics.store(javaInterruptBuf, 0, 2); } catch (_) { /* ignore */ }
        graceTimer = setTimeout(function () {
          console.warn('[ide-runner] Java 执行超时且 interrupt 未生效，terminate + 重建 Worker');
          disposeJavaWorker();
          finish({
            status: 'timeout', compileStatus: 'PASS', runStatus: 'LOCAL_TIMEOUT',
            stdout: '', stderr: '本地运行超时（' + timeoutMs + 'ms）已终止。Local Timeout 仅本地调试保护，正式 TLE 以服务器 Judge 为准。',
            exitCode: -1, compileTime: 0, executionTime: timeoutMs, cacheHit: false, timedOut: true
          });
        }, JAVA_INTERRUPT_GRACE_MS);
      } else {
        console.warn('[ide-runner] Java 执行超时（SAB 不可用，FALLBACK）：terminate + 重建 Worker');
        disposeJavaWorker();
        finish({
          status: 'timeout', compileStatus: 'PASS', runStatus: 'LOCAL_TIMEOUT',
          stdout: '', stderr: '本地运行超时（' + timeoutMs + 'ms）已终止（当前环境不支持 SAB 中断，已强制终止 Worker）。Local Timeout 仅本地调试保护，正式 TLE 以服务器 Judge 为准。',
          exitCode: -1, compileTime: 0, executionTime: timeoutMs, cacheHit: false, timedOut: true
        });
      }
    }, timeoutMs);

    try {
      worker.postMessage({ type: 'run', requestId: requestId, source: source, sourceHash: codeHash,
        stdin: opts.stdin || '', timeoutMs: timeoutMs });
    } catch (e) {
      finish({
        status: 'crash', compileStatus: 'SKIP', runStatus: 'ABORTED',
        stdout: '', stderr: 'Java Worker 发送失败: ' + (e && e.message || e),
        exitCode: -1, compileTime: 0, executionTime: 0, cacheHit: false, error: e && e.message
      });
    }
  });

  timing.cacheHit = !!result.cacheHit;
  timing.compileTime = result.compileTime || 0;
  timing.executionTime = result.executionTime || 0;
  timing.resetMs = result.resetMs || 0;
  timing.totalMs = Math.round(performance.now() - t0);

  const compileFailed = result.status === 'ce';
  const actualRuntimeId = (result && result.runtimeId) || JAVA_RUNTIME_ID_PRIMARY;
  return {
    language: 'java', runtimeId: actualRuntimeId,
    compileFailed: compileFailed,
    compileStatus: compileFailed ? 'CE' : (result.cacheHit ? 'SKIP' : 'PASS'),
    compileTime: result.compileTime || 0,
    runStatus: compileFailed ? 'CE' : (result.runStatus || (result.status === 'timeout' ? 'LOCAL_TIMEOUT' : (result.status === 'aborted' || result.status === 'crash' ? 'ABORTED' : 'PASS'))),
    executionTime: result.executionTime || 0,
    stdout: result.stdout || '', stderr: result.stderr || '',
    exitCode: result.exitCode != null ? result.exitCode : -1,
    reason: result.reason || null,
    outputTruncated: !!result.outputTruncated,
    timedOut: !!result.timedOut || result.status === 'interrupted',
    aborted: !!result.aborted,
    executionMs: result.executionTime || 0, timeMs: timing.totalMs, timing: timing,
    cacheHit: !!result.cacheHit, linkTime: null,
    tracebackClass: result.tracebackClass || null, ce: result.ce || null
  };
}
/* Persistent Python Web Worker：页面生命周期常驻，禁止每次 Run 重新加载 WASM。
 *  - 懒加载：首次选择 Python 或 prewarm('python') 时创建 Worker + 初始化 CPython；
 *    之后所有 Run 复用同一解释器（Runtime Init Time 不计入运行时间）。
 *  - Compile Once, Run Many：sourceHash → code object 缓存（Worker 内存级，cap=4）。
 *  - Run Isolation：每次 Run 前执行 P0 Reset（fresh globals / stdin·out·err 重建 /
 *    sys.argv·path·recursionlimit·cwd 恢复 / sys.modules·builtins 清理 / random 重播种）。
 *  - 超时保护：EXEC_TIMEOUT_MS 后置 SAB interrupt → KeyboardInterrupt；
 *    宽限期仍无响应 → terminate + 重建 Worker，绝不卡死主 UI。
 */
let pythonWorker = null;
let pythonReadyPromise = null;
let pythonInitMs = null;        // 首次初始化耗时（含 pyodide 下载+CPython 初始化）
let pythonInterruptBuf = null;  // Int32Array(SharedArrayBuffer)
let pythonRuntimeStatus = 'idle'; // idle | loading | preparing | ready | error
const pythonStatusListeners = new Set();

function setPythonStatus(s) {
  if (pythonRuntimeStatus === s) return;
  pythonRuntimeStatus = s;
  pythonStatusListeners.forEach(function (fn) { try { fn(s); } catch (_) { /* ignore */ } });
}
/** 注册 Python Runtime 状态监听（UI 状态标签用）。返回注销函数。 */
function onPythonStatus(fn) {
  pythonStatusListeners.add(fn);
  return function () { pythonStatusListeners.delete(fn); };
}

function disposePythonWorker() {
  if (pythonWorker) {
    // 先异步清空 Worker 内 code object PyProxy（释放 WASM/Python 对象），再 terminate
    try { pythonWorker.postMessage({ type: 'clear-cache' }); } catch (_) { /* ignore */ }
    try { pythonWorker.terminate(); } catch (_) { /* ignore */ }
  }
  pythonWorker = null;
  pythonReadyPromise = null;
  pythonInitMs = null;
  pythonInterruptBuf = null;
  setPythonStatus('idle');
}

/* Python Worker 内存/代理统计（内存压力测试与诊断用）。
 * 依赖 Worker 的 stats 消息；Worker 未就绪或超时返回空对象。 */
function pythonStats() {
  const w = pythonWorker;
  if (!w) return Promise.resolve({});
  return new Promise(function (resolve) {
    const timer = setTimeout(function () { resolve({}); }, 2000);
    const h = function (e) {
      if (e.data && e.data.type === 'stats') { clearTimeout(timer); w.removeEventListener('message', h); resolve(e.data); }
    };
    w.addEventListener('message', h);
    try { w.postMessage({ type: 'stats' }); } catch (_) { clearTimeout(timer); w.removeEventListener('message', h); resolve({}); }
  });
}

/** 懒加载常驻 Python Worker；READY 后缓存，页面生命周期内复用。 */
function ensurePythonWorker() {
  if (pythonReadyPromise) return pythonReadyPromise;
  pythonReadyPromise = new Promise(function (resolve, reject) {
    let worker;
    try {
      worker = new Worker(PY_WORKER_URL, { type: 'module' });
    } catch (e) { reject(e); return; }
    pythonWorker = worker;
    setPythonStatus('loading');
    // 仅当 Environment Check 通过（SAB+crossOriginIsolated+Atomics）才创建 SAB 中断缓冲区；
    // 否则用 Local Timeout → terminate + 重建的 FALLBACK 策略（见 runPython 超时分支）。
    if (detectPythonInterruptCapability() === 'READY') {
      const sab = new SharedArrayBuffer(4);
      pythonInterruptBuf = new Int32Array(sab);
    } else {
      pythonInterruptBuf = null;
      console.warn('[ide-runner] crossOriginIsolated/SAB 不可用，Python 无限循环走 FALLBACK terminate 兜底');
    }
    const timer = setTimeout(function () {
      cleanup();
      disposePythonWorker();
      reject(new Error('Python Runtime 初始化超时'));
    }, PY_INIT_TIMEOUT_MS);
    function cleanup() {
      clearTimeout(timer);
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
    }
    function onMsg(e) {
      const d = e.data;
      if (!d) return;
      if (d.type === 'inited') {
        cleanup();
        pythonInitMs = d.initMs;
        setPythonStatus('ready');
        console.debug('[ide-runner] Python Runtime READY', { pythonVersion: d.pythonVersion, initMs: d.initMs });
        resolve(worker);
      } else if (d.type === 'init-failed') {
        cleanup();
        disposePythonWorker();
        setPythonStatus('error');
        reject(new Error('Python Runtime 初始化失败: ' + (d.error || 'unknown')));
      }
    }
    function onErr(e) {
      cleanup();
      disposePythonWorker();
      setPythonStatus('error');
      reject(new Error('Python Worker 异常: ' + (e.message || 'unknown')));
    }
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
    try {
      // SharedArrayBuffer 不可 transfer，结构化克隆即共享同一内存（Pyodide interrupt 标准用法）
      worker.postMessage({ type: 'init', interruptBuffer: pythonInterruptBuf });
      setPythonStatus('preparing'); // worker 已创建，CPython 初始化中
    } catch (e) {
      console.error('[ide-runner] Python Worker postMessage 失败:', e && e.message, e && e.stack);
      cleanup();
      disposePythonWorker();
      setPythonStatus('error');
      reject(e);
    }
  });
  pythonReadyPromise.catch(function () { /* 状态已在失败路径处理 */ });
  return pythonReadyPromise;
}

async function runPython(opts) {
  const killers = opts.killers || null;
  const t0 = performance.now();
  const timing = {
    cacheHit: false, hash: '', optLevel: null, pchUsed: false,
    runtimeLoadMs: 0, compileTime: 0, executionTime: 0, resetMs: 0,
    interruptUsed: false, totalMs: 0
  };
  const source = opts.source != null ? opts.source : (opts.code || '');

  let worker;
  try {
    worker = await ensurePythonWorker();
  } catch (e) {
    timing.totalMs = Math.round(performance.now() - t0);
    return {
      compileFailed: true, stage: 'python-init',
      stdout: '', stderr: 'Python Runtime 加载失败：' + (e && e.message || e),
      exitCode: -1, executionMs: 0, timeMs: timing.totalMs, timing: timing
    };
  }
  timing.runtimeLoadMs = pythonInitMs || 0;

  const codeHash = await sha256Hex(source);
  timing.hash = codeHash.slice(0, 8);

  const result = await new Promise(function (resolve) {
    let settled = false;
    let timer = null;
    let graceTimer = null;
    let killFn = null;

    function finish(r) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      if (killFn && Array.isArray(killers)) {
        const i = killers.indexOf(killFn);
        if (i >= 0) killers.splice(i, 1);
      }
      resolve(r);
    }
    function onMsg(e) {
      const d = e.data;
      if (!d || d.type !== 'run-result' || !d.result) return;
      finish(d.result);
    }
    function onErr(e) {
      finish({
        status: 'crash', compileStatus: 'SKIP', runStatus: 'ABORTED',
        stdout: '', stderr: 'Python Worker 异常: ' + (e.message || 'unknown'),
        exitCode: -1, compileTime: 0, executionTime: 0, cacheHit: false, error: e.message
      });
    }
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);

    // 用户中断（再次点击"运行"）：terminate + 重建，下次 Run 自动重新初始化
    if (Array.isArray(killers)) {
      killFn = function () {
        disposePythonWorker();
        finish({
          status: 'aborted', compileStatus: 'SKIP', runStatus: 'ABORTED',
          stdout: '', stderr: '', exitCode: -1, compileTime: 0, executionTime: 0, cacheHit: false, aborted: true
        });
      };
      killers.push(killFn);
    }

    timer = setTimeout(function () {
      // 本地超时保护：
      //  READY   —— SAB interrupt（KeyboardInterrupt），宽限期后硬终止 + 重建
      //  FALLBACK—— 无 SAB 可用：不等待，直接 Local Timeout → terminate + 重建 Worker
      timing.interruptUsed = true;
      if (detectPythonInterruptCapability() === 'READY' && pythonInterruptBuf) {
        try { Atomics.store(pythonInterruptBuf, 0, 2); } catch (_) { /* ignore */ }
        graceTimer = setTimeout(function () {
          console.warn('[ide-runner] Python 执行超时且 interrupt 未生效，terminate + 重建 Worker');
          disposePythonWorker();
          finish({
            status: 'timeout', compileStatus: 'SKIP', runStatus: 'LOCAL_TIMEOUT',
            stdout: '', stderr: '本地运行超时（' + EXEC_TIMEOUT_MS + 'ms）已终止。Local Timeout 仅本地调试保护，正式 TLE 以服务器 Judge 为准。',
            exitCode: -1, compileTime: 0, executionTime: EXEC_TIMEOUT_MS, cacheHit: false, timedOut: true
          });
        }, PY_INTERRUPT_GRACE_MS);
      } else {
        console.warn('[ide-runner] Python 执行超时（SAB 不可用，FALLBACK）：terminate + 重建 Worker');
        disposePythonWorker();
        finish({
          status: 'timeout', compileStatus: 'SKIP', runStatus: 'LOCAL_TIMEOUT',
          stdout: '', stderr: '本地运行超时（' + PY_FALLBACK_TIMEOUT_MS + 'ms）已终止（当前环境不支持 SAB 中断，已强制终止 Worker）。Local Timeout 仅本地调试保护，正式 TLE 以服务器 Judge 为准。',
          exitCode: -1, compileTime: 0, executionTime: PY_FALLBACK_TIMEOUT_MS, cacheHit: false, timedOut: true
        });
      }
    }, EXEC_TIMEOUT_MS);

    try {
      worker.postMessage({ type: 'run', source: source, sourceHash: codeHash, stdin: opts.stdin || '' });
    } catch (e) {
      finish({
        status: 'crash', compileStatus: 'SKIP', runStatus: 'ABORTED',
        stdout: '', stderr: 'Python Worker 发送失败: ' + (e && e.message || e),
        exitCode: -1, compileTime: 0, executionTime: 0, cacheHit: false, error: e && e.message
      });
    }
  });

  timing.cacheHit = !!result.cacheHit;
  timing.compileTime = result.compileTime || 0;
  timing.executionTime = result.executionTime || 0;
  timing.resetMs = result.resetMs || 0;
  timing.totalMs = Math.round(performance.now() - t0);

  const compileFailed = result.status === 'ce';
  return {
    language: 'python', runtimeId: PY_RUNTIME_ID,
    compileFailed: compileFailed,
    compileStatus: compileFailed ? 'CE' : (result.cacheHit ? 'SKIP' : 'PASS'),
    compileTime: result.compileTime || 0,
    runStatus: compileFailed ? 'CE' : (result.runStatus || 'PASS'), executionTime: result.executionTime || 0,
    stdout: result.stdout || '', stderr: result.stderr || '',
    exitCode: result.exitCode != null ? result.exitCode : -1,
    reason: result.reason || null,
    outputTruncated: !!result.outputTruncated,
    timedOut: !!result.timedOut || result.status === 'interrupted', aborted: !!result.aborted,
    executionMs: result.executionTime || 0, timeMs: timing.totalMs, timing: timing,
    cacheHit: !!result.cacheHit, linkTime: null,
    tracebackClass: result.tracebackClass || null, ce: result.ce || null
  };
}

/* ---------------- 统一分发：RuntimeManager.runCode({language, source, stdin}) ----------------
 * c/cpp → runC（Clang/WASI 编译型，冻结不变）
 * python/python3 → runPython（Pyodide 解释型，Persistent Worker）
 * java/java21 → runJava（self-built browserjdk-oj，Persistent Worker，
 *                         禁止 Server Fallback；Local 失败显示"Java 本地运行环境不可用 [重试]"）
 * 公共结果格式统一：{language, runtimeId, compileStatus, compileTime, runStatus,
 * executionTime, stdout, stderr, cacheHit, linkTime}；Python/Java linkTime=null。
 */
async function runCode(opts) {
  opts = opts || {};
  const stdinBytes = utf8ByteLength(opts.stdin);
  if (stdinBytes > MAX_STDIN_BYTES) {
    return normalizeBrowserRunResult(createLocalInputLimitResult(opts, stdinBytes), opts);
  }
  const lang = opts.language || opts.lang || 'python';
  const requestedProfile = String(opts.profileId || '');
  // Modern profiles are deliberately routed before the frozen C/C++ branch.
  // A missing/failed modern runtime is surfaced as an error; it must never fall back to Clang 8.
  if (lang === 'c17' || lang === 'cpp17' || opts.profileId === 'c17-gcc14-compat-v1' ||
      opts.profileId === 'cpp17-gcc14-compat-v1' || opts.profileId === 'c17-gcc14-compat-v2' ||
      opts.profileId === 'cpp17-gcc14-compat-v2') {
    return normalizeBrowserRunResult(await runModern(opts), opts);
  }
  // Phase 8 Checkpoint 2 deliberately does not implement C++20/C++23. Keep these
  // profiles pending even when a caller bypasses the disabled selector; they
  // must never silently fall through to the frozen Clang 8 C++11 path.
  if (lang === 'cpp20' || lang === 'cpp23' || requestedProfile === 'cpp20-gcc14-compat-v1' ||
      requestedProfile === 'cpp23-gcc14-compat-v1') {
    const profileId = requestedProfile || (lang === 'cpp20' ? 'cpp20-gcc14-compat-v1' : 'cpp23-gcc14-compat-v1');
    return normalizeBrowserRunResult({
      language: 'cpp', runtimeId: profileId, profileId,
      compileStatus: 'PENDING', compileTime: 0,
      runStatus: 'UNAVAILABLE', executionTime: 0,
      stdout: '', stderr: 'C++20/C++23 remain PENDING in Phase 8 Checkpoint 2; Browser Local is not enabled.',
      cacheHit: false, linkTime: 0, timedOut: false, aborted: false, exitCode: -1,
      outputTruncated: false, compileFailed: true, failureLayer: 'profile'
    }, opts);
  }
  // Java 21 Browser Local：Phase 7 Checkpoint 2 self-built v2 runtime。
  // 严禁自动 POST source 到服务器帮用户运行（无 Server Fallback），正式提交仍正常走 server OpenJDK 21；
  // 法律/项目负责人审核前 redistributable=false。
  if (lang === 'java' || lang === 'java21') {
    const r = await runJava(opts);
    return normalizeBrowserRunResult({
      language: 'java', runtimeId: r.runtimeId,
      compileStatus: r.compileStatus, compileTime: r.compileTime,
      runStatus: r.runStatus, executionTime: r.executionTime,
      stdout: r.stdout, stderr: r.stderr, cacheHit: r.cacheHit,
      linkTime: null, timedOut: r.timedOut, aborted: r.aborted, exitCode: r.exitCode,
      reason: r.reason || null,
      outputTruncated: !!r.outputTruncated,
      tracebackClass: r.tracebackClass, ce: r.ce,
      timing: r.timing, executionMs: r.executionMs, timeMs: r.timeMs, compileFailed: r.compileFailed
    }, opts);
  }
  if (lang === 'python' || lang === 'python3') {
    const r = await runPython(opts);
    return normalizeBrowserRunResult({
      language: 'python', runtimeId: r.runtimeId,
      compileStatus: r.compileStatus, compileTime: r.compileTime,
      runStatus: r.runStatus, executionTime: r.executionTime,
      stdout: r.stdout, stderr: r.stderr, cacheHit: r.cacheHit,
      linkTime: null, timedOut: r.timedOut, aborted: r.aborted, exitCode: r.exitCode,
      reason: r.reason || null,
      outputTruncated: !!r.outputTruncated,
      tracebackClass: r.tracebackClass, ce: r.ce,
      timing: r.timing, executionMs: r.executionMs, timeMs: r.timeMs, compileFailed: r.compileFailed
    }, opts);
  }
  const isC = lang === 'c';
  const r = await runC({
    code: opts.source != null ? opts.source : (opts.code || ''),
    lang: isC ? 'c' : 'cpp',
    stdin: opts.stdin || '',
    optLevel: opts.optLevel || '-O0',
    pchLevel: opts.pchLevel || 'auto',
    killers: opts.killers || null
  });
  return normalizeBrowserRunResult({
    language: isC ? 'c' : 'cpp', runtimeId: runtimeIds[isC ? 'c' : 'cpp'],
    compileStatus: r.compileFailed ? 'CE' : 'PASS',
    compileTime: (r.timing && r.timing.compileMs) || 0,
    runStatus: r.timedOut ? 'LOCAL_TIMEOUT' : (r.aborted ? 'ABORTED' : (r.compileFailed ? 'CE' : (r.runStatus || (r.runtimeError ? 'RE' : 'PASS')))),
    executionTime: r.executionMs != null ? r.executionMs : 0,
    stdout: r.stdout || '', stderr: r.stderr || '',
    cacheHit: !!(r.timing && r.timing.cacheHit),
    linkTime: (r.timing && r.timing.linkMs != null) ? r.timing.linkMs : 0,
    timedOut: !!r.timedOut, aborted: !!r.aborted, runtimeError: !!r.runtimeError, exitCode: r.exitCode,
    outputTruncated: !!r.outputTruncated,
    timing: r.timing, executionMs: r.executionMs, timeMs: r.timeMs, compileFailed: r.compileFailed
  }, opts);
}

/* ---------------- 后台 speculative compile（编辑停止后预编译，错误静默） ---------------- */
let lastSpeculatedKey = '';

async function speculate(opts) {
  try {
    if (opts.lang === 'c17' || opts.lang === 'cpp17' || opts.lang === 'cpp20' || opts.lang === 'cpp23') return;
    const lang = opts.lang === 'c' ? 'c' : 'cpp';
    if (lang === 'python') return;
    const profile = lang === 'c' ? LANG_PROFILES.c11 : LANG_PROFILES.cpp11;
    const optLevel = VALID_OPTS[opts.optLevel] ? opts.optLevel : '-O0';
    const pchLevel = resolvePchLevel(opts.code, lang, opts);
    const code = opts.code || '';
    if (!code.trim() || code.length > 200 * 1024) return;
    // 与 runC 一致的 longDouble 决定（C11 默认启用），保证 artifact key 匹配
    const longDouble = (opts.longDouble !== undefined) ? !!opts.longDouble : (profile.defaultLongDouble === true);
    const key = artifactKey(lang, optLevel, pchLevel, await sha256Hex(code), longDouble);
    if (artifactCache.has(key) || key === lastSpeculatedKey) return;
    lastSpeculatedKey = key;
    // GCC11 Header Strict Check：失败则不预编译（运行时将由 runC 给出 Local CE）
    if (lang === 'cpp' && !opts.skipHeaderCheck) {
      const hc = await checkGcc11Headers({ code: code, lang: lang });
      if (!hc.ok) return;
    }
    const result = await enqueueCompile(key, function () {
      return compileInWorker({ type: 'compile', code: code, lang: lang, optLevel: optLevel, pchLevel: pchLevel, longDouble: longDouble });
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
    if (lang === 'python' || lang === 'python3') {
      // Python：懒加载 Persistent Worker（首次含 pyodide wasm 下载 + CPython 初始化）
      ensurePythonWorker().catch(function () { /* ignore */ });
    } else if (lang === 'java' || lang === 'java21') {
      // Java 21：懒加载 Persistent Worker（首次含 wasm 下载 + JVM/CompileServer 初始化）
      ensureJavaWorker().catch(function () { /* ignore */ });
    } else if (lang === 'c17' || lang === 'cpp17') {
      ensureModernWorker().catch(function () { /* surfaced when the user explicitly runs */ });
    } else if (lang === 'cpp20' || lang === 'cpp23') {
      // Pending profiles intentionally have no local prewarm path.
    } else {
      ensureCompiler().catch(function () { /* ignore */ });
    }
  } catch (_) { /* ignore */ }
}

/* ---------------- Runtime Loading Progress（Runtime Enhancement Phase） ----------------
 * 现代 Runtime（c17/cpp17/cpp20/cpp23）的真实字节进度上报管线。
 * 冻结 Runtime（c11/cpp11/python3）仍走旧 ensureCompiler/ensurePythonWorker，
 * 本函数只对外暴露订阅 API，UI 可订阅 onRuntimeProgress 渲染进度条。
 *
 * 依赖：runtime-assets.js（ES Module，独立）。动态 import 避免阻塞旧 Runtime 启动。
 */
const runtimeProgressListeners = new Set(); // fn(snapshot[])
const perRuntimeStates = new Map(); // runtimeId -> 最新 snapshot

async function importRuntimeAssets() {
  try {
    const mod = await import('/js/contest/runtime-assets.js');
    return mod;
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[ide-runner] runtime-assets 加载失败', e);
    return null;
  }
}

/** 订阅全局 Runtime Progress（所有 Runtime 的快照都会触发回调）。返回注销函数。 */
function onRuntimeProgress(fn) {
  runtimeProgressListeners.add(fn);
  // 立即推送已有快照，避免 UI 首帧空
  for (const snap of perRuntimeStates.values()) {
    try { fn([snap]); } catch (_) { /* ignore */ }
  }
  return function () { runtimeProgressListeners.delete(fn); };
}
function broadcastProgress(snap) {
  perRuntimeStates.set(snap.runtimeId, snap);
  const arr = Array.from(perRuntimeStates.values());
  runtimeProgressListeners.forEach(function (fn) { try { fn(arr); } catch (_) { /* ignore */ } });
}

/** 预热现代 Runtime 并上报进度。返回 { runtimeId, status }。 */
async function prewarmModernRuntime(runtimeId, options) {
  const mod = await importRuntimeAssets();
  if (!mod) return { runtimeId: runtimeId, status: 'UNAVAILABLE' };
  return mod.prewarmRuntime(runtimeId, Object.assign({}, options, {
    onProgress: function (snap) { broadcastProgress(snap); }
  }));
}

/** 重试：清空缓存后重新下载。 */
async function retryModernRuntime(runtimeId, options) {
  const mod = await importRuntimeAssets();
  if (!mod) return { runtimeId: runtimeId, status: 'UNAVAILABLE' };
  return mod.retryRuntime(runtimeId, Object.assign({}, options, {
    onProgress: function (snap) { broadcastProgress(snap); }
  }));
}

/** 探测某 Runtime 的当前 cache 状态（CACHED / NOT_CACHED / PARTIAL / UNAVAILABLE）。 */
async function probeRuntimeCache(runtimeId) {
  const mod = await importRuntimeAssets();
  if (!mod) return { runtimeId: runtimeId, status: 'UNAVAILABLE' };
  return mod.runtimeCacheStatus(runtimeId);
}

window.__IDE_RUNNER__ = {
  version: RUNNO_VERSION,
  runtimeIds: runtimeIds,
  status: 'P0 FROZEN',
  gccCompatVersion: gcc11CompatVersion,
  langProfiles: LANG_PROFILES,
  pythonProfile: { type: 'interpreter-wasm', runtimeId: PY_RUNTIME_ID, pythonVersion: '3.12.1', pyodideVersion: '0.26.4' },
  javaProfile: {
    type: 'interpreter-wasm-jvm', runtimeId: JAVA_RUNTIME_ID_PRIMARY,
    javaVersion: 'OpenJDK 21.0.10+7 (Zero)', runtimeSource: 'self-built BrowserJDK',
    status: 'BETA_FROZEN', runtimeAssetHash: 'eee8298d267c2ba781cc6db4d587e6a8a2a39ff8aac5692f1c3a3d01daee5878',
    technicalValidated: true, engineeringRedistributionReady: true,
    legalReviewRequired: true, redistributable: false
  },
  runC: runC,
  runPython: runPython,
  runJava: runJava,
  runModern: runModern,
  runCode: runCode,
  // Browser coverage helpers：纯函数，供回归测试和 UI 诊断复用
  utf8ByteLength: utf8ByteLength,
  createLocalInputLimitResult: createLocalInputLimitResult,
  normalizeLocalOutputLimitResult: normalizeLocalOutputLimitResult,
  javaScannerWarnings: javaScannerWarnings,
  normalizeBrowserRunResult: normalizeBrowserRunResult,
  speculate: speculate,
  prewarm: prewarm,
  checkGcc11Headers: checkGcc11Headers,
  onPythonStatus: onPythonStatus,
  onJavaStatus: onJavaStatus,
  retryJavaRuntime: retryJavaRuntime,
  // Runtime Enhancement Phase：现代 Runtime 真实进度 API
  onRuntimeProgress: onRuntimeProgress,
  prewarmModernRuntime: prewarmModernRuntime,
  retryModernRuntime: retryModernRuntime,
  probeRuntimeCache: probeRuntimeCache,
  pythonRuntimeStatus: function () { return pythonRuntimeStatus; },
  javaRuntimeStatus: function () { return javaRuntimeStatus; },
  // Interrupt 能力检测（同样适用于 Python/Java Worker；命名沿用 pythonInterruptStatus 保持向后兼容）：
  //   { capability: 'READY'|'FALLBACK', sharedArrayBuffer, crossOriginIsolated, atomics }
  pythonInterruptStatus: function () {
    const c = detectPythonInterruptCapability();
    return {
      capability: c,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
      atomics: typeof Atomics !== 'undefined' && typeof Atomics.store === 'function'
    };
  },
  javaInterruptStatus: function () {
    // 与 Python 共享同一 Environment Check 结论；Java Worker 同样使用该能力做 Local Timeout 兜底
    return this.pythonInterruptStatus();
  },
  pythonStats: function () { return pythonStats(); },
  javaStats: function () { return javaStats(); },
  modernStats: function () { return modernStats(); }
};

// 暴露 Worker 统计句柄给测试/诊断脚本
window.__PY_WORKER_STATS__ = function () { return pythonStats(); };
window.__JAVA_WORKER_STATS__ = function () { return javaStats(); };
window.dispatchEvent(new CustomEvent('ide-runner-ready'));
