import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {IO_CASES} from './io/cases.mjs';
import {CASES as ACM_CASES} from '../../scripts/java-poc-corpus.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const publicRoot = path.join(root, 'server', 'public');
const outputDir = path.join(here, 'results');
const buildImage = 'browserjdk-oj-build:emsdk-5.0.2';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const require = createRequire(path.join(root, 'server', 'package.json'));
const {chromium} = require('playwright');

function normalizedCase(item) {
  return {
    name: item.name, source: item.source, input: item.input ?? item.stdin ?? '',
    expected: item.expected ?? ((item.expectOut || '') + (item.expectOut ? '\n' : '')),
    expectedVerdict: item.expectStatus ? item.expectStatus.toUpperCase().replace('OK', 'AC') : 'AC'
  };
}

function runDocker(args, input = '') {
  return spawnSync('docker', args, {
    input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000
  });
}

function serverBaseline(test) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'browserjdk-server-'));
  try {
    writeFileSync(path.join(workspace, 'Main.java'), test.source, 'utf8');
    const mount = `type=bind,src=${workspace},dst=/case`;
    const compile = runDocker(['run', '--rm', '--mount', mount,
      '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8', buildImage,
      'bash', '-lc', 'cd /case && javac --release 21 -encoding UTF-8 Main.java']);
    if (compile.error || compile.status === null) {
      return {verdict: 'BLOCKED', stdout: compile.stdout || '',
        stderr: String(compile.error && compile.error.message || compile.stderr || 'Docker baseline unavailable'),
        exceptionClass: '', blocked: true};
    }
    if (compile.status !== 0) {
      return {verdict: 'CE', stdout: compile.stdout || '', stderr: compile.stderr || '', exceptionClass: ''};
    }
    const execution = runDocker(['run', '--rm', '-i', '--mount', mount,
      '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8', buildImage,
      'bash', '-lc', 'cd /case && java -Dfile.encoding=UTF-8 Main'], test.input);
    if (execution.error || execution.status === null) {
      return {verdict: 'BLOCKED', stdout: execution.stdout || '',
        stderr: String(execution.error && execution.error.message || execution.stderr || 'Docker baseline unavailable'),
        exceptionClass: '', blocked: true};
    }
    const exception = (execution.stderr || '').match(/(?:Exception in thread "main" )?([\w.$]+(?:Exception|Error))(?::|\s|$)/);
    return {
      verdict: execution.status === 0 ? 'AC' : 'RE', stdout: execution.stdout || '',
      stderr: execution.stderr || '', exceptionClass: exception ? exception[1] : ''
    };
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}

function mime(file) {
  const ext = path.extname(file);
  return ({'.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
    '.json': 'application/json', '.data': 'application/octet-stream', '.md': 'text/markdown'})[ext]
    || 'application/octet-stream';
}

async function startServer() {
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (request.url === '/checkpoint1.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>BrowserJDK Checkpoint 1</title>');
      return;
    }
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.startsWith('/runtime/')) pathname = '/js' + pathname;
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const body = readFileSync(file);
      response.setHeader('Content-Type', mime(file));
      response.setHeader('Content-Length', body.length);
      response.end(body);
    } catch (_) { response.writeHead(404).end('not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function createBrowserRunner(page) {
  return page.evaluate(async () => {
    if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('COOP/COEP isolation missing');
    const worker = new Worker('/js/contest/ide-java-worker.js', {type: 'module'});
    const pending = [];
    worker.addEventListener('message', event => {
      const index = pending.findIndex(waiter => waiter.type === event.data.type);
      if (index >= 0) pending.splice(index, 1)[0].resolve(event.data);
    });
    const waitFor = (type, timeoutMs) => new Promise((resolve, reject) => {
      const waiter = {type, resolve}; pending.push(waiter);
      setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error('worker timeout waiting for ' + type));
      }, timeoutMs);
    });
    const started = performance.now();
    // Use one cancellable init waiter. Promise.race(waitFor(...), waitFor(...))
    // leaves the losing timeout/rejection alive and can produce an unhandled
    // rejection several minutes after a successful boot.
    const initialized = await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error('worker initialization timeout')), 180000);
      const onMessage = event => {
        const value = event.data || {};
        if (value.type === 'inited') finish(null, value);
        else if (value.type === 'init-failed') finish(new Error(value.error || 'worker initialization failed'));
      };
      const onError = event => finish(new Error(event.message || 'worker error during initialization'));
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(value);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      try { worker.postMessage({type: 'init'}); }
      catch (error) { finish(error); }
    });
    globalThis.__browserJdkWorker = worker;
    globalThis.__browserJdkWaitFor = waitFor;
    return {bootWallMs: Math.round(performance.now() - started), ...initialized};
  });
}

