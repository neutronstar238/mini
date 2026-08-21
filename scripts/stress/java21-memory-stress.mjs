import {appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {
  browserVersion,
  cdpMetrics,
  collectMemoryMetrics,
  evaluateJavaRun,
  launchChrome,
  loginAndOpenProblem,
  nowIso,
  ROOT,
  startLocalContestServer,
  sleep
} from '../../compat-tests/java21/e2e/harness.mjs';

const REPORT = process.env.JAVA21_MEMORY_REPORT
  || join(process.cwd(), 'compat-tests', 'java21', 'memory', 'java21-memory-stress.json');
const PROGRESS = process.env.JAVA21_MEMORY_PROGRESS
  || join(process.cwd(), 'compat-tests', 'java21', 'memory', 'java21-memory-stress-progress.jsonl');
const BASE_URL = process.env.BASE_URL || '';
const DIFFERENT_COUNT = Number(process.env.STRESS_DIFFERENT_COUNT || 500);
const SAME_COUNT = Number(process.env.STRESS_SAME_COUNT || 1000);
const SAMPLE_EVERY = Number(process.env.STRESS_SAMPLE_EVERY || 25);
const WATCHDOG_MS = Number(process.env.STRESS_WATCHDOG_MS || 15 * 60 * 1000);
const RUN_TIMEOUT_MS = Number(process.env.STRESS_RUN_TIMEOUT_MS || 120000);
const PRE_JAVA_SETTLE_MS = Number(process.env.STRESS_PRE_JAVA_SETTLE_MS || 0);

const SAME_SOURCE = `import java.io.*;
public class Main { public static void main(String[] args) throws Exception {
  BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
  System.out.print(br.readLine());
} }`;
const CAP_SOURCE = 'public class Main { public static void main(String[] args) { System.out.print("x".repeat(1048600)); } }';
const JAVA_RUNTIME_ID = 'java21-browserjdk-compat-v2';
const RUNTIME_DIR = join(ROOT, 'server', 'public', 'js', 'runtime', JAVA_RUNTIME_ID);

function timestamp() { return Date.now(); }

function progress(id, details = '') {
  console.error(`[JAVA_PHASE7_A13] ${new Date().toISOString()} ${id}${details ? ` ${details}` : ''}`);
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

function browserProcessRss(server) {
  const pid = server?.process?.()?.pid;
  if (!pid || process.platform !== 'win32') return {bytes: null, label: 'Browser Process RSS', source: 'N/A'};
  try {
    const script = `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.WorkingSet64 }`;
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', timeout: 5000}).trim();
    const bytes = Number(raw);
    return {bytes: Number.isFinite(bytes) ? bytes : null, label: 'Browser Process RSS', source: 'Get-Process WorkingSet64', pid};
  } catch (error) { return {bytes: null, label: 'Browser Process RSS', source: 'N/A', error: error.message, pid}; }
}

function runtimeAssetSummary() {
  const manifestPath = join(RUNTIME_DIR, 'runtime-manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const assets = Array.isArray(manifest.assets) ? manifest.assets.map(asset => {
      const file = String(asset.file || '');
      const manifestBytes = Number(asset.bytes);
      let rawBytes = null;
      try { rawBytes = statSync(join(RUNTIME_DIR, file)).size; } catch (_) { /* recorded below */ }
      return {file, manifestBytes: Number.isFinite(manifestBytes) ? manifestBytes : null, rawBytes};
    }) : [];
    const rawBytes = assets.every(asset => Number.isFinite(asset.rawBytes))
      ? assets.reduce((sum, asset) => sum + asset.rawBytes, 0) : null;
    return {
      manifestPath,
      manifestRuntimeId: manifest.runtimeId || null,
      manifestStatus: manifest.status || null,
      assets,
      rawBytes,
      transferBytes: 'N/A',
      transferAccounting: 'N/A: browser transfer/compression bytes are not exposed by this request harness'
    };
  } catch (error) {
    return {
      manifestPath, manifestRuntimeId: null, manifestStatus: null, assets: [], rawBytes: null,
      transferBytes: 'N/A',
      transferAccounting: 'N/A: runtime-manifest.json unavailable',
      error: error.message
    };
  }
}

