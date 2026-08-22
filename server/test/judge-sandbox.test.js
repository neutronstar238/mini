'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const saved = {
  mode: process.env.JUDGE_SANDBOX_MODE,
  nodeEnv: process.env.NODE_ENV,
  required: process.env.JUDGE_SANDBOX_REQUIRED
};

function restoreEnv() {
  for (const [key, value] of Object.entries({
    JUDGE_SANDBOX_MODE: saved.mode,
    NODE_ENV: saved.nodeEnv,
    JUDGE_SANDBOX_REQUIRED: saved.required
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function main() {
  const sandbox = require('../src/judge/sandbox');
  process.env.NODE_ENV = 'test';
  process.env.JUDGE_SANDBOX_REQUIRED = '0';
  process.env.JUDGE_SANDBOX_MODE = 'direct-test';
  assert.strictEqual(sandbox.getSandboxStatus().available, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-oj-sandbox-test-'));
  try {
    const result = await sandbox.runSandboxed(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      cwd: dir,
      input: 'sandbox-test\n',
      timeoutMs: 2000,
      maxOutput: 1024,
      memoryLimitMb: 128
    });
    assert.strictEqual(result.sandboxUnavailable, false);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, 'sandbox-test\n');

    process.env.JUDGE_SANDBOX_REQUIRED = '1';
    assert.strictEqual(sandbox.getSandboxStatus().available, false);
    assert.match(sandbox.getSandboxStatus().reason, /forbidden/);

    process.env.JUDGE_SANDBOX_REQUIRED = '0';
    process.env.JUDGE_SANDBOX_MODE = 'unsupported';
    const unavailable = await sandbox.runSandboxed(process.execPath, ['-e', ''], {
      cwd: dir,
      timeoutMs: 1000
    });
    assert.strictEqual(unavailable.sandboxUnavailable, true);
    assert.match(unavailable.error, /unsupported/);

    assert.strictEqual(sandbox.mapWorkPath(path.join(dir, 'main.c'), dir), '/work/main.c');
    assert.strictEqual(sandbox.mapWorkPath('/usr/bin/gcc-14', dir), '/usr/bin/gcc-14');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    restoreEnv();
  }
  console.log('judge-sandbox.test.js: PASS');
}

main().catch((error) => {
  restoreEnv();
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
