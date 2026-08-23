'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const worker = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-wasi-worker.js'), 'utf8');
const helper = worker.match(/function normalizeMsvcInt64FormatStrings\(source\) \{[\s\S]*?\n\}/);
assert.ok(helper, 'MSVC integer format normalizer must remain present');

function normalize(source) {
  const context = { source };
  vm.runInNewContext(helper[0] + '\nresult = normalizeMsvcInt64FormatStrings(source);', context);
  return context.result;
}

test('C++11 normalizes MSVC 64-bit integer conversion specifiers', () => {
  assert.equal(normalize('printf("%I64d %I64u %I64x", a, b, c);'),
    'printf("%lld %llu %llx", a, b, c);');
});

test('format normalizer leaves comments, character literals, and escaped percent text unchanged', () => {
  const source = [
    '// "%I64d"',
    '/* %I64u */',
    'char marker = \'%\';',
    'printf("%%I64d %I64d", value);'
  ].join('\n');
  const expected = [
    '// "%I64d"',
    '/* %I64u */',
    'char marker = \'%\';',
    'printf("%%I64d %lld", value);'
  ].join('\n');
  assert.equal(normalize(source), expected);
});
