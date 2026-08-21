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
    } else if (pathname === '/isolation.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><title>Java isolation</title>');
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
  const resultFile = path.join(here, 'isolation-results.json');
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
    await page.goto(`http://127.0.0.1:${server.address().port}/isolation.html`);
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
      const run = async (source, stdin = '') => {
        const id = requestId++;
        worker.postMessage({type: 'run', requestId: id, source, stdin, className: 'Main', timeoutMs: 30000});
        const message = await waitFor(value => value.type === 'run-result'
          && value.result && value.result.requestId === id, 60000);
        return message.result;
      };
      const primitive = 'public class Main { static int x; public static void main(String[] a) { System.out.println(++x); } }';
      const collection = 'public class Main { static java.util.List<String> x = new java.util.ArrayList<>(); '
        + 'public static void main(String[] a) { x.add("x"); System.out.println(x.size()); } }';
      const input = 'public class Main { public static void main(String[] a) throws Exception { '
        + 'System.out.print(new java.io.BufferedReader(new java.io.InputStreamReader(System.in)).readLine()); } }';
      const output = 'public class Main { public static void main(String[] a) { System.out.print("OUT"); } }';
      const errorOutput = 'public class Main { public static void main(String[] a) { System.err.print("ERR"); } }';
      const failure = 'public class Main { public static void main(String[] a) { throw new IllegalStateException("expected"); } }';
      const alive = 'public class Main { public static void main(String[] a) { System.out.print("ALIVE"); } }';
      const same = 'public class Main { public static void main(String[] a) { System.out.print("SAME"); } }';
      const one = 'public class Main { public static void main(String[] a) { System.out.print("ONE"); } }';
      const two = 'public class Main { public static void main(String[] a) { System.out.print("TWO"); } }';
      const identity = 'public class Main { public static void main(String[] a) { '
        + 'System.out.print(System.identityHashCode(Main.class.getClassLoader())); } }';
      const property = 'phase7.browser.isolation.property';
      const mutateProperty = 'public class Main { public static void main(String[] a) { '
        + 'System.setProperty("' + property + '", "MUTATED"); System.out.print(System.getProperty("' + property + '")); } }';
      const readProperty = 'public class Main { public static void main(String[] a) { '
        + 'System.out.print(System.getProperty("' + property + '", "ABSENT")); } }';
      const mutateLocale = 'public class Main { public static void main(String[] a) { '
        + 'java.util.Locale.setDefault(java.util.Locale.FRANCE); System.out.print(java.util.Locale.getDefault().toLanguageTag()); } }';
      const readLocale = 'public class Main { public static void main(String[] a) { System.out.print(java.util.Locale.getDefault().toLanguageTag()); } }';
      const mutateTimeZone = 'public class Main { public static void main(String[] a) { '
        + 'java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC")); System.out.print(java.util.TimeZone.getDefault().getID()); } }';
      const readTimeZone = 'public class Main { public static void main(String[] a) { System.out.print(java.util.TimeZone.getDefault().getID()); } }';
      // Capture the Java runtime baseline, not the host browser locale/time
      // zone.  The self-built image intentionally boots with en-US/GMT.
      const baselineLocale = (await run(readLocale)).stdout;
      const baselineTimeZone = (await run(readTimeZone)).stdout;
      const runs = {
        A: [await run(primitive), await run(primitive), await run(primitive)],
        B: [await run(collection), await run(collection)],
        C: [await run(input, 'one\n'), await run(input, 'two\n')],
        D: [await run(output), await run(output)],
        E: [await run(errorOutput), await run(errorOutput)],
        F: [await run(failure), await run(alive)],
        G: [await run(same), await run(same)],
        H: [await run(one), await run(two)],
        I: [await run(identity), await run(identity)],
        J: [await run(mutateProperty), await run(readProperty)],
        K: [await run(mutateLocale), await run(readLocale)],
        L: [await run(mutateTimeZone), await run(readTimeZone)]
      };
      worker.terminate();
      return {initialized, baselineLocale, baselineTimeZone, runs};
    });
    const r = report.runs;
    const ac = value => value.status === 'ac' && value.runStatus === 'AC';
    const outputs = (values, expected) => values.every(value => ac(value) && value.stdout === expected);
    const checks = {
      A: outputs(r.A, '1\n'), B: outputs(r.B, '1\n'), C: r.C[0].stdout === 'one' && r.C[1].stdout === 'two',
      D: outputs(r.D, 'OUT'), E: r.E.every(value => ac(value) && value.stdout === '' && value.stderr === 'ERR'),
      F: r.F[0].runStatus === 'RE' && r.F[1].stdout === 'ALIVE', G: outputs(r.G, 'SAME'),
      H: r.H[0].stdout === 'ONE' && r.H[1].stdout === 'TWO', I: r.I[0].stdout !== r.I[1].stdout,
      J: r.J[0].stdout === 'MUTATED' && r.J[1].stdout === 'ABSENT',
      K: r.K[0].stdout === 'fr-FR' && r.K[1].stdout === report.baselineLocale,
      L: r.L[0].stdout === 'UTC' && r.L[1].stdout === report.baselineTimeZone
    };
    const result = {status: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', runtimeId,
      checks, report};
    writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
    if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
