import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
export const ROOT = resolve(here, '..', '..', '..');
export const SERVER_ROOT = join(ROOT, 'server');
export const CHROME_PATH = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const require = createRequire(join(SERVER_ROOT, 'package.json'));
export const {chromium} = require('playwright');

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function byteLength(value) {
  return Buffer.byteLength(String(value == null ? '' : value), 'utf8');
}

export function nowIso() { return new Date().toISOString(); }

export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export async function findFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Start a disposable contest-only OJ with the seeded real Problem Page. */
export async function startLocalContestServer(options = {}) {
  const port = options.port || await findFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'java21-phase7-'));
  const env = {
    ...process.env,
    APP_ENTRY: 'contest',
    HOST: '127.0.0.1',
    PORT: String(port),
    DB_FILE: join(dataDir, 'mini-oj.db'),
    OJ_DB_FILE: join(dataDir, 'oj-main-path.db')
  };
  const child = spawn(process.execPath, ['src/app.js'], {
    cwd: SERVER_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (options.startTimeoutMs || 30000);
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`local server exited ${child.exitCode}: ${stderr || stdout}`);
    }
    try {
      const response = await fetch(`${baseUrl}/contest/login`);
      if (response.ok) break;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  if (Date.now() >= deadline) {
    await stopLocalContestServer({child, dataDir});
    throw new Error(`local server did not start: ${lastError?.message || stderr || stdout}`);
  }
  return {
    baseUrl,
    port,
    child,
    dataDir,
    logs: () => ({stdout, stderr}),
    async stop() { await stopLocalContestServer({child, dataDir}); }
  };
}

async function stopLocalContestServer({child, dataDir}) {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(3000)
    ]);
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, {recursive: true, force: true});
}

/** Launch an actual Chrome binary through Playwright, with a browser process handle. */
export async function launchChrome(options = {}) {
  if (!existsSync(CHROME_PATH)) throw new Error(`Chrome executable not found: ${CHROME_PATH}`);
  const server = await chromium.launchServer({
    headless: process.env.HEADLESS !== 'false',
    executablePath: CHROME_PATH,
    args: ['--enable-precise-memory-info'],
    ...options
  });
  const browser = await chromium.connect({wsEndpoint: server.wsEndpoint()});
  const context = await browser.newContext();
  return {server, browser, context, page: await context.newPage()};
}

export function requestDigest(request) {
  const body = request.postData() || '';
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (_) { /* non-JSON body */ }
  const sensitiveFields = ['code', 'source', 'stdin', 'stdout', 'stderr'];
  const fields = parsed && typeof parsed === 'object'
    ? sensitiveFields.filter(name => Object.prototype.hasOwnProperty.call(parsed, name))
    : [];
  return {
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    bodyBytes: body ? Buffer.byteLength(body) : 0,
    bodySha256: body ? sha256(body) : null,
    bodyFields: fields,
    hasSourceLikeBody: fields.length > 0
  };
}

export function attachRequestLog(page) {
  const entries = [];
  const onRequest = request => entries.push({at: Date.now(), ...requestDigest(request)});
  page.on('request', onRequest);
  return {
    entries,
    mark() { return entries.length; },
    since(index) { return entries.slice(index); },
    detach() { page.off('request', onRequest); }
  };
}

export async function loginAndOpenProblem(page, baseUrl, options = {}) {
  await page.goto(`${baseUrl}/contest/login`, {waitUntil: 'domcontentloaded'});
  await page.locator('#login-username').fill(options.username || 'user1');
  await page.locator('#login-password').fill(options.password || 'user123');
  await Promise.all([
    page.waitForURL(/\/contest\/contests(?:$|\/)/, {waitUntil: 'domcontentloaded'}),
    page.locator('#login-btn').click()
  ]);
  const contest = page.locator('.contest-card').filter({hasText: options.contestTitle || 'Browser OJ E2E Test'}).first();
  await contest.waitFor({state: 'visible', timeout: 15000});
  const contestHref = await contest.getAttribute('href');
  await contest.click();
  await page.waitForURL(/\/contest\/contests\/[^/]+\/problems$/, {waitUntil: 'domcontentloaded'});
  const problem = page.locator('#problem-tbody a').filter({hasText: options.problemTitle || 'A + B'}).first();
  await problem.waitFor({state: 'visible', timeout: 15000});
  const problemHref = await problem.getAttribute('href');
  await problem.click();
  await page.waitForURL(/\/contest\/contests\/[^/]+\/problems\/[^/]+$/, {waitUntil: 'domcontentloaded'});
  await page.locator('#p-title').waitFor({state: 'visible', timeout: 15000});
  return {contestHref, problemHref, problemUrl: page.url(), title: await page.locator('#p-title').innerText()};
}

export async function waitForText(locator, predicate, timeoutMs = 30000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try { last = await locator.innerText({timeoutMs: Math.min(1000, pollMs + 300)}); } catch (_) { last = ''; }
    if (predicate(last)) return last;
    await sleep(pollMs);
  }
  throw new Error(`timed out waiting for text; last=${JSON.stringify(last)}`);
}

export async function evaluateJavaRun(page, source, stdin = '', timeoutMs = 30000) {
  return page.evaluate(async ({source, stdin, timeoutMs}) => {
    const runner = globalThis.__IDE_RUNNER__;
    if (!runner || typeof runner.runJava !== 'function') throw new Error('Java runner unavailable');
    const timeout = new Promise(resolve => setTimeout(() => resolve({
      harnessTimeout: true, runStatus: 'HARNESS_TIMEOUT', stdout: '', stderr: ''
    }), timeoutMs));
    return Promise.race([runner.runJava({source, stdin}), timeout]);
  }, {source, stdin, timeoutMs});
}

