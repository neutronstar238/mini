'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const runner = fs.readFileSync(path.join(__dirname, '../public/js/contest/ide-runner.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../public/js/contest/problem-detail.js'), 'utf8');

test('Java 21 preloads frozen assets with byte progress before JVM boot', () => {
  assert.match(runner, /function preloadJavaRuntimeAssets\(forceReload\)/);
  assert.match(runner, /javaProgress\('DOWNLOAD_RUNTIME'/);
  assert.match(runner, /loadedBytes:\s*loadedBytes/);
  assert.match(runner, /totalBytes:\s*totalBytes/);
  assert.match(runner, /javaProgress\('BOOT_JVM'/);
  assert.match(runner, /javaProgress\('READY'/);
  assert.match(runner, /preloadJavaRuntimeAssets\(false\)\.then/);
});

test('Java 21 progress failure has an explicit retry path', () => {
  assert.match(runner, /function retryJavaRuntime\(\)/);
  assert.match(runner, /retryJavaRuntime:\s*retryJavaRuntime/);
  assert.match(page, /rid === 'java21-browserjdk-compat-v2'/);
  assert.match(page, /window\.__IDE_RUNNER__\.retryJavaRuntime/);
});

test('running status and output header identify Java instead of Python', () => {
  assert.match(page, /if \(lang === 'java'\) return 'Java 21'/);
  assert.match(page, /准备 Java 21 Runtime，首次需下载约 30 MB 并启动 JVM/);
  assert.match(page, /r\.language === 'java' && t\.runtimeLoadMs/);
  assert.match(page, /\(isModernPreview \|\| lang === 'java'\) && !useRunner/);
  assert.match(page, /if \(!useRunner\) await ensureRunno\(\)/);
  assert.doesNotMatch(page, /\(isCpp \? 'C\/C\+\+' : 'Python'\)/);
});

test('Java Zero uses a dedicated execution timeout and forwards it to the worker', () => {
  assert.match(runner, /const JAVA_EXEC_TIMEOUT_MS = 15000/);
  assert.match(runner, /timeoutMs: JAVA_EXEC_TIMEOUT_MS/);
  assert.match(runner, /\}, JAVA_EXEC_TIMEOUT_MS\);/);
});
