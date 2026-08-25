'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runnerSource = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-runner.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '../public/js/contest/problem-detail.js'), 'utf8');

const FOUR_MIB = 4 * 1024 * 1024;
const ONE_MIB = 1024 * 1024;

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

function defaultRuntimeResult(overrides) {
  return Object.assign({
    status: 'ok',
    compileStatus: 'PASS',
    runStatus: 'PASS',
    compileFailed: false,
    stdout: '',
    stderr: '',
    exitCode: 0,
    executionTime: 1,
    executionMs: 1,
    timeMs: 1,
    timedOut: false,
    aborted: false,
    outputTruncated: false,
    timing: {compileMs: 0, linkMs: 0, executionMs: 1, cacheHit: false}
  }, overrides);
}

function createRunnerHarness(options = {}) {
  const calls = {c: 0, modern: 0, python: 0, java: 0};
  const runtimeResult = options.runtimeResult || {};
  const workerListeners = new Map();
  const javaWorker = {
    addEventListener(type, handler) { workerListeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (workerListeners.get(type) === handler) workerListeners.delete(type);
    },
    postMessage(message) {
      if (message.type !== 'run') return;
      const handler = workerListeners.get('message');
      if (!handler) return;
      queueMicrotask(() => handler({
        data: {type: 'run-result', result: Object.assign({}, defaultRuntimeResult(runtimeResult.java), {
          requestId: message.requestId
        })}
      }));
    },
    terminate() {}
  };

  const stub = name => async () => {
    calls[name] += 1;
    return defaultRuntimeResult(runtimeResult[name]);
  };

  const window = {
    __PY_FORCE_INTERRUPT_CAPABILITY__: 'FALLBACK',
    addEventListener() {},
    dispatchEvent() {}
  };
  const context = {
    window,
    location: {origin: 'http://local.test'},
    CustomEvent: function CustomEvent() {},
    TextEncoder,
    TextDecoder,
    WebAssembly,
    AbortController,
    SharedArrayBuffer,
    Int32Array,
    Atomics,
    performance,
    crypto: {subtle: {digest: async () => new ArrayBuffer(32)}},
    crossOriginIsolated: false,
    fetchWASIFS: async () => ({}),
    gcc11HeaderCheck: () => ({ok: true}),
    gcc14HeaderCheck: () => ({ok: true}),
    console: {debug() {}, warn() {}, error() {}, log() {}},
    fetch: async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(0)}),
    Worker: function UnexpectedWorker() {
      throw new Error('language runtime should be replaced by the test stub');
    },
    setTimeout,
    clearTimeout,
    __stubC: stub('c'),
    __stubModern: stub('modern'),
    __stubPython: stub('python'),
    __stubJava: stub('java'),
    __ensureJavaWorker: async () => javaWorker,
    __sha256Hex: async () => 'test-source-hash',
    __detectPythonInterruptCapability: () => 'FALLBACK',
    __disposeJavaWorker: () => {}
  };

  const dispatchOverrides = options.overrideDispatch === false ? '' : `
runC = __stubC;
runModern = __stubModern;
runPython = __stubPython;
runJava = __stubJava;
`;
  const executableSource = runnerSource.replace(/^import[^\r\n]*[\r\n]+/gm, '') + dispatchOverrides + `
ensureJavaWorker = __ensureJavaWorker;
sha256Hex = __sha256Hex;
detectPythonInterruptCapability = __detectPythonInterruptCapability;
disposeJavaWorker = __disposeJavaWorker;
this.__runner = window.__IDE_RUNNER__;
`;
  vm.runInNewContext(executableSource, context);
  return {context, calls, runner: context.__runner, javaWorker};
}

function createJavaHarness() {
  return createRunnerHarness({overrideDispatch: false});
}