/**
 * Collect only diagnostic counters. A missing metric is deliberately represented
 * as null/N/A; this helper never guesses that JS heap or RSS is JVM/WASM memory.
 */
export async function collectMemoryMetrics(page) {
  const pageMetrics = await page.evaluate(async () => {
    const out = {
      wasmLinearMemoryBytes: null,
      configuredMaximumBytes: null,
      runtimeAssetBytes: null,
      javaHeapBytes: null,
      cacheSize: null,
      workerStats: null,
      diagnosticsSource: []
    };
    const add = (name, value) => {
      if (value == null) return;
      out.diagnosticsSource.push(name);
      if (value && typeof value === 'object') {
        if (out.wasmLinearMemoryBytes == null) {
          const n = value.wasmLinearMemoryBytes ?? value.linearMemoryBytes ?? value.heapByteLength
            ?? value.heapBytes ?? value.HEAPU8ByteLength;
          if (Number.isFinite(n)) out.wasmLinearMemoryBytes = n;
        }
        if (out.configuredMaximumBytes == null) {
          const n = value.configuredMaximumBytes ?? value.maximumBytes ?? value.maxMemoryBytes;
          if (Number.isFinite(n)) out.configuredMaximumBytes = n;
        }
        if (out.runtimeAssetBytes == null) {
          const n = value.runtimeAssetBytes ?? value.assetBytes ?? value.runtimeBytes;
          if (Number.isFinite(n)) out.runtimeAssetBytes = n;
        }
        if (out.javaHeapBytes == null) {
          const n = value.javaHeapBytes ?? value.jvmHeapBytes;
          if (Number.isFinite(n)) out.javaHeapBytes = n;
        }
        if (out.cacheSize == null) {
          const n = value.cacheSize ?? value.compiledCacheSize ?? value.compileCacheSize ?? value.artifactCacheSize;
          if (Number.isFinite(n)) out.cacheSize = n;
        }
        if (out.workerStats == null && (value.workerStats || value.state || value.runCount != null)) {
          out.workerStats = value.workerStats || value;
        }
      }
    };
    const candidates = [
      ['__JAVA_MEMORY_DIAGNOSTICS__', globalThis.__JAVA_MEMORY_DIAGNOSTICS__],
      ['__JAVA_MEMORY_STATS__', globalThis.__JAVA_MEMORY_STATS__],
      ['__BROWSERJDK_MEMORY__', globalThis.__BROWSERJDK_MEMORY__],
      ['__JAVA_WASM_MEMORY__', globalThis.__JAVA_WASM_MEMORY__],
      ['__JAVA_WORKER_STATS__', globalThis.__JAVA_WORKER_STATS__]
    ];
    for (const [name, candidate] of candidates) {
      try { add(name, typeof candidate === 'function' ? await candidate() : candidate); } catch (_) { /* unavailable */ }
    }
    const runner = globalThis.__IDE_RUNNER__;
    if (runner) {
      for (const [name, fn] of [['javaStats', runner.javaStats], ['memoryDiagnostics', runner.memoryDiagnostics]]) {
        if (typeof fn === 'function') {
          try { add(`__IDE_RUNNER__.${name}`, await fn.call(runner)); } catch (_) { /* unavailable */ }
        }
      }
    }
    const modules = [globalThis.Module, globalThis.__JAVA_MODULE__, globalThis.__BROWSERJDK_MODULE__];
    for (const module of modules) {
      if (!module) continue;
      try {
        const buffer = module.HEAPU8?.buffer || module.HEAP8?.buffer || module.wasmMemory?.buffer;
        if (buffer && Number.isFinite(buffer.byteLength)) {
          out.wasmLinearMemoryBytes = buffer.byteLength;
          out.diagnosticsSource.push('Module.HEAPU8.buffer');
        }
        const maximum = module.wasmMemory?.maximum;
        if (Number.isFinite(maximum)) out.configuredMaximumBytes = maximum * 65536;
      } catch (_) { /* hidden module */ }
    }
    if (typeof performance !== 'undefined' && performance.memory) {
      out.jsHeap = {
        usedJSHeapSize: Number.isFinite(performance.memory.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null,
        totalJSHeapSize: Number.isFinite(performance.memory.totalJSHeapSize) ? performance.memory.totalJSHeapSize : null,
        jsHeapSizeLimit: Number.isFinite(performance.memory.jsHeapSizeLimit) ? performance.memory.jsHeapSizeLimit : null
      };
    } else out.jsHeap = null;
    return out;
  });
  return pageMetrics;
}

export async function cdpMetrics(page) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const result = await session.send('Performance.getMetrics');
    const map = Object.fromEntries((result.metrics || []).map(item => [item.name, item.value]));
    return {
      usedJSHeapSize: Number.isFinite(map.JSHeapUsedSize) ? Math.round(map.JSHeapUsedSize) : null,
      totalJSHeapSize: Number.isFinite(map.JSHeapTotalSize) ? Math.round(map.JSHeapTotalSize) : null,
      documents: Number.isFinite(map.Documents) ? map.Documents : null,
      jsEventListeners: Number.isFinite(map.JSEventListeners) ? map.JSEventListeners : null,
      source: 'CDP Performance.getMetrics'
    };
  } catch (error) {
    return {usedJSHeapSize: null, totalJSHeapSize: null, source: 'N/A', error: error.message};
  }
}

export async function browserVersion(browser) {
  try { return await browser.version(); } catch (_) { return 'unknown'; }
}
