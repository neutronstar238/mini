/*
 * Java Phase 7 Checkpoint 2 corpus/error matrix.
 *
 * This runner deliberately treats the folder corpus as data: every source is
 * compiled and executed by the pinned server image, then the same source is
 * sent through the production BrowserJDK worker in a real Chromium page.
 * Diagnostic text is retained for evidence, but verdict/class matching does
 * not require browser and javac stack traces to be byte-for-byte identical.
 */
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const corpusRoot = path.join(here, 'corpus');
const errorRoot = path.join(here, 'errors');
const resultDir = path.join(here, 'results');
const reportPath = path.join(resultDir, 'java21-compatibility-matrix.json');
const publicRoot = path.join(root, 'server', 'public');
// Checkpoint 2 changes the CompileServer/bytecode-cache contract.  Keep the
// v1 checkpoint runner untouched; this production matrix targets v2.
const runtimeId = 'java21-browserjdk-compat-v2';
const runtimePath = `/runtime/${runtimeId}`;
const serverImage = process.env.JAVA21_SERVER_IMAGE || 'browserjdk-oj-build:emsdk-5.0.2';
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const require = createRequire(path.join(root, 'server', 'package.json'));

function readText(file) { return readFileSync(file, 'utf8'); }

function cleanOutput(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '').replace(/\n+$/g, '');
}

function simpleClass(value) {
  const text = String(value || '');
  const match = text.match(/([\w$]+(?:Exception|Error))(?::|\s|$)/);
  return match ? match[1] : text.split('.').pop() || '';
}

function exceptionFrom(text) {
  const match = String(text || '').match(/(?:Exception in thread "main" )?([\w.$]+(?:Exception|Error))(?::|\s|$)/);
  return match ? simpleClass(match[1]) : '';
}

function docker(args, input = '', timeout = 120000) {
  return spawnSync('docker', args, {input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024});
}

function imageAvailable() {
  const check = docker(['image', 'inspect', serverImage], '', 30000);
  return !check.error && check.status === 0;
}

function mountPath(file) { return file.replace(/\\/g, '/'); }

function runDockerCase(item, expectedVerdict) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'java21-checkpoint2-'));
  try {
    writeFileSync(path.join(workspace, 'Main.java'), item.source, 'utf8');
    writeFileSync(path.join(workspace, 'stdin.txt'), item.input, 'utf8');
    const mount = `type=bind,src=${mountPath(workspace)},dst=/case`;
    const compile = docker(['run', '--rm', '--mount', mount, '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8', serverImage, 'bash', '-lc',
      'cd /case && javac --release 21 -encoding UTF-8 Main.java'], '', 30000);
    if (compile.error || compile.status === null) {
      return {verdict: 'BLOCKED', compileStatus: 'BLOCKED', stdout: '', stderr: String(compile.error?.message || compile.stderr || 'Docker compile unavailable'), exceptionClass: '', blocked: true};
    }
    if (compile.status !== 0) {
      return {verdict: 'CE', compileStatus: 'CE', stdout: '', stderr: compile.stderr || compile.stdout || '', exceptionClass: '', expectedVerdict};
    }
    // Docker Desktop can spend several seconds finalising a short-lived
    // container even after Java has produced stdout. Keep this separate from
    // the Java program's own semantics and allow a bounded 30s cleanup window.
    const execution = docker(['run', '--rm', '-i', '--mount', mount, '-e', 'LANG=C.UTF-8', '-e', 'LC_ALL=C.UTF-8', serverImage, 'bash', '-lc',
      'cd /case && java -Dfile.encoding=UTF-8 -Xss64M -Xms32M -Xmx192M -cp . Main'], item.input, 30000);
    if (execution.error || execution.status === null) {
      return {verdict: 'BLOCKED', compileStatus: 'PASS', stdout: execution.stdout || '', stderr: String(execution.error?.message || execution.stderr || 'Docker execution unavailable'), exceptionClass: '', blocked: true};
    }
    if (execution.status !== 0) {
      return {verdict: 'RE', compileStatus: 'PASS', stdout: execution.stdout || '', stderr: execution.stderr || '', exceptionClass: exceptionFrom(execution.stderr), expectedVerdict};
    }
    return {verdict: 'AC', compileStatus: 'PASS', stdout: execution.stdout || '', stderr: execution.stderr || '', exceptionClass: '', expectedVerdict};
  } finally {
    rmSync(workspace, {recursive: true, force: true});
  }
}

function loadCases(folder, suite) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).sort().filter(name => {
    const full = path.join(folder, name);
    return existsSync(path.join(full, 'Main.java'));
  }).map(name => {
    const dir = path.join(folder, name);
    const metaFile = path.join(dir, 'meta.json');
    const meta = existsSync(metaFile) ? JSON.parse(readText(metaFile)) : {};
    return {
      suite, id: name, source: readText(path.join(dir, 'Main.java')),
      input: existsSync(path.join(dir, 'input.txt')) ? readText(path.join(dir, 'input.txt')) : '',
      expected: existsSync(path.join(dir, 'expected.txt')) ? readText(path.join(dir, 'expected.txt')) : '',
      meta, expectedVerdict: String(meta.expectedVerdict || 'AC').toUpperCase()
    };
  });
}

