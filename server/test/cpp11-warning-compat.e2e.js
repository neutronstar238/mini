'use strict';

/**
 * C++11 warning policy regression.
 *
 * These are accepted GCC11-style sources which Clang 8 diagnoses as warnings
 * (`%I64d` and shift precedence). They must compile and run in the browser;
 * a genuine C++14 syntax error must still be rejected.
 *
 * Usage:
 *   node server/test/cpp11-warning-compat.e2e.js [http://localhost:3001]
 */
const path = require('path');
const assert = require('node:assert/strict');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    return require(path.join(__dirname, '..', '..', 'compat-tests', 'bits', 'node_modules', 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const base = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');

async function firstProblem(page) {
  return page.evaluate(async function () {
    const json = function (r) { return r.json(); };
    const contests = await fetch('/api/contest/contests').then(json);
    for (const contest of (contests.contests || contests || [])) {
      const problems = await fetch('/api/contest/contests/' + contest.id + '/problems').then(json);
      if (problems.problems && problems.problems.length) {
        return { contestId: contest.id, problemId: problems.problems[0].id };
      }
    }
    return null;
  });
}

async function run(page, code) {
  return page.evaluate(async function (source) {
    const result = await window.__IDE_RUNNER__.runC({
      code: source,
      lang: 'cpp',
      optLevel: '-O0',
      pchLevel: 'none',
      stdin: ''
    });
    return {
      compileFailed: !!result.compileFailed,
      exitCode: result.exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    };
  }, code);
}

(async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base + '/contest/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', 'user1');
    await page.fill('#login-password', 'user123');
    await page.click('#login-btn');
    await page.waitForTimeout(500);

    const problem = await firstProblem(page);
    assert.ok(problem, '找到用于 C++11 warning 回归的题目');
    await page.goto(base + '/contest/contests/' + problem.contestId + '/problems/' + problem.problemId, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(function () { return !!window.__IDE_RUNNER__; }, null, { timeout: 20000 });

    const i64 = await run(page, [
      '#include <cstdio>',
      'int main() { long long value = 42; std::printf("%I64d\\n", value); }'
    ].join('\n'));
    assert.equal(i64.compileFailed, false, '%I64d warning 不得导致 C++11 CE');
    assert.equal(i64.exitCode, 0, '%I64d warning 用例运行成功');
    assert.equal(i64.stdout.trim(), '42', '%I64d warning 用例输出正确');

    const shift = await run(page, [
      '#include <iostream>',
      'int main() { long long value = 0; int i = 3;',
      'value |= (1ll << i - 1); std::cout << value << "\\n"; }'
    ].join('\n'));
    assert.equal(shift.compileFailed, false, '移位优先级 warning 不得导致 C++11 CE');
    assert.equal(shift.exitCode, 0, '移位优先级 warning 用例运行成功');
    assert.equal(shift.stdout.trim(), '4', '移位优先级 warning 用例输出正确');

    const cxx14 = await run(page, [
      '#include <iostream>',
      'int main() { auto f = [](auto x) { return x + 1; }; std::cout << f(1); }'
    ].join('\n'));
    assert.equal(cxx14.compileFailed, true, 'C++14 泛型 lambda 仍被 C++11 模式拒绝');

    console.log('PASS C++11 warning compatibility regression');
  } finally {
    await browser.close();
  }
})().catch(function (error) {
  console.error('FAIL C++11 warning compatibility regression:', error && error.stack || error);
  process.exit(1);
});
