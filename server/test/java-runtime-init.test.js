'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workerSource = fs.readFileSync(
  path.join(__dirname, '../public/js/contest/ide-java-worker.js'),
  'utf8'
);

function createWorkerHarness(options = {}) {
  const messages = [];
  const initOptions = [];
  let disposeCalls = 0;
  let receiveMessage;
  const initialize = options.initialize || (async () => ({javaVersion: '21.0.10'}));
  const loader = {
    initialize(options) {
      initOptions.push(options);
      return initialize(options);
    },
    cacheStats() {
      return {size: 3, capacity: 8};
    },
    async dispose() {
      disposeCalls += 1;
      if (options.dispose) await options.dispose();
    }
  };
  const context = {
    TextEncoder,
    performance: {now: () => 0},
    console: {log() {}, warn() {}, error() {}},
    loadLoader: async () => loader,
    setInterval() { return 1; },
    clearInterval() {},
    self: {
      postMessage(message) { messages.push(message); },
      addEventListener(type, handler) {
        if (type === 'message') receiveMessage = handler;
      }
    }
  };

  const executable = workerSource.replace(
    'await import(LOADER_URL)',
    'await loadLoader(LOADER_URL)'
  );
  assert.notEqual(executable, workerSource, 'worker loader import must remain testable');
  vm.runInNewContext(executable, context);

  return {
    messages,
    initOptions,
    get disposeCalls() { return disposeCalls; },
    send(message) {
      assert.equal(typeof receiveMessage, 'function');
      return receiveMessage({data: message});
    }
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test('Java worker initialization is single-flight and passes the 180s boot budget', async () => {
  assert.match(workerSource, /const JAVA_BOOT_TIMEOUT_MS\s*=\s*180000/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createWorkerHarness({
    initialize: async () => {
      await gate;
      return {javaVersion: '21.0.10'};
    }
  });

  const first = harness.send({type: 'init'});
  const second = harness.send({type: 'init'});
  await flushMicrotasks();
  try {
    assert.equal(harness.initOptions.length, 1);
  } finally {
    release();
  }
  await Promise.all([first, second]);

  assert.equal(harness.initOptions[0].bootTimeoutMs, 180000);
  assert.equal(harness.messages.filter(message => message.type === 'inited').length, 1);
});

test('Java worker initialization failure leaves the worker in FAILED', async () => {
  const harness = createWorkerHarness({
    initialize: async () => { throw new Error('boot failed'); }
  });

  await harness.send({type: 'init'});
  assert.ok(harness.messages.some(message => (
    message.type === 'state' && message.state === 'FAILED'
  )));
  assert.ok(harness.messages.some(message => (
    message.type === 'init-failed' && /boot failed/.test(message.error)
  )));

  await harness.send({type: 'ping'});
  assert.equal(harness.messages.at(-1).state, 'FAILED');
});

test('Java worker dispose clears runtime state and permits a fresh initialization', async () => {
  const harness = createWorkerHarness();
  await harness.send({type: 'init'});
  await harness.send({type: 'dispose'});

  assert.equal(harness.disposeCalls, 1);
  assert.equal(harness.messages.at(-1).type, 'disposed');
  await harness.send({type: 'stats'});
  assert.equal(harness.messages.at(-1).state, 'NOT_LOADED');
  assert.equal(harness.messages.at(-1).cacheSize, 0);

  await harness.send({type: 'init'});
  assert.equal(harness.initOptions.length, 2);
  await harness.send({type: 'ping'});
  assert.equal(harness.messages.at(-1).state, 'READY');
});
