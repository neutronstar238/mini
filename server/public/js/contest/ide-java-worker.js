/* Production Java 21 worker: self-built BrowserJDK only. */
const RUNTIME_ID = 'java21-browserjdk-compat-v2';
const LOADER_URL = '/runtime/java21-browserjdk-compat-v2/loader.mjs';
const LOCAL_TIMEOUT_MESSAGE = '本地运行超时仅用于调试保护，正式 TLE 以服务器 Judge 为准。';
const JAVA_TIMEOUT_DEFAULT_MS = 15000;
const JAVA_TIMEOUT_MIN_MS = 1000;
const JAVA_TIMEOUT_MAX_MS = 120000;
const JAVA_TIMEOUT_LARGE_INPUT_BYTES = 1024 * 1024;
const JAVA_TIMEOUT_LARGE_INPUT_BASE_MS = 60000;
const JAVA_TIMEOUT_INPUT_STEP_BYTES = 1024 * 1024;
const JAVA_TIMEOUT_INPUT_STEP_MS = 15000;
const JAVA_BOOT_TIMEOUT_MS = 180000;

const STATE = {
  NOT_LOADED: 'NOT_LOADED', INITIALIZING_WASM: 'INITIALIZING_WASM',
  BOOTING_JVM: 'BOOTING_JVM', READY: 'READY', RUNNING: 'RUNNING', FAILED: 'FAILED'
};

let state = STATE.NOT_LOADED;
let runtime = null;
let javaVersion = null;
let initMs = null;
let runCount = 0;
let cacheSize = 0;
let cacheCapacity = 8;
let externalInterrupt = null;
let initializePromise = null;
// The rings and CompileServer are single-run state. Queue run/dispose commands
// so two UI messages cannot reset stdin while the previous program is reading.
let commandTail = Promise.resolve();

function post(message) { self.postMessage(message); }
function withRequestId(result, message) {
  return message.requestId == null ? result : Object.assign({requestId: message.requestId}, result);
}
function normalizeJavaTimeoutMs(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return null;
  return Math.min(JAVA_TIMEOUT_MAX_MS, Math.max(JAVA_TIMEOUT_MIN_MS, Math.round(numeric)));
}
function javaInputByteLength(input) {
  return new TextEncoder().encode(String(input || '')).byteLength;
}
function resolveJavaTimeoutMs(message) {
  const requested = message.timeoutMs;
  if (requested != null) {
    const explicit = normalizeJavaTimeoutMs(requested);
    if (explicit != null) return explicit;
  }
  const inputBytes = javaInputByteLength(message.stdin);
  if (inputBytes <= JAVA_TIMEOUT_LARGE_INPUT_BYTES) return JAVA_TIMEOUT_DEFAULT_MS;
  const steps = Math.floor((inputBytes - JAVA_TIMEOUT_LARGE_INPUT_BYTES) / JAVA_TIMEOUT_INPUT_STEP_BYTES);
  return Math.min(JAVA_TIMEOUT_MAX_MS, JAVA_TIMEOUT_LARGE_INPUT_BASE_MS + steps * JAVA_TIMEOUT_INPUT_STEP_MS);
}
function setState(next) {
  state = next;
  post({type: 'state', state: next});
}

function resolveBootTimeoutMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : JAVA_BOOT_TIMEOUT_MS;
}

function initialize(bootTimeoutMs) {
  if (state === STATE.READY && runtime) return Promise.resolve();
  if (initializePromise) return initializePromise;

  const configuredBootTimeoutMs = resolveBootTimeoutMs(bootTimeoutMs);
  const attempt = (async function () {
    const started = performance.now();
    setState(STATE.INITIALIZING_WASM);
    let loader;
    try {
      loader = await import(LOADER_URL);
    } catch (error) {
      throw new Error('BUILD_REQUIRED / NOT_READY: self-built loader unavailable: ' + (error.message || error));
    }
    setState(STATE.BOOTING_JVM);
    const initialized = await loader.initialize({
      bootTimeoutMs: configuredBootTimeoutMs,
      onRuntimeStdout(text) { console.log('[BrowserJDK]', text); },
      onRuntimeStderr(text) { console.error('[BrowserJDK]', text); }
    });
    runtime = loader;
    javaVersion = initialized.javaVersion;
    try {
      const cache = runtime.cacheStats ? runtime.cacheStats() : null;
      cacheSize = Number(cache && cache.size) || 0;
      cacheCapacity = Number(cache && cache.capacity) || cacheCapacity;
    } catch (_) { /* diagnostics are optional */ }
    initMs = Math.round(performance.now() - started);
    setState(STATE.READY);
    post({
      type: 'inited', runtimeId: RUNTIME_ID, runtimeSource: 'self-built',
      javaVersion, initMs, redistributable: false
    });
  })();
  initializePromise = attempt;
  attempt.catch(function () {
    runtime = null;
    setState(STATE.FAILED);
    if (initializePromise === attempt) initializePromise = null;
  });
  return attempt;
}

