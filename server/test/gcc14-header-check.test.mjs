import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../public/js/contest/gcc14-header-check.js', import.meta.url), 'utf8');
const {check, PROVEN_MISMATCHES} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('guard covers only the five GCC14 mismatches proven by the matrix', () => {
  assert.deepEqual(PROVEN_MISMATCHES.map(item => item.header),
    ['algorithm', 'vector', 'memory', 'functional', 'optional']);
});

test('guard rejects proven transitive includes without changing source', () => {
  const result = check('#include <iostream>\nint main(){std::vector<int> v; std::sort(v.begin(),v.end());}');
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map(item => item.header), ['algorithm', 'vector']);
});

test('explicit headers and bits aggregate pass', () => {
  assert.equal(check('#include <vector>\nstd::vector<int> v;').ok, true);
  assert.equal(check('#include <bits/stdc++.h>\nstd::optional<int> v;').ok, true);
});

test('comments and literals do not trigger the guard', () => {
  assert.equal(check('// std::vector<int>\nconst char *s="std::sort(";').ok, true);
});