function statusMatches(actual, expected) { return String(actual || '').toUpperCase() === String(expected || '').toUpperCase(); }

function classMatches(actual, expected) {
  if (!expected) return true;
  return simpleClass(actual) === simpleClass(expected);
}

function expectedMatches(actual, item) {
  if (!statusMatches(actual.verdict, item.expectedVerdict)) return false;
  if (item.expectedVerdict === 'AC') return cleanOutput(actual.stdout) === cleanOutput(item.expected);
  if (item.expectedVerdict === 'RE') return classMatches(actual.exceptionClass, item.meta.expectedException);
  return true;
}

function runtimeMatches(browser, server) {
  if (!statusMatches(browser.verdict, server.verdict)) return false;
  if (server.verdict === 'AC') return cleanOutput(browser.stdout) === cleanOutput(server.stdout);
  if (server.verdict === 'RE') return classMatches(browser.exceptionClass, server.exceptionClass);
  return true;
}

function compileMatches(browser, server) {
  return statusMatches(browser.compileStatus, server.compileStatus)
    || (server.compileStatus === 'PASS' && statusMatches(browser.compileStatus, 'PASS'))
    || (server.compileStatus === 'CE' && statusMatches(browser.compileStatus, 'CE'));
}

function mime(file) {
  return ({'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.wasm': 'application/wasm', '.data': 'application/octet-stream'})[path.extname(file)] || 'application/octet-stream';
}

async function startStaticServer() {
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (request.url === '/checkpoint2.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>Java 21 Checkpoint 2</title>');
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); } catch (_) { response.writeHead(400).end(); return; }
    if (pathname.startsWith('/runtime/')) pathname = '/js' + pathname;
    const file = path.resolve(publicRoot, '.' + pathname);
    if (!file.startsWith(publicRoot + path.sep)) { response.writeHead(403).end(); return; }
    try { const body = readFileSync(file); response.setHeader('Content-Type', mime(file)); response.setHeader('Content-Length', body.length); response.end(body); }
    catch (_) { response.writeHead(404).end('not found'); }
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
      const index = pending.findIndex(waiter => waiter.type === event.data?.type);
      if (index >= 0) pending.splice(index, 1)[0].resolve(event.data);
    });
    const waitFor = (type, timeoutMs) => new Promise((resolve, reject) => {
      const waiter = {type, resolve}; pending.push(waiter);
      setTimeout(() => { const index = pending.indexOf(waiter); if (index >= 0) pending.splice(index, 1); reject(new Error('worker timeout waiting for ' + type)); }, timeoutMs);
    });
    const started = performance.now();
    const initialized = await new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => { if (done) return; done = true; worker.removeEventListener('message', onMessage); worker.removeEventListener('error', onError); error ? reject(error) : resolve(value); };
      const onMessage = event => { if (event.data?.type === 'inited') finish(null, event.data); else if (event.data?.type === 'init-failed') finish(new Error(event.data.error || 'worker init failed')); };
      const onError = event => finish(new Error(event.message || 'worker error during init'));
      worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.postMessage({type: 'init'});
      setTimeout(() => finish(new Error('worker initialization timeout')), 180000);
    });
    globalThis.__java21Worker = worker; globalThis.__java21WaitFor = waitFor;
    return {bootWallMs: Math.round(performance.now() - started), ...initialized};
  });
}

async function browserRun(page, item) {
  const sourceHash = createHash('sha256').update(item.source, 'utf8').digest('hex');
  return page.evaluate(async value => {
    globalThis.__java21Worker.postMessage({type: 'run', source: value.source, sourceHash: value.sourceHash, stdin: value.input, className: 'Main', timeoutMs: value.timeoutMs});
    const message = await globalThis.__java21WaitFor('run-result', value.timeoutMs + 30000);
    const result = message.result || {};
    return {verdict: String(result.runStatus || result.verdict || 'UNAVAILABLE').toUpperCase(),
      compileStatus: String(result.compileStatus || '').toUpperCase(), stdout: result.stdout || '', stderr: result.stderr || '',
      exceptionClass: result.tracebackClass || result.exceptionClass || '', compileMs: result.compileTime || result.compileMs || 0,
      executionMs: result.executionTime || result.executionMs || 0, cacheHit: result.cacheHit === true, status: result.status || ''};
  }, {source: item.source, sourceHash, input: item.input, timeoutMs: item.expectedVerdict === 'TLE' ? 10000 : 30000});
}