function extractNumeric(metrics, names) {
  const seen = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object' || seen.has(value)) return null;
    seen.add(value);
    for (const name of names) {
      const n = value[name];
      if (Number.isFinite(n)) return n;
    }
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found != null) return found;
    }
    return null;
  };
  return visit(metrics);
}

async function sample(page, server, phase, iteration, runtimeAssets) {
  const pageMemory = await collectMemoryMetrics(page);
  const cdp = await cdpMetrics(page);
  return {
    at: nowIso(), phase, iteration,
    wasmLinearMemoryBytes: pageMemory.wasmLinearMemoryBytes,
    configuredMaximumBytes: pageMemory.configuredMaximumBytes,
    javaHeapBytes: pageMemory.javaHeapBytes,
    jsHeap: pageMemory.jsHeap || cdp,
    browserProcessRss: browserProcessRss(server),
    runtimeAssetBytes: runtimeAssets.rawBytes,
    runtimeAssetTransferBytes: runtimeAssets.transferBytes,
    cacheSize: extractNumeric(pageMemory, ['cacheSize', 'compiledCacheSize', 'compileCacheSize', 'artifactCacheSize']),
    workerStats: pageMemory.workerStats,
    diagnosticsSource: pageMemory.diagnosticsSource,
    cdp
  };
}

async function sampleSafe(page, server, phase, iteration, runtimeAssets) {
  try { return await withTimeout(sample(page, server, phase, iteration, runtimeAssets), 30000, `memory sample ${phase}/${iteration}`); }
  catch (error) {
    progress(`sample:${phase}/${iteration}`, `N/A ${String(error?.message || error).slice(0, 120)}`);
    return {
      at: nowIso(), phase, iteration,
      wasmLinearMemoryBytes: null, configuredMaximumBytes: null, javaHeapBytes: null,
      jsHeap: 'N/A', browserProcessRss: {bytes: null, label: 'Browser Process RSS', source: 'N/A'},
      runtimeAssetBytes: runtimeAssets.rawBytes, runtimeAssetTransferBytes: runtimeAssets.transferBytes,
      cacheSize: null, workerStats: null, diagnosticsSource: [], cdp: 'N/A', sampleError: String(error?.message || error)
    };
  }
}

function metricRange(samples, key, idleSample = null, after100Sample = null) {
  const values = samples.map(item => item[key]).filter(Number.isFinite);
  if (!values.length) return {initial: null, idle: null, after100: null, peak: null, final: null, units: 'N/A'};
  return {
    initial: values[0],
    idle: Number.isFinite(idleSample?.[key]) ? idleSample[key] : values[0],
    after100: Number.isFinite(after100Sample?.[key]) ? after100Sample[key] : null,
    peak: Math.max(...values),
    final: values.at(-1),
    units: 'bytes'
  };
}

function stableWindowAssessment(samples, key) {
  const valueOf = item => key.split('.').reduce((value, part) => value?.[part], item);
  const points = samples
    .filter(item => (item.phase === 'different-sources' || item.phase === 'same-source-different-stdin')
      && item.iteration >= 8 && Number.isFinite(valueOf(item)));
  if (points.length < 2) {
    return {
      status: 'N/A',
      criterion: 'N/A until at least two post-LRU-warmup samples are available',
      points: points.length, deltaBytes: null, slopeBytesPerRun: null, positiveStepRatio: null
    };
  }
  const window = points.slice(Math.floor(points.length / 2));
  const deltas = window.slice(1).map((point, index) => valueOf(point) - valueOf(window[index]));
  const positiveSteps = deltas.filter(delta => delta > 0).length;
  const runDelta = window.at(-1).iteration - window[0].iteration;
  const deltaBytes = valueOf(window.at(-1)) - valueOf(window[0]);
  const positiveStepRatio = deltas.length ? positiveSteps / deltas.length : 0;
  const slopeBytesPerRun = runDelta > 0 ? deltaBytes / runDelta : null;
  // Browser/process counters have sub-MiB allocator and sampling noise. Treat
  // growth as material only when it exceeds both 8 MiB and 5% of the stable
  // window baseline; the positive-step ratio then distinguishes a trend from
  // a single allocation stair-step.
  const baselineBytes = valueOf(window[0]);
  const materialGrowthBytes = Math.max(8 * 1024 * 1024, baselineBytes * 0.05);
  const sustainedPositive = deltaBytes >= materialGrowthBytes && positiveStepRatio >= 0.75;
  return {
    status: sustainedPositive ? 'FAIL' : 'PASS',
    criterion: 'After cache warm-up, reject growth only when delta is at least max(8 MiB, 5% of baseline) and at least 75% of sample-to-sample steps are positive.',
    points: window.length,
    firstIteration: window[0].iteration,
    lastIteration: window.at(-1).iteration,
    deltaBytes,
    materialGrowthBytes,
    slopeBytesPerRun,
    positiveSteps,
    positiveStepRatio
  };
}

