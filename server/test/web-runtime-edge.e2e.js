'use strict';

/**
 * Browser Runtime 边界回归：
 *  1. C++11 必须拒绝 C++14 泛型 lambda；
 *  2. C/C++ stdin 超过旧 8KB 边界时不得截断；
 *  3. C/C++ 与 Python 大输出必须截断，不能耗尽页面内存；
 *  4. 版本化 Runtime 资产必须可访问并带 immutable 缓存。
 *
 * 依赖正在运行的 OJ Core。用法：
 *   node test/web-runtime-edge.e2e.js [http://localhost:3001]
 */
const path = require('path');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    // 兼容当前仓库既有的本地兼容测试环境。
    return require(path.join(__dirname, '..', '..', 'compat-tests', 'bits', 'node_modules', 'playwright'));
  }
}

const { chromium } = loadPlaywright();
const base = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const username = process.env.E2E_USER || 'user1';
const password = process.env.E2E_PASSWORD || 'user123';

function assert(ok, message) {
  if (!ok) throw new Error(message);
  console.log('PASS  ' + message);
}

async function firstProblem(page) {
  return page.evaluate(async function () {
    const json = function (r) { return r.json(); };
    const contests = await fetch('/api/contest/contests').then(json);
    for (const contest of (contests.contests || contests || [])) {
      const problems = await fetch('/api/contest/contests/' + contest.id + '/problems').then(json);
      for (const problem of (problems.problems || [])) {
        return { contestId: contest.id, problemId: problem.id };
      }
    }
    return null;
  });
}

(async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(e.message); });

    await page.goto(base + '/contest/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#login-username', username);
    await page.fill('#login-password', password);
    await page.click('#login-btn');
    await page.waitForTimeout(800);

    const problem = await firstProblem(page);
    assert(!!problem, '找到可用于 Browser Runtime 回归的题目');
    await page.goto(base + '/contest/contests/' + problem.contestId + '/problems/' + problem.problemId, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(function () { return !!window.__IDE_RUNNER__; }, null, { timeout: 20000 });

    const result = await page.evaluate(async function () {
      const cpp14 = '#include <iostream>\nint main(){auto f=[](auto x){return x+1;};std::cout<<f(1);}';
      const standard = await window.__IDE_RUNNER__.runC({
        code: cpp14, lang: 'cpp', optLevel: '-O0', pchLevel: 'none', stdin: ''
      });
      const input = 'a'.repeat(10000);
      const counter = '#include <iostream>\nint main(){size_t n=0;char c;while(std::cin.get(c))++n;std::cout<<n;}';
      const transport = await window.__IDE_RUNNER__.runC({
        code: counter, lang: 'cpp', optLevel: '-O0', pchLevel: 'none', stdin: input
      });
      const cppOutput = await window.__IDE_RUNNER__.runC({
        code: '#include <iostream>\n#include <string>\nint main(){std::cout<<std::string(1200000,\'x\');}',
        lang: 'cpp', optLevel: '-O0', pchLevel: 'none', stdin: ''
      });
      const pythonOutput = await window.__IDE_RUNNER__.runPython({
        source: 'print("x" * 1200000, end="")', stdin: ''
      });
      const oversizedResponse = await fetch('/api/contest/contests/' + window.__CONTEST_ID__ + '/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problemId: window.__PROBLEM_ID__, language: 'cpp11',
          source: '界'.repeat(90000), clientRequestId: crypto.randomUUID()
        })
      });
      const oversizedBody = await oversizedResponse.json();
      return {
        runtimeVersion: window.__IDE_RUNNER__.version,
        cppRuntimeId: window.__IDE_RUNNER__.runtimeIds.cpp,
        cpp14Rejected: !!standard.compileFailed,
        inputBytesObserved: Number((transport.stdout || '').trim()),
        cppOutputLength: (cppOutput.stdout || '').length,
        cppOutputTruncated: !!cppOutput.outputTruncated,
        pythonOutputLength: (pythonOutput.stdout || '').length,
        pythonOutputTruncated: !!pythonOutput.outputTruncated,
        oversizedSourceStatus: oversizedResponse.status,
        oversizedSourceCode: oversizedBody && oversizedBody.error && oversizedBody.error.code,
        crossOriginIsolated: self.crossOriginIsolated,
        draftUserScoped: String(window.__USER_ID__ || '').length > 0
      };
    });

    assert(result.runtimeVersion === '0.10.0-ojc4', '加载版本化 Browser Runtime ojc4');
    assert(result.cppRuntimeId === 'cpp11-gcc11-compat-v4', 'C++ Runtime ID 已升级到 v4');
    assert(result.cpp14Rejected, 'C++11 模式拒绝 C++14 泛型 lambda');
    assert(result.inputBytesObserved === 10000, 'C/C++ stdin 10000 字节完整传输');
    assert(result.cppOutputTruncated && result.cppOutputLength <= 1024 * 1024,
      'C/C++ 本地输出限制为 1 MiB');
    assert(result.pythonOutputTruncated && result.pythonOutputLength <= 1024 * 1024,
      'Python 本地输出限制为 1 MiB');
    assert(result.oversizedSourceStatus === 400 && result.oversizedSourceCode === 'SOURCE_TOO_LARGE',
      '正式提交按 UTF-8 字节拒绝超过 256 KiB 的源码');
    assert(result.crossOriginIsolated, '比赛页面保持 cross-origin isolated');
    assert(result.draftUserScoped, '本地草稿具有用户作用域');
    assert(pageErrors.length === 0, '页面无未捕获 JavaScript 错误');

    for (const url of [
      '/runtime/runno/0.10.0-ojc4/langs/clang.wasm',
      '/runtime/pyodide/0.26.4/pyodide.mjs'
    ]) {
      const response = await page.request.head(base + url);
      assert(response.status() === 200, url + ' 可访问');
      assert(/immutable/.test(response.headers()['cache-control'] || ''), url + ' 使用版本化 immutable 缓存');
    }
  } finally {
    await browser.close();
  }
})().catch(function (err) {
  console.error('FAIL  ' + err.message);
  process.exit(1);
});
