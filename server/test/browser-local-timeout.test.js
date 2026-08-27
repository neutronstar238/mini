'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '../public/js/contest/problem-detail.js'), 'utf8');
const runner = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-runner.js'), 'utf8');
const javaWorker = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-java-worker.js'), 'utf8');

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

function renderTimedOutSample() {
  const elements = new Map([
    ['ide-code', { value: 'class Main {}' }],
    ['ide-lang', { value: 'java' }],
    ['ide-run-samples', { textContent: '' }],
    ['ide-samples-wrap', { style: { display: 'none' } }],
    ['ide-samples-result', { innerHTML: '' }]
  ]);
  const sampleResult = {
    runStatus: 'LOCAL_TIMEOUT',
    timeout: true,
    timedOut: true,
    stdout: '',
    stderr: 'LOCAL_TIMEOUT：仅本地保护，正式结果以 Judge 为准。',
    exitCode: -1,
    executionMs: null,
    timeMs: 60000,
    timing: { cacheHit: true }
  };
  const context = {
    IDE: { samples: [{ input: '', output: '' }] },
    abortRun: null,
    runVersion: 0,
    $: id => elements.get(id),
    selectConsoleTab: targetId => {
      ['ide-output-wrap', 'ide-samples-wrap', 'ide-input-wrap'].forEach(id => {
        const section = elements.get(id);
        if (section) section.style.display = id === targetId ? '' : 'none';
      });
    },
    newAbort: () => ({ _killers: [] }),
    runIde: async () => sampleResult,
    toast() {},
    caseDot: () => '',
    formatCompileInfo: () => '',
    fmtExecMs: value => String(value),
    normalizeOut: value => String(value == null ? '' : value).trim(),
    escapeHtml: value => String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
  };
  vm.runInNewContext(`${extractFunction(page, 'onRunSamples')}\nthis.onRunSamples = onRunSamples;`, context);
  return context.onRunSamples().then(() => elements.get('ide-samples-result').innerHTML);
}

test('sample results render LOCAL_TIMEOUT and use the resolved timeout instead of hardcoded >6000 ms', async () => {
  const html = await renderTimedOutSample();

  assert.match(html, /LOCAL_TIMEOUT/);
  assert.match(html, /60000\s*ms/);
  assert.doesNotMatch(html, /\bTLE\b/);
  assert.doesNotMatch(html, />\s*6000\s*ms/);
});

test('browser runners never expose a local timeout as formal TLE', () => {
  assert.match(runner, /runStatus:\s*'LOCAL_TIMEOUT'/);
  assert.match(javaWorker, /runStatus:\s*'LOCAL_TIMEOUT'/);
  assert.doesNotMatch(runner, /runStatus:\s*'TLE'/);
  assert.doesNotMatch(javaWorker, /runStatus:\s*'TLE'/);
});