function createPageHarness(runResult, samples) {
  const elements = new Map([
    ['ide-code', {value: 'print(1)'}],
    ['ide-lang', {value: 'python'}],
    ['ide-input', {value: ''}],
    ['ide-run', {textContent: ''}],
    ['ide-run-samples', {textContent: ''}],
    ['ide-output-wrap', {style: {display: 'none'}}],
    ['ide-output-head', {innerHTML: ''}],
    ['ide-time', {textContent: ''}],
    ['ide-timing', {textContent: ''}],
    ['ide-output', {innerHTML: ''}],
    ['ide-samples-wrap', {style: {display: 'none'}}],
    ['ide-samples-result', {innerHTML: ''}]
  ]);
  const context = {
    IDE: {samples: samples || []},
    abortRun: null,
    runVersion: 0,
    $: id => elements.get(id),
    newAbort: () => ({_killers: []}),
    runIde: async () => runResult,
    toast() {},
    caseDot: () => '',
    formatCompileInfo: () => '',
    fmtExecMs: value => String(value),
    ideLanguageLabel: value => String(value),
    normalizeOut: value => String(value == null ? '' : value).trim(),
    escapeHtml: value => String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    window: {__RUNTIME_UI__: null}
  };
  const functions = [
    extractFunction(pageSource, 'onRun'),
    extractFunction(pageSource, 'onRunSamples')
  ].join('\n');
  vm.runInNewContext(`${functions}\nthis.onRun = onRun;\nthis.onRunSamples = onRunSamples;`, context);
  return {context, elements};
}

test('4 MiB UTF-8 stdin boundary is allowed, but one extra byte is rejected before any runtime', async () => {
  const exactInput = '汉'.repeat((FOUR_MIB - 1) / 3) + 'a';
  const overInput = exactInput + 'b';
  assert.equal(new TextEncoder().encode(exactInput).byteLength, FOUR_MIB);
  assert.equal(new TextEncoder().encode(overInput).byteLength, FOUR_MIB + 1);

  for (const language of ['c', 'cpp', 'c17', 'cpp17', 'python', 'java']) {
    const allowed = createRunnerHarness();
    const allowedResult = await allowed.runner.runCode({language, source: 'class Main {}', stdin: exactInput});
    assert.equal(allowedResult.runStatus, 'PASS', `${language} must accept exactly 4 MiB`);
    assert.equal(Object.values(allowed.calls).reduce((sum, count) => sum + count, 0), 1,
      `${language} runtime should run at the exact boundary`);

    const rejected = createRunnerHarness();
    const rejectedResult = await rejected.runner.runCode({language, source: 'class Main {}', stdin: overInput});
    assert.equal(rejectedResult.runStatus, 'LOCAL_UNSUPPORTED', `${language} should use local unsupported status`);
    assert.equal(rejectedResult.reason, 'LOCAL_INPUT_LIMIT', `${language} should identify the input limit`);
    assert.equal(rejectedResult.coverageLimited, true);
    assert.equal(Object.values(rejected.calls).reduce((sum, count) => sum + count, 0), 0,
      `${language} runtime must not be called for oversized input`);
  }
});

test('compile errors with truncated output remain CE, while successful compilation maps truncation to a local limit', async () => {
  for (const language of ['c', 'cpp17', 'python', 'java']) {
    const runtimeKey = language === 'c' ? 'c' : language === 'cpp17' ? 'modern' : language;
    const compileErrorHarness = createRunnerHarness({runtimeResult: {
      [runtimeKey]: {
        compileFailed: true, compileStatus: 'CE', runStatus: 'CE', exitCode: 1,
        stderr: 'compiler diagnostics', outputTruncated: true
      }
    }});
    const compileError = await compileErrorHarness.runner.runCode({language, source: 'class Main {}', stdin: ''});

    assert.equal(compileError.compileFailed, true, `${language} compile failure must be preserved`);
    assert.equal(compileError.compileStatus, 'CE', `${language} compile status must remain CE`);
    assert.equal(compileError.runStatus, 'CE', `${language} run status must remain CE`);
    assert.equal(compileError.outputTruncated, true);
    assert.notEqual(compileError.reason, 'LOCAL_OUTPUT_LIMIT');
    assert.notEqual(compileError.coverageLimited, true);

    const successfulHarness = createRunnerHarness({runtimeResult: {
      [runtimeKey]: {
        compileFailed: false, compileStatus: 'PASS', runStatus: 'RE', exitCode: 1,
        stderr: 'output reached local cap', outputTruncated: true
      }
    }});
    const successful = await successfulHarness.runner.runCode({language, source: 'class Main {}', stdin: ''});

    assert.equal(successful.compileFailed, false);
    assert.equal(successful.compileStatus, 'PASS');
    assert.equal(successful.outputTruncated, true);
    assert.equal(successful.runStatus, 'LOCAL_UNSUPPORTED');
    assert.equal(successful.reason, 'LOCAL_OUTPUT_LIMIT');
    assert.equal(successful.coverageLimited, true);
    assert.doesNotMatch(String(successful.runStatus), /^(?:TLE|WA|RE)$/);
  }
});

