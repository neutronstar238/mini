'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runner = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-runner.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../public/js/contest/problem-detail.js'), 'utf8');
const javaWorker = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-java-worker.js'), 'utf8');
const ONE_MIB = 1024 * 1024;
const FOUR_MIB = 4 * ONE_MIB;

function extractFunction(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `${name} must remain a function that can be behavior-tested`);

  const openBrace = source.indexOf('{', match.index + match[0].length);
  assert.notEqual(openBrace, -1, `${name} must have a function body`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return source.slice(match.index, i + 1);
  }
  assert.fail(`${name} function body is not balanced`);
}

function loadRunnerTimeoutHelpers() {
  const context = {
    TextEncoder,
    JAVA_EXEC_TIMEOUT_MS: 15000,
    JAVA_TIMEOUT_MIN_MS: 1000,
    JAVA_TIMEOUT_MAX_MS: 120000,
    JAVA_TIMEOUT_LARGE_INPUT_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_LARGE_INPUT_BASE_MS: 60000,
    JAVA_TIMEOUT_INPUT_STEP_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_INPUT_STEP_MS: 15000
  };
  const source = [
    extractFunction(runner, 'normalizeJavaTimeoutMs'),
    extractFunction(runner, 'javaInputByteLength'),
    extractFunction(runner, 'resolveJavaTimeoutMs')
  ].join('\n');
  vm.runInNewContext(`${source}\nthis.helpers = { normalizeJavaTimeoutMs, javaInputByteLength, resolveJavaTimeoutMs };`, context);
  return context.helpers;
}

function createJavaRunnerHarness() {
  const timers = new Map();
  const posted = [];
  const listeners = new Map();
  let nextTimerId = 1;
  const worker = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    postMessage(message) { posted.push(message); }
  };
  const context = {
    TextEncoder,
    performance: { now: () => 0 },
    ensureJavaWorker: () => Promise.resolve(worker),
    sha256Hex: async () => '0123456789abcdef',
    detectPythonInterruptCapability: () => 'FALLBACK',
    disposeJavaWorker: () => {},
    console: { warn() {}, debug() {}, error() {} },
    JAVA_RUNTIME_ID_PRIMARY: 'java21-browserjdk-compat-v2',
    JAVA_TIMEOUT_MIN_MS: 1000,
    JAVA_TIMEOUT_MAX_MS: 120000,
    JAVA_TIMEOUT_LARGE_INPUT_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_LARGE_INPUT_BASE_MS: 60000,
    JAVA_TIMEOUT_INPUT_STEP_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_INPUT_STEP_MS: 15000,
    JAVA_EXEC_TIMEOUT_MS: 15000,
    JAVA_INTERRUPT_GRACE_MS: 800,
    javaInterruptBuf: null,
    javaInitMs: 0,
    javaRequestSequence: 1,
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const source = [
    extractFunction(runner, 'normalizeJavaTimeoutMs'),
    extractFunction(runner, 'javaInputByteLength'),
    extractFunction(runner, 'resolveJavaTimeoutMs'),
    extractFunction(runner, 'runJava')
  ].join('\n');
  vm.runInNewContext(`${source}\nthis.runJava = runJava;`, context);
  return { context, timers, posted };
}