async function main() {
  const errorsOnly = process.argv.includes('--errors-only');
  const positive = errorsOnly ? [] : loadCases(corpusRoot, 'positive').filter(item => item.expectedVerdict === 'AC');
  const errors = loadCases(errorRoot, 'error');
  const cases = [...positive, ...errors];
  const report = {
    checkpoint: 'JAVA_PHASE7_CHECKPOINT_2', generatedAt: new Date().toISOString(), runtimeId, runtimePath,
    serverImage, suiteFilter: errorsOnly ? 'error' : 'all', positiveCaseCount: positive.length, errorCaseCount: errors.length,
    environment: {server: {}, browser: {}, blockers: []}, scores: {}, results: []
  };
  if (!cases.length) throw new Error('No Java corpus or error cases found');
  const imageOk = imageAvailable();
  if (!imageOk) report.environment.blockers.push('Pinned OpenJDK 21 Docker image unavailable: ' + serverImage);
  const serverVersion = imageOk ? docker(['run', '--rm', serverImage, 'java', '-version'], '', 30000) : null;
  report.environment.server = {image: serverImage, imageAvailable: imageOk, javaVersion: serverVersion ? (serverVersion.stderr || serverVersion.stdout || '').trim() : null};
  let browser = null, page = null, staticServer = null, browserInit = null;
  try {
    staticServer = await startStaticServer();
    const {chromium} = require('playwright');
    browser = await chromium.launch({headless: true, executablePath: chromePath});
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${staticServer.address().port}/checkpoint2.html`);
    browserInit = await createBrowserRunner(page);
    report.environment.browser = {chromePath, version: await browser.version(), initialized: true, init: browserInit};
  } catch (error) {
    report.environment.browser = {chromePath, initialized: false, error: String(error?.stack || error)};
    report.environment.blockers.push('BrowserJDK harness unavailable: ' + String(error?.message || error));
  }
  for (const item of cases) {
    const server = imageOk ? runDockerCase(item, item.expectedVerdict) : {verdict: 'BLOCKED', compileStatus: 'BLOCKED', stdout: '', stderr: 'server image unavailable', exceptionClass: '', blocked: true};
    let browserResult;
    if (page) {
      try { browserResult = await browserRun(page, item); }
      catch (error) { browserResult = {verdict: 'BLOCKED', compileStatus: 'BLOCKED', stdout: '', stderr: String(error?.stack || error), exceptionClass: '', cacheHit: false}; }
    } else browserResult = {verdict: 'BLOCKED', compileStatus: 'BLOCKED', stdout: '', stderr: 'browser harness unavailable', exceptionClass: '', cacheHit: false};
    const result = {
      suite: item.suite, id: item.id, category: item.meta.category || '', expectedVerdict: item.expectedVerdict,
      expectedException: item.meta.expectedException || null,
      server: {...server, stdout: cleanOutput(server.stdout), stderr: String(server.stderr || '').slice(0, 4000)},
      browser: {...browserResult, stdout: cleanOutput(browserResult.stdout), stderr: String(browserResult.stderr || '').slice(0, 4000)},
      browserMatchesServer: runtimeMatches(browserResult, server),
      browserMatchesExpected: expectedMatches(browserResult, item),
      serverMatchesExpected: expectedMatches(server, item),
      compileMatch: compileMatches(browserResult, server),
      errorClassMatch: item.suite !== 'error' || classMatches(browserResult.exceptionClass, item.meta.expectedException) && classMatches(server.exceptionClass, item.meta.expectedException)
    };
    report.results.push(result);
    console.log(`${item.suite}/${item.id}: browser=${result.browser.verdict} server=${result.server.verdict} compat=${result.browserMatchesServer} expected=${result.browserMatchesExpected && result.serverMatchesExpected}`);
  }
  const positives = report.results.filter(r => r.suite === 'positive');
  const negatives = report.results.filter(r => r.suite === 'error');
  const count = (items, key) => `${items.filter(item => item[key]).length}/${items.length}`;
  report.scores = {
    positiveCompileMatch: count(positives, 'compileMatch'),
    compatibilityRuntimeMatch: count(positives, 'browserMatchesServer'),
    correctnessRuntimeMatch: count(positives, 'browserMatchesExpected'),
    serverCorrectness: count(positives, 'serverMatchesExpected'),
    negativeCompatibility: count(negatives, 'browserMatchesServer'),
    negativeClassification: count(negatives, 'errorClassMatch'),
    negativeBrowserExpected: count(negatives, 'browserMatchesExpected'),
    negativeServerExpected: count(negatives, 'serverMatchesExpected'),
    allPositivePass: positives.length >= 30 && positives.every(item => item.browserMatchesServer && item.browserMatchesExpected && item.serverMatchesExpected),
    allErrorsPass: negatives.length >= 8 && negatives.every(item => item.browserMatchesServer && item.errorClassMatch && item.browserMatchesExpected && item.serverMatchesExpected)
  };
  report.blockingFailures = report.results.filter(item => !item.browserMatchesServer || !item.browserMatchesExpected || !item.serverMatchesExpected || !item.errorClassMatch || item.server.blocked || item.browser.verdict === 'BLOCKED');
  mkdirSync(resultDir, {recursive: true});
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({reportPath, ...report.scores}));
  if (browser) await browser.close();
  if (staticServer) await new Promise(resolve => staticServer.close(resolve));
  if (report.blockingFailures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 2; });