test('large Java input warns only for an executable Scanner construction, not lexical lookalikes', async () => {
  const largeInput = 'x'.repeat(ONE_MIB + 1);
  const cases = [
    {
      name: 'real new Scanner construction',
      source: [
        'import java.util.Scanner;',
        'class Main { public static void main(String[] args) {',
        '  Scanner scanner = new Scanner(System.in); System.out.println(scanner.nextInt());',
        '} }'
      ].join('\n'),
      warns: true
    },
    {
      name: 'line comment',
      source: 'class Main { // new Scanner(System.in)\n }',
      warns: false
    },
    {
      name: 'block comment',
      source: '/* new Scanner(System.in) */ class Main {}',
      warns: false
    },
    {
      name: 'string literal',
      source: 'class Main { String text = "new Scanner(System.in)"; }',
      warns: false
    },
    {
      name: 'character literal before a string literal',
      source: 'class Main { char quote = \'"\'; String text = "new Scanner(System.in)"; }',
      warns: false
    },
    {
      name: 'import only',
      source: 'import java.util.Scanner;\nclass Main {}',
      warns: false
    }
  ];

  const harness = createJavaHarness();
  for (const fixture of cases) {
    const result = await harness.runner.runCode({language: 'java', source: fixture.source, stdin: largeInput});
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    const scannerWarning = warnings.find(warning => warning && warning.code === 'JAVA_SCANNER_LARGE_INPUT');
    assert.equal(!!scannerWarning, fixture.warns, fixture.name);
    if (scannerWarning) {
      assert.equal(scannerWarning.actualBytes, ONE_MIB + 1);
      assert.match(scannerWarning.message, /BufferedReader|快速输入|FastScanner/);
    }
  }

  const boundary = await harness.runner.runCode({
    language: 'java', source: cases[0].source, stdin: 'x'.repeat(ONE_MIB)
  });
  assert.equal((boundary.warnings || []).length, 0, 'exactly 1 MiB must not warn');
});

test('custom run and sample results render coverageLimited as browser coverage limitation, not TLE/WA/RE', async () => {
  const result = {
    stdout: '',
    stderr: 'stdout exceeded local cap',
    exitCode: 1,
    timeMs: 12,
    executionMs: null,
    compileFailed: false,
    timeout: false,
    terminated: false,
    coverageLimited: true,
    runStatus: 'LOCAL_UNSUPPORTED',
    reason: 'LOCAL_OUTPUT_LIMIT',
    outputTruncated: true
  };

  const custom = createPageHarness(result);
  await custom.context.onRun();
  const customHtml = [
    custom.elements.get('ide-time').textContent,
    custom.elements.get('ide-output').innerHTML,
    custom.elements.get('ide-timing').textContent
  ].join('\n');
  assert.match(customHtml, /浏览器环境无法覆盖/);
  assert.doesNotMatch(customHtml, /\b(?:TLE|WA|RE)\b/);

  const samples = createPageHarness(result, [{input: '', output: 'expected'}]);
  await samples.context.onRunSamples();
  const sampleHtml = samples.elements.get('ide-samples-result').innerHTML;
  assert.match(sampleHtml, /浏览器环境无法覆盖/);
  assert.doesNotMatch(sampleHtml, /\b(?:TLE|WA|RE)\b/);
});