function jsHeapRange(samples, idleSample = null) {
  const used = samples.map(item => item.jsHeap?.usedJSHeapSize).filter(Number.isFinite);
  const total = samples.map(item => item.jsHeap?.totalJSHeapSize).filter(Number.isFinite);
  return {
    used: used.length ? {
      initial: used[0], idle: idleSample?.jsHeap?.usedJSHeapSize ?? null,
      peak: Math.max(...used), final: used.at(-1), units: 'bytes'
    } : 'N/A',
    total: total.length ? {
      initial: total[0], idle: idleSample?.jsHeap?.totalJSHeapSize ?? null,
      peak: Math.max(...total), final: total.at(-1), units: 'bytes'
    } : 'N/A'
  };
}

function cacheRange(samples) {
  const values = samples.map(item => item.cacheSize).filter(Number.isFinite);
  return values.length ? {initial: values[0], peak: Math.max(...values), final: values.at(-1), units: 'entries'} : 'N/A';
}

function writeProgress(record) {
  mkdirSync(dirname(PROGRESS), {recursive: true});
  appendFileSync(PROGRESS, JSON.stringify(record) + '\n');
}

async function main() {
  const report = {
    checkpoint: 'JAVA_PHASE7_CHECKPOINT_2',
    area: 'A13 Memory Stress',
    runtimeId: JAVA_RUNTIME_ID,
    generatedAt: nowIso(),
    baseUrl: BASE_URL || null,
    browser: null,
    counts: {differentSources: DIFFERENT_COUNT, sameSourceDifferentStdin: SAME_COUNT},
    constraints: {stdoutCapBytes: 1024 * 1024, cacheTargetEntries: 8},
    samples: [],
    differentSources: {completed: 0, passed: 0, failed: 0, cacheHits: 0, first: null, last: null},
    sameSource: {completed: 0, passed: 0, failed: 0, cacheHits: 0, first: null, last: null},
    outputCap: null,
    memory: null,
    status: 'BLOCKED',
    blockingFailures: [],
    caveats: [
      'WASM linear memory is reported only from explicit diagnostics/HEAPU8.buffer hooks; JS heap and browser RSS are separate metrics.',
      'Renderer/Worker RSS is N/A unless a reliable per-browser process metric is available; Browser Process RSS is never labeled JVM Heap or WASM Heap.',
      'The stress loops execute through __IDE_RUNNER__.runJava on a real Problem Page after UI login/navigation; source text is not persisted in the report.',
      'Raw runtime asset bytes are the manifest-listed files on disk; transfer/compression bytes are N/A because the request harness does not expose encoded transfer size.',
      'Leak evidence uses the post-LRU-warmup latter-half sample window: reject only material growth of at least max(8 MiB, 5% of baseline) when at least 75% of sample-to-sample steps are positive. JS heap/RSS stability is observational only.'
    ]
  };
  let app = null;
  let chrome = null;
  let watchdog = null;
  let watchdogExpired = false;
  let abortReason = null;
  const runtimeAssets = runtimeAssetSummary();
  report.runtimeAssets = runtimeAssets;
  try {
    progress('harness', 'starting local server');
    app = BASE_URL ? {baseUrl: BASE_URL, async stop() {}} : await startLocalContestServer();
    progress('harness', `server ${app.baseUrl}`);
    chrome = await launchChrome();
    progress('harness', 'Chrome connected');
    report.browser = {version: await browserVersion(chrome.browser), headless: process.env.HEADLESS !== 'false', executable: 'Google Chrome'};
    const start = await loginAndOpenProblem(chrome.page, app.baseUrl);
    report.start = start;
    if (await chrome.page.locator('#ide-lang option[value="java"]').count() === 0) {
      report.blockingFailures.push({id: 'java-selector', reason: 'Problem Page has no Java 21 selector'});
    } else {
      progress('navigation', `waiting ${PRE_JAVA_SETTLE_MS}ms for default language prewarm`);
      await sleep(PRE_JAVA_SETTLE_MS);
      await chrome.page.locator('#ide-lang').selectOption('java');
      report.preJavaSettleMs = PRE_JAVA_SETTLE_MS;
      progress('navigation', 'real Problem Page ready; Java selected');
      watchdog = setTimeout(() => {
        watchdogExpired = true;
        abortReason ||= `stress watchdog exceeded ${WATCHDOG_MS}ms`;
        progress('watchdog', abortReason);
      }, WATCHDOG_MS);
      watchdog.unref?.();
      const initialSample = await sampleSafe(chrome.page, chrome.server, 'initial', 0, runtimeAssets);
      report.samples.push(initialSample); writeProgress(initialSample);
      await sleep(500);
      const idleSample = await sampleSafe(chrome.page, chrome.server, 'idle', 0, runtimeAssets);
      report.samples.push(idleSample); writeProgress(idleSample);

      for (let i = 0; i < DIFFERENT_COUNT; i++) {
        if (abortReason || watchdogExpired) break;
        const source = `public class Main { public static void main(String[] args) { System.out.print("D${i}"); } }`;
        let result;
        progress(`different:${i + 1}/${DIFFERENT_COUNT}`, 'begin');
        try { result = await withTimeout(evaluateJavaRun(chrome.page, source, '', RUN_TIMEOUT_MS), RUN_TIMEOUT_MS + 5000, `different source ${i + 1}`); }
        catch (error) {
          result = {harnessError: String(error?.stack || error), runStatus: 'HARNESS_TIMEOUT'};
          abortReason ||= result.harnessError;
        }
        const ok = result.runStatus === 'AC' || result.runStatus === 'PASS' || (result.status === 'ac' && result.stdout === `D${i}`);
        report.differentSources.completed++;
        if (ok && result.stdout === `D${i}`) report.differentSources.passed++; else report.differentSources.failed++;
        if (result.cacheHit === true) report.differentSources.cacheHits++;
        if (result.runStatus === 'UNAVAILABLE' || result.reason === 'RUNTIME_LOAD_FAILED') abortReason ||= 'Java runtime unavailable';
        if (!report.differentSources.first) report.differentSources.first = {result: {...result, stdout: undefined}};
        report.differentSources.last = {iteration: i, result: {...result, stdout: undefined}};
        if (i % SAMPLE_EVERY === 0 || i === DIFFERENT_COUNT - 1) {
          const point = await sampleSafe(chrome.page, chrome.server, 'different-sources', i + 1, runtimeAssets);
          report.samples.push(point); writeProgress({...point, result: {runStatus: result.runStatus, cacheHit: result.cacheHit}});
        }
        progress(`different:${i + 1}/${DIFFERENT_COUNT}`, result.runStatus || 'done');
      }
      const afterDifferent = await sampleSafe(chrome.page, chrome.server, 'after-different-sources', report.differentSources.completed, runtimeAssets);
      report.samples.push(afterDifferent); writeProgress(afterDifferent);

      for (let i = 0; i < SAME_COUNT; i++) {
        if (abortReason || watchdogExpired) break;
        const stdin = String(i);
        let result;
        progress(`same:${i + 1}/${SAME_COUNT}`, 'begin');
        try { result = await withTimeout(evaluateJavaRun(chrome.page, SAME_SOURCE, stdin, RUN_TIMEOUT_MS), RUN_TIMEOUT_MS + 5000, `same source ${i + 1}`); }
        catch (error) {
          result = {harnessError: String(error?.stack || error), runStatus: 'HARNESS_TIMEOUT'};
          abortReason ||= result.harnessError;
        }
        const ok = (result.runStatus === 'AC' || result.runStatus === 'PASS' || result.status === 'ac') && result.stdout === stdin;
        report.sameSource.completed++;
        if (ok) report.sameSource.passed++; else report.sameSource.failed++;
        if (result.cacheHit === true) report.sameSource.cacheHits++;
        if (result.runStatus === 'UNAVAILABLE' || result.reason === 'RUNTIME_LOAD_FAILED') abortReason ||= 'Java runtime unavailable';
        if (!report.sameSource.first) report.sameSource.first = {result: {...result, stdout: undefined}};
        report.sameSource.last = {iteration: i, result: {...result, stdout: undefined}};
        if (i % SAMPLE_EVERY === 0 || i === SAME_COUNT - 1) {
          const point = await sampleSafe(chrome.page, chrome.server, 'same-source-different-stdin', i + 1, runtimeAssets);
          report.samples.push(point); writeProgress({...point, result: {runStatus: result.runStatus, cacheHit: result.cacheHit}});
        }
        progress(`same:${i + 1}/${SAME_COUNT}`, result.runStatus || 'done');
      }
      const finalSample = await sampleSafe(chrome.page, chrome.server, 'final', report.sameSource.completed, runtimeAssets);
      report.samples.push(finalSample); writeProgress(finalSample);
      let cap;
      if (abortReason || watchdogExpired) cap = {runStatus: 'UNAVAILABLE', reason: abortReason || 'stress watchdog expired'};
      else {
        try { cap = await withTimeout(evaluateJavaRun(chrome.page, CAP_SOURCE, '', RUN_TIMEOUT_MS), RUN_TIMEOUT_MS + 5000, '1 MiB output cap'); }
        catch (error) { cap = {runStatus: 'HARNESS_TIMEOUT', harnessError: String(error?.stack || error)}; abortReason ||= cap.harnessError; }
      }
      const outputBytes = Buffer.byteLength(cap.stdout || '', 'utf8');
      report.outputCap = {
        status: cap.runStatus === 'UNAVAILABLE' || cap.reason === 'RUNTIME_LOAD_FAILED'
          ? 'BLOCKED' : (cap.outputTruncated === true && outputBytes <= 1024 * 1024 ? 'PASS' : 'FAIL'),
        outputBytes, capBytes: 1024 * 1024,
        outputTruncated: cap.outputTruncated === true,
        runStatus: cap.runStatus,
        stderrBytes: Buffer.byteLength(cap.stderr || '', 'utf8')
      };
      const after100Sample = report.samples.find(item => item.phase === 'different-sources' && item.iteration >= 100);
      report.memory = {
        wasmLinearMemory: metricRange(report.samples, 'wasmLinearMemoryBytes', idleSample, after100Sample),
        configuredMaximum: metricRange(report.samples, 'configuredMaximumBytes', idleSample, after100Sample),
        javaHeap: metricRange(report.samples, 'javaHeapBytes', idleSample, after100Sample),
        jsHeap: jsHeapRange(report.samples, idleSample),
        browserProcessRss: metricRange(
          report.samples.map(item => ({browserProcessRssBytes: item.browserProcessRss?.bytes})),
          'browserProcessRssBytes',
          {browserProcessRssBytes: idleSample.browserProcessRss?.bytes},
          {browserProcessRssBytes: after100Sample?.browserProcessRss?.bytes}
        ),
        rendererWorkerRss: 'N/A',
        workerRss: 'N/A',
        runtimeAssetBytes: metricRange(report.samples, 'runtimeAssetBytes'),
        runtimeAssetTransferBytes: 'N/A',
        cache: cacheRange(report.samples)
      };
      report.memory.stability = {
        wasmLinearMemory: stableWindowAssessment(report.samples, 'wasmLinearMemoryBytes'),
        jsHeap: stableWindowAssessment(report.samples, 'jsHeap.usedJSHeapSize'),
        browserProcessRss: stableWindowAssessment(report.samples.map(item => ({
          phase: item.phase, iteration: item.iteration, browserProcessRssBytes: item.browserProcessRss?.bytes
        })), 'browserProcessRssBytes')
      };
      const cacheStable = report.memory.cache !== 'N/A' && report.memory.cache.peak <= 8;
      const noLinearLeakEvidence = report.memory.stability.wasmLinearMemory.status === 'PASS';
      const jsMeasured = report.memory.jsHeap !== 'N/A' && report.memory.jsHeap.used !== 'N/A';
      const cdpHeap = report.samples.map(item => item.cdp).filter(item => item && Number.isFinite(item.usedJSHeapSize));
      report.memory.cdpHeap = cdpHeap.length
        ? {used: {initial: cdpHeap[0].usedJSHeapSize, peak: Math.max(...cdpHeap.map(item => item.usedJSHeapSize)), final: cdpHeap.at(-1).usedJSHeapSize, units: 'bytes'}}
        : 'N/A';
      const cdpMeasured = report.memory.cdpHeap !== 'N/A';
      const loopsPass = report.differentSources.completed === DIFFERENT_COUNT
        && report.differentSources.failed === 0
        && report.sameSource.completed === SAME_COUNT
        && report.sameSource.failed === 0;
      const runtimeUnavailable = report.differentSources.first?.result?.runStatus === 'UNAVAILABLE'
        || report.sameSource.first?.result?.runStatus === 'UNAVAILABLE'
        || report.outputCap.status === 'BLOCKED'
        || /Java runtime unavailable|HARNESS_TIMEOUT|timed out/i.test(String(abortReason || ''));
      report.status = runtimeUnavailable ? 'BLOCKED'
        : (loopsPass && cacheStable && noLinearLeakEvidence && jsMeasured && cdpMeasured && report.outputCap.status === 'PASS' ? 'PASS' : 'FAIL');
      if (runtimeUnavailable) report.blockingFailures.push({id: 'java-runtime', reason: 'Java runtime unavailable; stress counts are harness attempts, not compatibility passes'});
      else if (!loopsPass) report.blockingFailures.push({id: 'stress-loops', reason: 'One or more Java stress runs failed'});
      if (abortReason) report.blockingFailures.push({id: 'stress-abort', reason: abortReason});
      if (!cacheStable) report.blockingFailures.push({id: 'cache-bound', reason: 'Compile cache exceeded configured LRU target'});
      if (!noLinearLeakEvidence) report.blockingFailures.push({id: 'wasm-linear-memory-metric', reason: 'WASM linear memory diagnostic unavailable or exceeded peak'});
      if (!jsMeasured) report.blockingFailures.push({id: 'js-heap-metric', reason: 'JS heap metric unavailable'});
      if (!cdpMeasured) report.blockingFailures.push({id: 'cdp-js-heap-metric', reason: 'CDP JS heap metric unavailable'});
      if (report.outputCap.status === 'FAIL') report.blockingFailures.push({id: 'stdout-cap', reason: 'Output was not capped at 1 MiB'});
    }
  } catch (error) {
    report.status = 'BLOCKED';
    report.blockingFailures.push({id: 'memory-harness', reason: String(error?.stack || error)});
  } finally {
    if (watchdog) clearTimeout(watchdog);
    report.generatedAtFinished = nowIso();
    mkdirSync(dirname(REPORT), {recursive: true});
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    try { await chrome?.context?.close(); } catch (_) {}
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await app?.stop(); } catch (_) {}
  }
  console.log(JSON.stringify({report: REPORT, status: report.status, different: report.differentSources.completed, same: report.sameSource.completed, blockingFailures: report.blockingFailures.length}));
  if (report.status !== 'PASS') process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