async function browserRun(page, test) {
  return page.evaluate(async value => {
    __browserJdkWorker.postMessage({type: 'run', source: value.source, stdin: value.input, className: 'Main', timeoutMs: 30000});
    const message = await __browserJdkWaitFor('run-result', 45000);
    const result = message.result;
    return {verdict: result.runStatus, stdout: result.stdout, stderr: result.stderr,
      exceptionClass: result.tracebackClass || '', compileMs: result.compileTime, executionMs: result.executionTime};
  }, test);
}

function matches(left, right) {
  if (left.verdict !== right.verdict) return false;
  if (left.verdict === 'AC') return left.stdout === right.stdout;
  if (left.verdict === 'RE') return left.exceptionClass === right.exceptionClass;
  return true;
}

function matchesExpected(actual, test) {
  if (actual.verdict !== test.expectedVerdict) return false;
  return actual.verdict !== 'AC' || actual.stdout === test.expected;
}

async function main() {
  const runtimeDir = path.join(publicRoot, 'js', 'runtime', 'java21-browserjdk-compat-v1');
  if (!existsSync(path.join(runtimeDir, 'runtime-manifest.json'))) {
    throw new Error('BUILD_REQUIRED / NOT_READY: BrowserJDK runtime manifest missing at ' + runtimeDir);
  }
  const manifest = JSON.parse(readFileSync(path.join(runtimeDir, 'runtime-manifest.json'), 'utf8'));
  const version = runDocker(['run', '--rm', buildImage, 'java', '-version']);
  if (version.error || version.status !== 0) {
    throw new Error('Temurin server baseline unavailable: ' + String(version.error && version.error.message || version.stderr || version.stdout || 'docker failure'));
  }
  const serverVersion = (version.stderr || version.stdout).split(/\r?\n/)[0];
  if (!/21\.0\.10/.test((version.stderr || '') + '\n' + (version.stdout || ''))) {
    throw new Error('Unexpected server baseline version; expected Temurin/OpenJDK 21.0.10+7, got: ' + serverVersion);
  }
  const tests = [...IO_CASES.map(normalizedCase), ...ACM_CASES.map(normalizedCase)];
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({headless: true, executablePath: chromePath});
  const page = await browser.newPage();
  page.on('console', message => console.log(`[chrome:${message.type()}] ${message.text()}`));
  page.on('pageerror', error => console.error('[chrome:pageerror]', error.stack || error));
  const results = [];
  try {
    await page.goto(`http://127.0.0.1:${port}/checkpoint1.html`);
    const boot = await createBrowserRunner(page);
    for (const test of tests) {
      const baseline = serverBaseline(test);
      const browserResult = await browserRun(page, test);
      results.push({name: test.name, server: baseline, browser: browserResult,
        compatibilityMatch: matches(browserResult, baseline),
        correctnessMatch: matchesExpected(browserResult, test)});
      console.log(`${test.name}: browser=${browserResult.verdict} server=${baseline.verdict} compat=${results.at(-1).compatibilityMatch} expected=${results.at(-1).correctnessMatch}`);
    }
    const io = results.slice(0, 12);
    const acm = results.slice(12);
    const score = items => ({
      compatibility: `${items.filter(item => item.compatibilityMatch).length}/${items.length}`,
      correctness: `${items.filter(item => item.correctnessMatch).length}/${items.length}`,
      both: `${items.filter(item => item.compatibilityMatch && item.correctnessMatch).length}/${items.length}`
    });
    const blocked = results.filter(item => item.server.blocked || item.browser.verdict === 'BLOCKED');
    const report = {
      checkpoint: 'JAVA_PHASE7_CHECKPOINT_1', generatedAt: new Date().toISOString(),
      browser: await browser.version(), serverVersion, boot, manifest,
      scores: {
        io: score(io).both,
        acm: score(acm).both,
        ioCompatibility: score(io).compatibility,
        ioCorrectness: score(io).correctness,
        acmCompatibility: score(acm).compatibility,
        acmCorrectness: score(acm).correctness,
        compatibility: `${results.filter(item => item.compatibilityMatch).length}/24`,
        correctness: `${results.filter(item => item.correctnessMatch).length}/24`
      },
      blockingFailures: blocked.map(item => ({name: item.name, server: item.server, browser: item.browser})),
      technicallyValidated: !blocked.length && results.length === 24
        && results.every(item => item.compatibilityMatch && item.correctnessMatch),
      results
    };
    mkdirSync(outputDir, {recursive: true});
    writeFileSync(path.join(outputDir, 'checkpoint1-results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.scores));
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