async function run(message) {
  if ((!runtime || state !== STATE.READY) && (state === STATE.NOT_LOADED || state === STATE.FAILED)) {
    await initialize();
  }
  if (!runtime || state !== STATE.READY) {
    return {
      status: 'unavailable', compileStatus: 'SKIP', runStatus: 'UNAVAILABLE',
      stdout: '', stderr: 'BUILD_REQUIRED / NOT_READY', exitCode: -1,
      runtimeId: RUNTIME_ID, reason: 'BUILD_REQUIRED'
    };
  }
  setState(STATE.RUNNING);
  const timeoutMs = resolveJavaTimeoutMs(message);
  const interruptPoll = externalInterrupt instanceof Int32Array ? setInterval(function () {
    if (Atomics.exchange(externalInterrupt, 0, 0) !== 0 && runtime) runtime.interrupt();
  }, 8) : null;
  let failed = true;
  let rebuilt = false;
  try {
    const result = await runtime.run({
      source: String(message.source || ''), stdin: String(message.stdin || ''),
      className: String(message.className || 'Main'), timeoutMs: timeoutMs
    });
    if (Number.isFinite(Number(result.cacheSize))) cacheSize = Number(result.cacheSize);
    try {
      const cache = runtime.cacheStats ? runtime.cacheStats() : null;
      cacheSize = Number(cache && cache.size) || cacheSize;
      cacheCapacity = Number(cache && cache.capacity) || cacheCapacity;
    } catch (_) { /* diagnostics are optional */ }
    runCount++;
    const status = result.verdict === 'CE' ? 'ce' : (result.verdict === 'RE' ? 're' : 'ac');
    const cacheHit = !!result.cacheHit;
    failed = false;
    return {
      status,
      compileStatus: result.verdict === 'CE' ? 'CE' : (cacheHit ? 'SKIP' : 'PASS'),
      runStatus: result.verdict,
      stdout: result.stdout || '', stderr: result.stderr || '',
      exitCode: result.exitCode,
      compileTime: cacheHit ? 0 : (result.compileMs || 0),
      executionTime: result.executionMs || 0,
      tracebackClass: result.exceptionClass || null,
      runtimeId: RUNTIME_ID,
      cacheHit,
      cacheSize,
      outputTruncated: !!result.outputTruncated,
      sourceHash: result.sourceHash || null
    };
  } catch (error) {
    if (error && error.code === 'LOCAL_TIMEOUT') {
      /* The native interrupt is best effort. Dispose the interrupted module
       * so the next queued run will rebuild the worker/runtime automatically;
       * never reuse a JVM whose user code did not return. */
      try { await runtime.dispose(); } catch (_) { /* termination is fallback */ }
      runtime = null;
      initializePromise = null;
      rebuilt = true;
      failed = false;
      return {
        status: 'timeout', compileStatus: 'PASS', runStatus: 'LOCAL_TIMEOUT',
        stdout: '', stderr: LOCAL_TIMEOUT_MESSAGE, exitCode: -1,
        compileTime: 0, executionTime: timeoutMs, timeoutMs: timeoutMs,
        tracebackClass: null, runtimeId: RUNTIME_ID, cacheHit: false,
        timedOut: true, cacheSize: 0, outputTruncated: false
      };
    }
    throw error;
  } finally {
    if (interruptPoll) clearInterval(interruptPoll);
    if (rebuilt) {
      initializePromise = null;
      setState(STATE.NOT_LOADED);
    } else if (failed) {
      runtime = null;
      initializePromise = null;
      setState(STATE.FAILED);
    } else {
      setState(STATE.READY);
    }
  }
}

function enqueueCommand(task) {
  const next = commandTail.then(task, task);
  commandTail = next.catch(function () { /* keep the queue usable after one failure */ });
  return next;
}

self.addEventListener('message', async event => {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      externalInterrupt = message.interruptBuffer || null;
      await enqueueCommand(function () { return initialize(message.bootTimeoutMs); });
    } else if (message.type === 'run') {
      const result = await enqueueCommand(function () { return run(message); });
      post({type: 'run-result', result: withRequestId(result, message)});
    } else if (message.type === 'stats') {
      let memory = {linearMemoryBytes: 0, configuredMaximumBytes: 512 * 1024 * 1024};
      try { if (runtime && runtime.memoryStats) memory = runtime.memoryStats(); } catch (_) { /* optional */ }
      post({type: 'stats', state, runtimeId: RUNTIME_ID, javaVersion, initMs, runCount,
        cacheSize, cacheCapacity, ...memory});
    } else if (message.type === 'clear-cache') {
      await enqueueCommand(async function () {
        if (runtime) await runtime.dispose();
        runtime = null;
        cacheSize = 0;
        initializePromise = null;
        setState(STATE.NOT_LOADED);
        post({type: 'cache-cleared'});
      });
    } else if (message.type === 'interrupt') {
      if (runtime) runtime.interrupt();
    } else if (message.type === 'dispose') {
      await enqueueCommand(async function () {
        if (runtime) await runtime.dispose();
        runtime = null;
        cacheSize = 0;
        initializePromise = null;
        setState(STATE.NOT_LOADED);
        post({type: 'disposed'});
      });
    } else if (message.type === 'ping') {
      post({type: 'pong', state});
    }
  } catch (error) {
    const text = String(error && error.message || error);
    if (message.type === 'run') {
      // Always settle the caller's run promise. A bare `error` message would
      // leave ide-runner waiting until its timeout and make a protocol fault
      // look like a program TLE.
      post({type: 'run-result', result: {
        status: 'crash', compileStatus: 'SKIP', runStatus: 'UNAVAILABLE',
        stdout: '', stderr: text, exitCode: -1, compileTime: 0,
        executionTime: 0, cacheHit: false, runtimeId: RUNTIME_ID,
        reason: 'RUNTIME_ERROR', requestId: message.requestId, outputTruncated: false
      }});
    } else {
      post({
        type: message.type === 'init' ? 'init-failed' : 'error',
        error: text, message: text,
        stack: String(error && error.stack || '').slice(0, 1200)
      });
    }
  }
});
