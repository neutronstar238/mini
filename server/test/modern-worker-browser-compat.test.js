'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWorker(file, extra) {
  const internals = file.includes('execution-worker-modern') ? '{execute}' : '{assetRequestUrl, compileArgs, sourceUsesUnsupportedX86StackAsm, executeArtifact}';
  const source = fs.readFileSync(path.join(__dirname, '../public/js/contest', file), 'utf8')
    .replace(/^import[^\r\n]*\r?\n/m, '') +
    `\nthis.__workerInternals = ${internals};`;
  const context = Object.assign({
    self: {addEventListener() {}, postMessage() {}},
    TextEncoder, TextDecoder, WebAssembly, performance, URL,
    WASI: class { getImportObject() { return {}; } start() { throw new Error('Maximum call stack size exceeded'); } }
  }, extra || {});
  vm.runInNewContext(source, context);
  return context.__workerInternals;
}

test('C++ gets the GCC14 narrowing cc1 default and only x86 stack-adjust asm is preblocked', () => {
  const worker = loadWorker('ide-wasi-worker-modern.js');
  const cppArgs = worker.compileArgs({language: 'cpp', standard: 'c++17'}, {optLevel: '-O2', flags: []}, {}, {});
  const cArgs = worker.compileArgs({language: 'c', standard: 'c17'}, {optLevel: '-O2', flags: []}, {}, {});
  assert.ok(cppArgs.includes('-Wno-c++11-narrowing'));
  assert.equal(cArgs.includes('-Wno-c++11-narrowing'), false);

  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('asm volatile ("subq $4096, %%rsp\\n\\taddq $4096, %%rsp");'), true);
  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('__asm__ __volatile__("sub rsp, 4096");'), true);
  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('__asm__("movq %0, %%rsp\\n" :: "r"(stack));'), true);
  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('asm volatile ("nop");'), false);
  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('asm volatile ("mov %%rsp, %%rax");'), false);
  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('const char *s = "subq $4096, %%rsp";'), false);
  assert.equal(worker.sourceUsesUnsupportedX86StackAsm('// asm("subq $4096, %%rsp");'), false);
});

test('both execution workers classify the JavaScript call-stack limit as local unsupported', async () => {
  const fakeWebAssembly = {Module: class {}, compile: async () => ({}), instantiate: async () => ({})};
  const modern = loadWorker('ide-wasi-worker-modern.js', {WebAssembly: fakeWebAssembly});
  const result = await modern.executeArtifact(new Uint8Array([0]), {}, {profileId: 'cpp17-gcc14-compat-v2'}, {
    sourceHash: 'test', cacheHit: false, compilerInitMs: 0, compileMs: 0, linkMs: 0
  });
  assert.equal(result.runStatus, 'LOCAL_UNSUPPORTED');
  assert.equal(result.reason, 'BROWSER_CALL_STACK_LIMIT');
  assert.equal(result.coverageLimited, true);
  assert.match(result.stderr, /Maximum call stack size exceeded/);
  assert.match(result.stderr, /浏览器本地运行/);

  const disposable = loadWorker('ide-wasi-execution-worker-modern.js', {WebAssembly: fakeWebAssembly});
  const disposableResult = await disposable.execute({bytes: new Uint8Array([0])});
  assert.equal(disposableResult.runStatus, 'LOCAL_UNSUPPORTED');
  assert.equal(disposableResult.reason, 'BROWSER_CALL_STACK_LIMIT');
  assert.equal(disposableResult.coverageLimited, true);
});

test('immutable runtime assets use their content hash as a cache-busting URL key', () => {
  const worker = loadWorker('ide-wasi-worker-modern.js');
  const url = new URL(worker.assetRequestUrl({
    url: '/runtime/cpp-modern-engine-v2/bits/stdc++.h',
    expectedHash: 'A'.repeat(64)
  }, 'https://contest.example/runtime/cpp-modern-engine-v2/runtime-manifest.json'));
  assert.equal(url.pathname, '/runtime/cpp-modern-engine-v2/bits/stdc++.h');
  assert.equal(url.searchParams.get('sha256'), 'a'.repeat(64));
});
