import {createServer} from 'node:http';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
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
  return ({'.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm',
    '.data': 'application/octet-stream'})[path.extname(file)] || 'application/octet-stream';
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
    } else if (pathname === '/cache.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>Java cache</title>');
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
  const resultFile = path.join(here, 'cache-results.json');
  if (!existsSync(runtimeDir) || !existsSync(path.join(runtimeDir, 'runtime-manifest.json'))) {
    const blocked = {status: 'BLOCKED', runtimeId, reason: 'v2 runtime assets are not installed'};
    writeFileSync(resultFile, JSON.stringify(blocked, null, 2) + '\n');
    console.log(JSON.stringify(blocked));
    process.exitCode = 2;
    return;
  }
  const require = createRequire(path.join(root, 'server', 'package.json'));
  const {chromium} = require('playwright');
  const server = await startServer();
  const browser = await chromium.launch({headless: true, executablePath: chromePath});
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/cache.html`);
    const report = await page.evaluate(async () => {
      const worker = new Worker('/js/contest/ide-java-worker.js', {type: 'module'});
      let requestId = 1;
      const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker message timeout')), timeoutMs);
        const onMessage = event => {
          const value = event.data || {};
          if (!predicate(value)) return;
          clearTimeout(timer); worker.removeEventListener('message', onMessage); resolve(value);
        };
        worker.addEventListener('message', onMessage);
      });
      worker.postMessage({type: 'init'});
      const initialized = await waitFor(value => value.type === 'inited' || value.type === 'init-failed', 180000);
      if (initialized.type !== 'inited') throw new Error(initialized.error || 'worker init failed');
      const run = async (source, stdin) => {
        const id = requestId++;
        worker.postMessage({type: 'run', requestId: id, source, stdin, className: 'Main', timeoutMs: 30000});
        const message = await waitFor(value => value.type === 'run-result'
          && value.result && value.result.requestId === id, 60000);
        return message.result;
      };
      const source = 'public class Main { public static void main(String[] a) throws Exception {'
        + ' System.out.print(new java.io.BufferedReader(new java.io.InputStreamReader(System.in)).readLine()); } }';
      const first = await run(source, 'stdin-1\n');
      const second = await run(source, 'stdin-2\n');
      const third = await run(source, 'stdin-3\n');
      const modified = await run(source + '\n', 'changed\n');
      worker.terminate();
      return {initialized, first, second, third, modified};
    });
    const pass = report.first.status === 'ac' && report.first.cacheHit === false
      && report.first.compileStatus === 'PASS' && report.first.stdout === 'stdin-1'
      && report.second.status === 'ac' && report.second.cacheHit === true
      && report.second.compileStatus === 'SKIP' && report.second.compileTime === 0
      && report.second.stdout === 'stdin-2'
      && report.third.status === 'ac' && report.third.cacheHit === true
      && report.third.compileStatus === 'SKIP' && report.third.compileTime === 0
      && report.third.stdout === 'stdin-3'
      && report.modified.status === 'ac' && report.modified.cacheHit === false
      && report.modified.compileStatus === 'PASS' && report.modified.stdout === 'changed';
    const result = {status: pass ? 'PASS' : 'FAIL', runtimeId, pass, report};
    writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    if (!pass) process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
