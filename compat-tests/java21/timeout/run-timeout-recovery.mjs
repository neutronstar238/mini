import {createServer} from 'node:http';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const publicRoot = path.join(root, 'server', 'public');
const runtimeId = 'java21-browserjdk-compat-v2';
const runtimeDir = path.join(publicRoot, 'js', 'runtime', runtimeId);
const chromePath = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function mime(file) {
  const ext = path.extname(file);
  return ({'.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json',
    '.wasm': 'application/wasm', '.data': 'application/octet-stream'})[ext]
    || 'application/octet-stream';
}

async function startServer() {
  const server = createServer((request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch (_) { response.writeHead(400).end(); return; }
    let file;
    if (pathname === '/js/contest/ide-java-worker.js') file = path.join(publicRoot, pathname);
    else if (pathname.startsWith('/runtime/' + runtimeId + '/')) {
      file = path.join(runtimeDir, pathname.slice(('/runtime/' + runtimeId + '/').length));
    } else if (pathname === '/timeout.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>Java timeout</title>');
      return;
    } else { response.writeHead(404).end(); return; }
    if (!file.startsWith(publicRoot + path.sep) || !existsSync(file)) {
      response.writeHead(404).end('not found'); return;
    }
    response.setHeader('Content-Type', mime(file));
    response.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function main() {
  const workerPath = path.join(publicRoot, 'js', 'contest', 'ide-java-worker.js');
  if (!existsSync(runtimeDir) || !existsSync(path.join(runtimeDir, 'runtime-manifest.json'))) {
    const blocked = {status: 'BLOCKED', reason: 'v2 runtime assets are not installed', runtimeId};
    writeFileSync(path.join(here, 'timeout-results.json'), JSON.stringify(blocked, null, 2) + '\n');
    console.log(JSON.stringify(blocked));
    process.exitCode = 2;
    return;
  }
  const workerSource = readFileSync(workerPath, 'utf8');
  for (const required of ["LOCAL_TIMEOUT_MESSAGE", "runtime.dispose()", "STATE.NOT_LOADED",
    "java21-browserjdk-compat-v2"]) {
    if (!workerSource.includes(required)) throw new Error('worker timeout contract missing: ' + required);
  }
  const require = createRequire(path.join(root, 'server', 'package.json'));
  const {chromium} = require('playwright');
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({headless: true, executablePath: chromePath});
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/timeout.html`);
    const report = await page.evaluate(async () => {
      let sequence = 1;
      let restartCount = 0;
      const createWorker = async () => {
        const worker = new Worker('/js/contest/ide-java-worker.js', {type: 'module'});
        const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('worker message timeout')), timeoutMs);
          const onMessage = event => {
            const value = event.data || {};
            if (!predicate(value)) return;
            clearTimeout(timer); worker.removeEventListener('message', onMessage); resolve(value);
          };
          worker.addEventListener('message', onMessage);
        });
        worker.postMessage({
          type: 'init',
          interruptBuffer: new Int32Array(new SharedArrayBuffer(4))
        });
        const initialized = await waitFor(value => value.type === 'inited' || value.type === 'init-failed', 180000);
        if (initialized.type !== 'inited') {
          worker.terminate();
          throw new Error(initialized.error || 'worker init failed');
        }
        return {worker, waitFor};
      };
      let session = await createWorker();
      const restartWorker = async () => {
        /* Required fallback evidence: discard the Java Worker itself, then
         * initialize a completely new worker before the next run. */
        session.worker.terminate();
        restartCount++;
        session = await createWorker();
      };
      const run = async (source, timeoutMs = 6000) => {
        const requestId = sequence++;
        const started = performance.now();
        session.worker.postMessage({type: 'run', requestId, source, stdin: '', className: 'Main', timeoutMs});
        const message = await session.waitFor(value => value.type === 'run-result'
          && value.result && value.result.requestId === requestId, timeoutMs + 15000);
        return {elapsedMs: Math.round(performance.now() - started), ...message.result};
      };
      const infinite = 'public class Main { public static void main(String[] a) { while (true) {} } }';
      const busy = 'public class Main { public static void main(String[] a) { for (;;) { long x = 1; x++; } } }';
      // A bare zero-argument recursion can take an unexpectedly long time on
      // the Zero interpreter.  Use 120 long parameters (240 local slots) so
      // each frame consumes substantial native/WASM stack and the runtime's
      // real StackOverflowError guard gets a chance to fire within the 6s
      // protection window.
      const parameters = Array.from({length: 120}, (_, i) => 'long p' + i).join(',');
      const argumentsList = Array.from({length: 120}, () => '0').join(',');
      const recurse = 'public class Main { static void f(' + parameters + ') {'
        + ' if (p0 == Long.MIN_VALUE) System.out.print(p0); f(' + argumentsList + '); } '
        + 'public static void main(String[] a) { f(' + argumentsList + '); } }';
      const alive = 'public class Main { public static void main(String[] a) { System.out.print("ALIVE"); } }';
      const first = await run(infinite);
      await new Promise(resolve => setTimeout(resolve, 800));
      await restartWorker();
      const second = await run(busy);
      await new Promise(resolve => setTimeout(resolve, 800));
      await restartWorker();
      const third = await run(recurse);
      await new Promise(resolve => setTimeout(resolve, 800));
      await restartWorker();
      const recovered = await run(alive, 30000);
      session.worker.terminate();
      return {first, second, third, recovered, restartCount};
    });
    const timeoutPass = [report.first, report.second].every(result =>
      result.status === 'timeout' && result.runStatus === 'TLE'
      && result.timedOut && result.elapsedMs >= 5000 && result.elapsedMs < 15000);
    const stackOverflowRe = report.third.runStatus === 'RE'
      && /StackOverflowError/.test(report.third.tracebackClass || '');
    const recursionTimeoutFallback = report.third.status === 'timeout'
      && report.third.runStatus === 'TLE' && report.third.timedOut;
    const recursionPass = stackOverflowRe || recursionTimeoutFallback;
    const recoveryPass = report.recovered.runStatus === 'AC' && report.recovered.stdout === 'ALIVE';
    const result = {status: timeoutPass && recursionPass && recoveryPass ? 'PASS' : 'FAIL',
      runtimeId, timeoutPass, recursionPass, recursionClassification: stackOverflowRe
        ? 'STACK_OVERFLOW_RE' : (recursionTimeoutFallback ? 'LOCAL_TIMEOUT_FALLBACK' : 'FAIL'),
      recoveryPass, report};
    writeFileSync(path.join(here, 'timeout-results.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