function createJavaLifecycleHarness(workerBehavior) {
  const timers = new Map();
  const workers = [];
  const progress = [];
  const preloadCalls = [];
  const statuses = [];
  let nextTimerId = 1;
  let nextWorkerId = 1;

  class FakeWorker {
    constructor() {
      this.id = nextWorkerId++;
      this.listeners = new Map();
      this.posted = [];
      this.terminated = false;
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type);
      if (handlers) handlers.delete(handler);
    }

    postMessage(message) {
      this.posted.push(message);
      if (workerBehavior) workerBehavior(this, message);
    }

    terminate() {
      this.terminated = true;
    }

    emit(type, data) {
      const handlers = this.listeners.get(type) || new Set();
      for (const handler of [...handlers]) handler(type === 'message' ? {data} : data);
    }

    listenerCount(type) {
      return (this.listeners.get(type) || new Set()).size;
    }
  }

  const context = {
    TextEncoder,
    SharedArrayBuffer,
    Int32Array,
    performance: {now: () => 0},
    console: {warn() {}, debug() {}, error() {}},
    JAVA_WORKER_URL: '/js/contest/ide-java-worker.js',
    JAVA_RUNTIME_ID_PRIMARY: 'java21-browserjdk-compat-v2',
    JAVA_WORKER_BOOT_TIMEOUT_MS: 180000,
    JAVA_INIT_TIMEOUT_MS: 195000,
    JAVA_TIMEOUT_MIN_MS: 1000,
    JAVA_TIMEOUT_MAX_MS: 120000,
    JAVA_TIMEOUT_LARGE_INPUT_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_INPUT_STEP_BYTES: 1024 * 1024,
    JAVA_EXEC_TIMEOUT_MS: 15000,
    JAVA_INTERRUPT_GRACE_MS: 800,
    javaInterruptBuf: null,
    javaInitMs: null,
    javaRequestSequence: 1,
    detectPythonInterruptCapability: () => 'FALLBACK',
    setJavaStatus(status) { statuses.push(status); },
    javaProgress(stage, extra) { progress.push(Object.assign({stage}, extra || {})); },
    preloadJavaRuntimeAssets(forceReload) {
      preloadCalls.push(forceReload);
      return Promise.resolve();
    },
    Worker: function Worker() {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    sha256Hex: async () => '0123456789abcdef'
  };

  const declarations = [
    'let javaWorker = null;',
    'let javaReadyPromise = null;',
    'let javaInitMs = null;',
    'let javaInterruptBuf = null;',
    'let javaRequestSequence = 1;',
    "let javaRuntimeStatus = 'idle';"
  ].join('\n');
  const source = [
    declarations,
    extractFunction(runner, 'normalizeJavaTimeoutMs'),
    extractFunction(runner, 'javaInputByteLength'),
    extractFunction(runner, 'resolveJavaTimeoutMs'),
    extractFunction(runner, 'disposeJavaWorker'),
    extractFunction(runner, 'ensureJavaWorker'),
    extractFunction(runner, 'runJava')
  ].join('\n');
  vm.runInNewContext(`${source}
    this.ensureJavaWorker = ensureJavaWorker;
    this.runJava = runJava;
  `, context);
  return {context, timers, workers, progress, preloadCalls, statuses};
}

