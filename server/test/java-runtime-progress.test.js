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
