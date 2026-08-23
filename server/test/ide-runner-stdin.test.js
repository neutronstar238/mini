'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const runner = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-runner.js'), 'utf8');

function loadStdinBufferHelper() {
  const match = runner.match(/function stdinBufferByteLength\(inputByteLength\) \{[\s\S]*?\n\}/);
  assert.ok(match, 'stdin buffer alignment helper must remain present');
  const context = {};
  vm.runInNewContext(`${match[0]}\nresult = stdinBufferByteLength(8191);`, context);
  return {source: match[0], context};
}

test('stdin SAB length is always a valid Int32Array byte length', () => {
  const {source, context} = loadStdinBufferHelper();
  assert.equal(context.result, 8196);
  assert.equal(context.result % Int32Array.BYTES_PER_ELEMENT, 0);

  const largeContext = {};
  vm.runInNewContext(`${source}\nconst sab = new SharedArrayBuffer(stdinBufferByteLength(4 * 1024 * 1024));\nresult = new Int32Array(sab).byteLength;`, largeContext);
  assert.equal(largeContext.result % Int32Array.BYTES_PER_ELEMENT, 0);
});

test('stdin and Worker failures are surfaced as runtime errors', () => {
  assert.match(runner, /const runtimeError = d\.ok === false \|\| exitCode !== 0;/);
  assert.match(runner, /runStatus: runtimeError \? 'RE' : 'PASS'/);
  assert.match(runner, /stdinPush\.then\(function \(\) \{ return pushEOF\(sab, shouldAbort\); \}\)\.catch/);
  assert.doesNotMatch(runner, /pushStdin\(sab, stdinBytes\)\.catch\(function \(\) \{ \/\* ignore \*\/ \}\)/);
});