function createJavaWorkerHarness(runtimeRun) {
  const context = {
    TextEncoder,
    console: { log() {}, warn() {}, error() {} },
    RUNTIME_ID: 'java21-browserjdk-compat-v2',
    LOCAL_TIMEOUT_MESSAGE: '本地运行超时仅用于调试保护，正式 TLE 以服务器 Judge 为准。',
    JAVA_TIMEOUT_DEFAULT_MS: 15000,
    JAVA_TIMEOUT_MIN_MS: 1000,
    JAVA_TIMEOUT_MAX_MS: 120000,
    JAVA_TIMEOUT_LARGE_INPUT_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_LARGE_INPUT_BASE_MS: 60000,
    JAVA_TIMEOUT_INPUT_STEP_BYTES: 1024 * 1024,
    JAVA_TIMEOUT_INPUT_STEP_MS: 15000,
    STATE: { NOT_LOADED: 'NOT_LOADED', FAILED: 'FAILED', READY: 'READY', RUNNING: 'RUNNING' },
    state: 'READY',
    runtime: { run: runtimeRun, dispose: async () => {} },
    externalInterrupt: null,
    cacheSize: 0,
    cacheCapacity: 8,
    runCount: 0,
    setState() {},
    setInterval() { return 1; },
    clearInterval() {}
  };
  const source = [
    extractFunction(javaWorker, 'normalizeJavaTimeoutMs'),
    extractFunction(javaWorker, 'javaInputByteLength'),
    extractFunction(javaWorker, 'resolveJavaTimeoutMs'),
    extractFunction(javaWorker, 'run')
  ].join('\n');
  vm.runInNewContext(`${source}\nthis.run = run;`, context);
  return context;
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('Java 21 preloads frozen assets with byte progress before JVM boot', () => {
  assert.match(runner, /function preloadJavaRuntimeAssets\(forceReload\)/);
  assert.match(runner, /javaProgress\('DOWNLOAD_RUNTIME'/);
  assert.match(runner, /loadedBytes:\s*loadedBytes/);
  assert.match(runner, /totalBytes:\s*totalBytes/);
  assert.match(runner, /javaProgress\('BOOT_JVM'/);
  assert.match(runner, /javaProgress\('READY'/);
  assert.match(runner, /preloadJavaRuntimeAssets\(false\)\.then/);
});

test('Java 21 progress failure has an explicit retry path', () => {
  assert.match(runner, /function retryJavaRuntime\(\)/);
  assert.match(runner, /retryJavaRuntime:\s*retryJavaRuntime/);
  assert.match(page, /rid === 'java21-browserjdk-compat-v2'/);
  assert.match(page, /window\.__IDE_RUNNER__\.retryJavaRuntime/);
});

test('running status and output header identify Java instead of Python', () => {
  assert.match(page, /if \(lang === 'java'\) return 'Java 21'/);
  assert.match(page, /准备 Java 21 Runtime，首次需下载约 30 MB 并启动 JVM/);
  assert.match(page, /r\.language === 'java' && t\.runtimeLoadMs/);
  assert.match(page, /\(isModernPreview \|\| lang === 'java'\) && !useRunner/);
  assert.match(page, /if \(!useRunner\) await ensureRunno\(\)/);
  assert.doesNotMatch(page, /\(isCpp \? 'C\/C\+\+' : 'Python'\)/);
});

test('Java timeout helper accepts direct and nested overrides and clamps to 1s-120s', () => {
  const { resolveJavaTimeoutMs } = loadRunnerTimeoutHelpers();
  const hugeInput = 'a'.repeat(FOUR_MIB + 1);

  assert.equal(resolveJavaTimeoutMs({ timeoutMs: 500 }), 1000);
  assert.equal(resolveJavaTimeoutMs({ timeoutMs: 4500 }), 4500);
  assert.equal(resolveJavaTimeoutMs({ timeoutMs: 200000 }), 120000);
  assert.equal(resolveJavaTimeoutMs({ runtimeConfig: { timeoutMs: 7000 } }), 7000);
  assert.equal(resolveJavaTimeoutMs({ timeoutMs: 9000, runtimeConfig: { timeoutMs: 7000 } }), 9000);
  assert.equal(resolveJavaTimeoutMs({ stdin: hugeInput, timeoutMs: 500 }), 1000);
  assert.equal(resolveJavaTimeoutMs({ stdin: hugeInput, timeoutMs: 200000 }), 120000);
  assert.equal(resolveJavaTimeoutMs({ stdin: hugeInput, runtimeConfig: { timeoutMs: 7000 } }), 7000);
});

test('Java timeout scales smoothly from 1 MiB to 4 MiB and caps above 4 MiB', () => {
  const { javaInputByteLength, resolveJavaTimeoutMs } = loadRunnerTimeoutHelpers();
  const input = bytes => 'a'.repeat(bytes);
  const oneMiB = resolveJavaTimeoutMs({ stdin: input(ONE_MIB) });
  const oneMiBPlusOne = resolveJavaTimeoutMs({ stdin: input(ONE_MIB + 1) });
  const twoPointFiveMiB = resolveJavaTimeoutMs({ stdin: input(2.5 * ONE_MIB) });
  const fourMiB = resolveJavaTimeoutMs({ stdin: input(FOUR_MIB) });
  const overFourMiB = resolveJavaTimeoutMs({ stdin: input(FOUR_MIB + 1) });
  const largeUtf8 = '汉'.repeat(400000);

  assert.equal(oneMiB, 15000);
  assert.ok(oneMiBPlusOne >= oneMiB && oneMiBPlusOne < 60000,
    '1 MiB + 1 byte must not jump to the 60s bucket');
  assert.ok(oneMiBPlusOne - oneMiB <= 1000,
    '1 MiB + 1 byte should only add a small amount of timeout');
  assert.ok(Math.abs(twoPointFiveMiB - 67500) <= 5000,
    '2.5 MiB should be near the midpoint between 15s and 120s');
  assert.equal(fourMiB, 120000);
  assert.equal(overFourMiB, 120000);
  assert.equal(javaInputByteLength(largeUtf8), largeUtf8.length * 3);
});

test('Java Runner local timeout returns LOCAL_TIMEOUT and forwards the resolved timeout', async () => {
  const harness = createJavaRunnerHarness();
  const promise = harness.context.runJava({
    source: 'class Main {}',
    stdin: '1 2\n',
    timeoutMs: 3200
  });
  await flushMicrotasks();

  assert.equal(harness.posted.length, 1);
  assert.equal(harness.posted[0].timeoutMs, 3200);
  assert.equal(harness.timers.size, 1);
  const timer = [...harness.timers.values()][0];
  assert.equal(timer.delay, 3200);
  timer.callback();

  const result = await promise;
  assert.equal(result.runStatus, 'LOCAL_TIMEOUT');
  assert.notEqual(result.runStatus, 'TLE');
  assert.equal(result.timedOut, true);
  assert.equal(result.executionMs, 3200);
});

test('Java Worker reports LOCAL_TIMEOUT instead of a formal TLE', async () => {
  let runtimeOptions;
  const timeout = Object.assign(new Error('local timeout'), { code: 'LOCAL_TIMEOUT' });
  const context = createJavaWorkerHarness(async options => {
    runtimeOptions = options;
    throw timeout;
  });

  const result = await context.run({
    source: 'class Main {}',
    stdin: '1 2\n',
    timeoutMs: 2400
  });

  assert.equal(runtimeOptions.timeoutMs, 2400);
  assert.equal(result.status, 'timeout');
  assert.equal(result.runStatus, 'LOCAL_TIMEOUT');
  assert.notEqual(result.runStatus, 'TLE');
  assert.equal(result.timedOut, true);
  assert.equal(result.executionTime, 2400);
});

test('Java worker boot is 180s and the main-thread handshake is 195s', async () => {
  assert.match(runner, /const JAVA_WORKER_BOOT_TIMEOUT_MS\s*=\s*180000/);
  assert.match(runner, /const JAVA_INIT_TIMEOUT_MS\s*=\s*195000/);
  const harness = createJavaLifecycleHarness();
  const pending = harness.context.ensureJavaWorker();
  await flushMicrotasks();

  const worker = harness.workers[0];
  const init = worker.posted.find(message => message.type === 'init');
  assert.equal(init.bootTimeoutMs, 180000);
  assert.equal([...harness.timers.values()][0].delay, 195000);

  worker.emit('message', {type: 'inited', runtimeId: 'java21-browserjdk-compat-v2', initMs: 1});
  await pending;
});

test('Java handshake timeout identifies whether WASM or JVM boot stalled', async () => {
  const wasm = createJavaLifecycleHarness();
  const wasmPending = wasm.context.ensureJavaWorker();
  await flushMicrotasks();
  wasm.workers[0].emit('message', {type: 'state', state: 'INITIALIZING_WASM'});
  [...wasm.timers.values()][0].callback();
  await assert.rejects(wasmPending);

  const jvm = createJavaLifecycleHarness();
  const jvmPending = jvm.context.ensureJavaWorker();
  await flushMicrotasks();
  jvm.workers[0].emit('message', {type: 'state', state: 'BOOTING_JVM'});
  [...jvm.timers.values()][0].callback();
  await assert.rejects(jvmPending);

  const wasmError = JSON.stringify(wasm.progress.at(-1));
  const jvmError = JSON.stringify(jvm.progress.at(-1));
  assert.match(wasmError, /INITIALIZE_WASM|WASM|WebAssembly/i);
  assert.match(jvmError, /BOOT_JVM|JVM|OpenJDK/i);
  assert.notEqual(wasmError, jvmError);
});

test('Java init errors clean up listeners and reject a mismatched runtimeId', async () => {
  const errorHarness = createJavaLifecycleHarness();
  const errorPending = errorHarness.context.ensureJavaWorker();
  await flushMicrotasks();
  const errorWorker = errorHarness.workers[0];
  errorWorker.emit('message', {type: 'error', error: 'loader failed'});
  await assert.rejects(errorPending);
  assert.equal(errorWorker.listenerCount('message'), 0);
  assert.equal(errorWorker.listenerCount('error'), 0);
  assert.equal(errorWorker.terminated, true);
  assert.ok(errorWorker.posted.some(message => message.type === 'dispose'));

  const idHarness = createJavaLifecycleHarness();
  const idPending = idHarness.context.ensureJavaWorker();
  await flushMicrotasks();
  const idWorker = idHarness.workers[0];
  idWorker.emit('message', {type: 'inited', runtimeId: 'wrong-runtime', initMs: 1});
  await assert.rejects(idPending, /runtimeId|Runtime/);
  assert.equal(idWorker.listenerCount('message'), 0);
  assert.equal(idWorker.listenerCount('error'), 0);
  assert.equal(idWorker.terminated, true);
});

test('Java retry keeps the existing asset cache path', async () => {
  const calls = [];
  const context = {
    disposeJavaWorker() {},
    setJavaStatus() {},
    preloadJavaRuntimeAssets(forceReload) {
      calls.push(forceReload);
      return Promise.resolve();
    },
    ensureJavaWorker: () => Promise.resolve()
  };
  vm.runInNewContext(`${extractFunction(runner, 'retryJavaRuntime')}
    this.retryJavaRuntime = retryJavaRuntime;`, context);

  await context.retryJavaRuntime();
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], true);
});

test('a READY Java worker crash is disposed before the next run', async () => {
  const harness = createJavaLifecycleHarness((worker, message) => {
    if (message.type === 'init') {
      queueMicrotask(() => worker.emit('message', {
        type: 'inited', runtimeId: 'java21-browserjdk-compat-v2', initMs: 1
      }));
    } else if (message.type === 'run' && worker.id === 1) {
      queueMicrotask(() => worker.emit('error', {message: 'worker crashed'}));
    } else if (message.type === 'run') {
      queueMicrotask(() => worker.emit('message', {
        type: 'run-result',
        result: {
          requestId: message.requestId, status: 'ac', runStatus: 'AC',
          stdout: 'ALIVE', stderr: '', exitCode: 0, runtimeId: 'java21-browserjdk-compat-v2'
        }
      }));
    }
  });

  const first = await harness.context.runJava({source: 'class Main {}', stdin: ''});
  assert.equal(first.runStatus, 'ABORTED');
  assert.equal(harness.workers[0].terminated, true);

  const second = await harness.context.runJava({source: 'class Main {}', stdin: ''});
  assert.equal(second.stdout, 'ALIVE');
  assert.equal(harness.workers.length, 2);
});
