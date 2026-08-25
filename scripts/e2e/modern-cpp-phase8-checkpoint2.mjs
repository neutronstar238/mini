import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  attachRequestLog,
  launchChrome,
  loginAndOpenProblem,
  nowIso,
  startLocalContestServer
} from '../../compat-tests/java21/e2e/harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RESULT_DIR = join(ROOT, 'compat-tests', 'modern-cpp', 'results');
const E2E_PATH = join(RESULT_DIR, 'modern-cpp-e2e.json');
const NETWORK_PATH = join(RESULT_DIR, 'modern-cpp-network.json');
const NETWORK_ALIAS_PATH = join(RESULT_DIR, 'modern-cpp-network-isolation.json');
const PERFORMANCE_PATH = join(RESULT_DIR, 'modern-cpp-performance.json');
const RUN_TIMEOUT_MS = Number(process.env.MODERN_CPP_RUN_TIMEOUT_MS || 110000);

const SOURCES = {
  c17: {
    normal: '#include <stdio.h>\nint main(void){long long a,b;if(scanf("%lld%lld",&a,&b)!=2)return 1;printf("%lld\\n",a+b);}',
    ce: 'int main(void) { this is not C; }',
    re: 'int main(void){__builtin_trap();}',
    timeout: 'int main(void){volatile int x=0;for(;;)x++;}',
    truncation: '#include <stdio.h>\nint main(void){for(int i=0;i<1100000;i++)putchar(65);return 0;}',
    stderrTruncation: '#include <stdio.h>\nint main(void){for(int i=0;i<1100000;i++)fputc(69,stderr);return 0;}'
  },
  cpp17: {
    normal: '#include <bits/stdc++.h>\nusing namespace std;int main(){long long a,b;if(!(cin>>a>>b))return 1;cout<<a+b<<"\\n";}',
    ce: 'int main() { this is not C++; }',
    re: 'int main(){__builtin_trap();}',
    timeout: 'int main(){volatile int x=0;for(;;)x++;}',
    truncation: '#include <cstdio>\nint main(){for(int i=0;i<1100000;i++)putchar(66);}',
    stderrTruncation: '#include <cstdio>\nint main(){for(int i=0;i<1100000;i++)fputc(70,stderr);}'
  }
};

function normalize(value) { return String(value ?? '').replace(/\r\n/g, '\n').trim(); }
function writeJson(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
function timedOutResult() {
  return {compileStatus: 'HARNESS_TIMEOUT', runStatus: 'HARNESS_TIMEOUT', timedOut: true,
    stdout: '', stderr: `harness exceeded ${RUN_TIMEOUT_MS} ms`};
}

async function runModern(page, language, source, stdin = '') {
  return page.evaluate(async ({language, source, stdin, timeoutMs}) => {
    const profileId = language === 'c17' ? 'c17-gcc14-compat-v2' : 'cpp17-gcc14-compat-v2';
    const run = globalThis.__IDE_RUNNER__.runCode({language, profileId, source, stdin, optLevel: '-O2'});
    return Promise.race([run, new Promise(resolve => setTimeout(() => resolve({
      compileStatus: 'HARNESS_TIMEOUT', runStatus: 'HARNESS_TIMEOUT', timedOut: true,
      stdout: '', stderr: `harness exceeded ${timeoutMs} ms`
    }), timeoutMs))]);
  }, {language, source, stdin, timeoutMs: RUN_TIMEOUT_MS});
}

async function runFrozen(page, language, source, stdin = '') {
  return page.evaluate(async ({language, source, stdin, timeoutMs}) => Promise.race([
    globalThis.__IDE_RUNNER__.runCode({language, source, code: source, stdin}),
    new Promise(resolve => setTimeout(() => resolve({
      compileStatus: 'HARNESS_TIMEOUT', runStatus: 'HARNESS_TIMEOUT', stdout: '', stderr: '', timedOut: true
    }), timeoutMs))
  ]), {language, source, stdin, timeoutMs: RUN_TIMEOUT_MS});
}

function summarizeRun(result, expected) {
  const stdout = result?.stdout || '';
  const stderr = result?.stderr || '';
  const outputEvidence = value => ({
    bytes: Buffer.byteLength(value),
    sha256: createHash('sha256').update(value).digest('hex'),
    text: value.length > 4096 ? value.slice(0, 4096) : value,
    evidenceTruncated: value.length > 4096
  });
  return {
    runtimeId: result?.runtimeId || null,
    profileId: result?.profileId || null,
    compileStatus: result?.compileStatus || null,
    runStatus: result?.runStatus || null,
    exitCode: result?.exitCode ?? null,
    stdout: outputEvidence(stdout),
    stderr: outputEvidence(stderr),
    expected: expected ?? null,
    outputMatches: expected == null ? null : normalize(stdout) === normalize(expected),
    cacheHit: !!result?.cacheHit,
    timedOut: !!result?.timedOut,
    aborted: !!result?.aborted,
    outputTruncated: !!result?.outputTruncated,
    outputTruncatedFields: result?.outputTruncatedFields || [],
    limitField: result?.limitField || null,
    limitBytes: result?.limitBytes ?? null,
    actualBytes: result?.actualBytes ?? null,
    artifactBytes: result?.artifactBytes ?? null,
    stage: result?.stage || null,
    headerGuard: result?.headerGuard || null,
    compilerWorkerPreserved: result?.compilerWorkerPreserved ?? null,
    timing: result?.timing || null
  };
}

function requestPolicy(baseUrl, entries) {
  const base = new URL(baseUrl);
  const runtimePattern = /\/runtime\/|\/js\/contest\/ide-.*worker|\/js\/runno\/|\/js\/pyodide\//;
  const runtimeRequests = entries.filter(entry => runtimePattern.test(entry.url));
  const inProcessBlobRequests = entries.filter(entry => entry.url.startsWith('blob:'));
  const unrelatedBackgroundRequests = entries.filter(entry => /\/api\/contest\/devices\/heartbeat(?:$|\?)/.test(entry.url));
  const localRunNetworkRequests = entries.filter(entry => !entry.url.startsWith('blob:')
    && !/\/api\/contest\/devices\/heartbeat(?:$|\?)/.test(entry.url));
  const violations = localRunNetworkRequests.filter(entry => {
    const url = new URL(entry.url);
    return url.origin !== base.origin || entry.method !== 'GET'
      || !runtimePattern.test(url.pathname);
  });
  const sourceLike = entries.filter(entry => entry.hasSourceLikeBody);
  const submissions = entries.filter(entry => /\/submissions(?:$|\?)/.test(entry.url));
  return {
    totalRequests: entries.length,
    localRunNetworkRequestCount: localRunNetworkRequests.length,
    runtimeRequests: runtimeRequests.length,
    allowedPolicy: 'same-origin GET runtime assets only',
    inProcessBlobRequests,
    unrelatedBackgroundRequests,
    runtimeRequestViolations: violations,
    sourceLikeRequests: sourceLike,
    submissionRequests: submissions,
    pass: violations.length === 0 && sourceLike.length === 0 && submissions.length === 0
  };
}

async function collectUi(page) {
  await page.selectOption('#ide-lang', 'c17');
  await page.dispatchEvent('#ide-lang', 'change');
  await page.waitForTimeout(250);
  const c17Option = await page.locator('#ide-lang option[value="c17"]').innerText();
  const cpp17Option = await page.locator('#ide-lang option[value="cpp17"]').innerText();
  const c17Tooltip = await page.locator('#ide-lang-tooltip').innerText();
  const previewNote = await page.locator('#submit-preview-note').innerText();
  await page.locator('#ide-runtime-detail').evaluate(button => button.click());
  await page.waitForFunction(() => document.getElementById('runtime-drawer')?.classList.contains('active'));
  const c17Drawer = await page.locator('#runtime-drawer-body').innerText();
  const submit = await page.locator('#submit-btn').evaluate(button => ({disabled: button.disabled, title: button.title}));
  await page.locator('#runtime-drawer-close').evaluate(button => button.click());
  await page.waitForFunction(() => !document.getElementById('runtime-drawer')?.classList.contains('active'));
  await page.selectOption('#ide-lang', 'cpp17');
  await page.dispatchEvent('#ide-lang', 'change');
  await page.waitForTimeout(250);
  const cpp17Tooltip = await page.locator('#ide-lang-tooltip').innerText();
  await page.locator('#ide-runtime-detail').evaluate(button => button.click());
  await page.waitForFunction(() => document.getElementById('runtime-drawer')?.classList.contains('active'));
  const cpp17Drawer = await page.locator('#runtime-drawer-body').innerText();
  await page.locator('#runtime-drawer-close').evaluate(button => button.click());
  await page.waitForFunction(() => !document.getElementById('runtime-drawer')?.classList.contains('active'));
  return {
    c17Option, cpp17Option, c17Tooltip, cpp17Tooltip, previewNote, c17Drawer, cpp17Drawer, submit,
    localPreviewNames: /C17.*Local Preview/.test(c17Option) && /C\+\+17.*Local Preview/.test(cpp17Option),
    disclaimerVisible: /最终结果以服务器 Judge 为准/.test(c17Tooltip)
      && /最终结果以服务器 Judge 为准/.test(cpp17Tooltip),
    previewDisclaimerExact: previewNote.includes('当前为浏览器本地预览环境，正式兼容性验证尚未冻结，本地结果仅供调试参考。'),
    drawerHasV2: /c17-gcc14-compat-v2/.test(c17Drawer) && /cpp17-gcc14-compat-v2/.test(cpp17Drawer),
    compilerDetails: /Clang 19\.1\.7/.test(c17Drawer) && /gcc-14/.test(c17Drawer)
      && /Clang 19\.1\.7/.test(cpp17Drawer) && /g\+\+-14/.test(cpp17Drawer)
      && /-O2/.test(c17Drawer) && /-O2/.test(cpp17Drawer)
      && /proven-mismatch-v1/.test(cpp17Drawer),
    formalSubmitDisabled: submit.disabled && /Formal Submit/.test(submit.title)
  };
}

async function collectResourcePerformance(page) {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => /cpp-modern-engine-v[12]|ide-wasi-(?:worker|execution-worker)-modern/.test(entry.name))
    .map(entry => ({
      url: entry.name,
      durationMs: Math.round(entry.duration * 10) / 10,
      transferBytes: entry.transferSize,
      encodedBytes: entry.encodedBodySize,
      decodedBytes: entry.decodedBodySize,
      initiatorType: entry.initiatorType
    })));
}

async function main() {
  const app = process.env.BASE_URL ? {baseUrl: process.env.BASE_URL, async stop() {}} : await startLocalContestServer();
  let chrome;
  try {
    chrome = await launchChrome();
    const {page} = chrome;
    const requests = attachRequestLog(page);
    const problem = await loginAndOpenProblem(page, app.baseUrl);
    await page.waitForFunction(() => globalThis.__IDE_RUNNER__?.runModern && globalThis.__IDE_RUNNER__?.modernStats,
      null, {timeout: 30000});
    const ui = await collectUi(page);
    const progress = await page.evaluate(() => {
      globalThis.__PHASE8_PROGRESS__ = [];
      globalThis.__PHASE8_PROGRESS_UI__ = [];
      globalThis.__IDE_RUNNER__.onRuntimeProgress(items => globalThis.__PHASE8_PROGRESS__.push(...items));
      const box = document.getElementById('runtime-progress');
      const capture = () => globalThis.__PHASE8_PROGRESS_UI__.push({
        active: box?.classList.contains('active') === true,
        stage: document.getElementById('rp-stage')?.textContent || '',
        percent: document.getElementById('rp-pct')?.textContent || ''
      });
      new MutationObserver(capture).observe(box, {attributes: true, childList: true, subtree: true, characterData: true});
      capture();
      return true;
    });
    const localRunRequestStart = requests.mark();
    const modern = {};
    for (const language of ['c17', 'cpp17']) {
      const source = SOURCES[language];
      const first = await runModern(page, language, source.normal, '20 22\n');
      const second = await runModern(page, language, source.normal, '7 8\n');
      const ce = await runModern(page, language, source.ce);
      const re = await runModern(page, language, source.re);
      const timeout = await runModern(page, language, source.timeout);
      const statsAfterTimeout = await page.evaluate(() => globalThis.__IDE_RUNNER__.modernStats());
      const alive = await runModern(page, language, source.normal, '1 2\n');
      const truncation = await runModern(page, language, source.truncation);
      const stderrTruncation = await runModern(page, language, source.stderrTruncation);
      const headerGuard = language === 'cpp17'
        ? await runModern(page, language, '#include <iostream>\nint main(){std::vector<int> v;std::cout<<v.size();}')
        : null;
      modern[language] = {
        local: summarizeRun(first, '42'),
        sample: summarizeRun(second, '15'),
        cache: summarizeRun(second, '15'),
        ce: summarizeRun(ce), re: summarizeRun(re),
        timeout: summarizeRun(timeout), statsAfterTimeout,
        aliveAfterTimeout: summarizeRun(alive, '3'),
        outputTruncation: summarizeRun(truncation),
        stderrTruncation: summarizeRun(stderrTruncation),
        headerGuard: headerGuard ? summarizeRun(headerGuard) : null,
        pass: first.compileStatus === 'PASS' && first.runStatus === 'PASS' && normalize(first.stdout) === '42'
          && second.cacheHit === true && ce.compileStatus === 'CE' && re.runStatus === 'RE'
          && timeout.runStatus === 'LOCAL_TIMEOUT' && timeout.timedOut === true
          && timeout.compilerWorkerPreserved === true && statsAfterTimeout.ready === true
          && alive.runStatus === 'PASS' && normalize(alive.stdout) === '3'
          && truncation.outputTruncatedFields?.includes('stdout')
          && stderrTruncation.outputTruncatedFields?.includes('stderr')
          && (language === 'c17' || (headerGuard.stage === 'gcc14-header'
            && headerGuard.compileStatus === 'CE' && headerGuard.headerGuard?.policy === 'proven-mismatch-v1'))
      };
    }

    const sourceLimit = await runModern(page, 'c17', SOURCES.c17.normal + ' '.repeat(1024 * 1024));
    const inputLimit = await runModern(page, 'c17', SOURCES.c17.normal, 'x'.repeat(4 * 1024 * 1024 + 1));
    const limits = {
      source: summarizeRun(sourceLimit), input: summarizeRun(inputLimit),
      pass: sourceLimit.compileStatus === 'CE' && sourceLimit.limitField === 'source'
        && sourceLimit.limitBytes === 1024 * 1024
        && inputLimit.runStatus === 'INPUT_LIMIT' && inputLimit.limitField === 'stdin'
        && inputLimit.limitBytes === 4 * 1024 * 1024
    };

    const frozenSpecs = {
      c: {normal: '#include <stdio.h>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);}', ce: 'int main( {', re: 'int main(){__builtin_trap();}'},
      cpp: {normal: '#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}', ce: 'int main( {', re: 'int main(){__builtin_trap();}'},
      python: {normal: 'a,b=map(int,input().split())\nprint(a+b)', ce: 'if True print(1)', re: 'raise RuntimeError("phase8")'},
      java: {normal: 'import java.util.*; public class Main { public static void main(String[] a){ Scanner s=new Scanner(System.in); System.out.println(s.nextInt()+s.nextInt()); }}', ce: 'public class Main { syntax error }', re: 'public class Main { public static void main(String[] a){ throw new RuntimeException("phase8"); }}'}
    };
    const frozen = {};
    for (const [language, source] of Object.entries(frozenSpecs)) {
      const first = await runFrozen(page, language, source.normal, '9 4\n').catch(() => timedOutResult());
      const cached = await runFrozen(page, language, source.normal, '3 5\n').catch(() => timedOutResult());
      const ce = await runFrozen(page, language, source.ce).catch(() => timedOutResult());
      const re = await runFrozen(page, language, source.re).catch(() => timedOutResult());
      frozen[language] = {
        local: summarizeRun(first, '13'), sample: summarizeRun(cached, '8'), cache: summarizeRun(cached, '8'),
        ce: summarizeRun(ce), re: summarizeRun(re),
        executionTimeRecorded: Number.isFinite(first.executionTime) || Number.isFinite(first.executionMs)
          || Number.isFinite(first.timing?.executionTime) || Number.isFinite(first.timing?.executionMs),
        pass: normalize(first.stdout) === '13' && normalize(cached.stdout) === '8'
          && (ce.compileFailed === true || ce.compileStatus === 'CE')
          && (re.exitCode !== 0 || re.runStatus === 'RE')
      };
    }

    const progressEvents = await page.evaluate(() => globalThis.__PHASE8_PROGRESS__ || []);
    const progressUi = await page.evaluate(() => globalThis.__PHASE8_PROGRESS_UI__ || []);
    const localRunRequests = requests.since(localRunRequestStart);
    const network = {
      schemaVersion: 1, generatedAt: nowIso(), baseUrl: app.baseUrl, problemUrl: problem.problemUrl,
      policy: requestPolicy(app.baseUrl, localRunRequests),
      bootstrapRequestCount: localRunRequestStart,
      requests: localRunRequests
    };
    const coldResources = (await collectResourcePerformance(page)).map(item => ({...item, phase: 'product-session'}));
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => globalThis.__IDE_RUNNER__?.runModern && globalThis.__IDE_RUNNER__?.modernStats,
      null, {timeout: 30000});
    const cachedColdRaw = await runModern(page, 'cpp17', SOURCES.cpp17.normal, '4 6\n');
    const cachedCold = summarizeRun(cachedColdRaw, '10');
    const cachedColdResources = (await collectResourcePerformance(page)).map(item => ({...item, phase: 'cached-cold-page'}));
    const resources = coldResources.concat(cachedColdResources);
    const finalCompilerStats = await page.evaluate(() => globalThis.__IDE_RUNNER__.modernStats());
    const pageMemory = await page.evaluate(() => {
      const memory = performance.memory;
      return memory ? {
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
        totalJSHeapSize: memory.totalJSHeapSize,
        usedJSHeapSize: memory.usedJSHeapSize,
        scope: 'whole Chrome page; not attributed solely to Modern Runtime'
      } : null;
    });
    const responseHeaders = [];
    const headerProbeUrls = [...new Set(resources.map(item => item.url).concat([
      new URL('/runtime/cpp-modern-engine-v1/THIRD_PARTY_NOTICES.md', app.baseUrl).href
    ]))];
    for (const url of headerProbeUrls) {
      const response = await fetch(url, {method: 'HEAD'});
      responseHeaders.push({
        url,
        contentLength: Number(response.headers.get('content-length')) || null,
        contentEncoding: response.headers.get('content-encoding') || 'identity',
        contentType: response.headers.get('content-type') || null
      });
    }
    const performanceReport = {
      schemaVersion: 1, generatedAt: nowIso(), cacheModeNotes: {
        product: 'normal Cache Storage and force-cache flow',
        evidenceHarness: 'manifest evidence may use no-store; this run did not force no-store for product Local Run'
      },
      resources, responseHeaders, finalCompilerStats, pageMemory, cachedCold,
      totals: resources.reduce((out, item) => ({
        transferBytes: out.transferBytes + (item.transferBytes || 0),
        encodedBytes: out.encodedBytes + (item.encodedBytes || 0),
        decodedBytes: out.decodedBytes + (item.decodedBytes || 0)
      }), {transferBytes: 0, encodedBytes: 0, decodedBytes: 0}),
      runs: Object.fromEntries(Object.entries(modern).map(([language, value]) => [language, {
        cold: value.local.timing, warm: value.cache.timing, artifactBytes: value.local.artifactBytes,
        cacheHit: value.cache.cacheHit
      }])),
      largeAssetReuse: ['clang.wasm', 'wasm-ld.wasm', 'sysroot.tar'].map(file => {
        const matches = resources.filter(item => item.url.endsWith('/' + file));
        return {
          file,
          requestCount: matches.length,
          networkTransferCount: matches.filter(item => (item.transferBytes || 0) > 1024).length,
          transferBytes: matches.reduce((sum, item) => sum + (item.transferBytes || 0), 0),
          pass: matches.filter(item => (item.transferBytes || 0) > 1024).length <= 1
        };
      })
    };
    const e2e = {
      schemaVersion: 1, generatedAt: nowIso(), chrome: true, problem,
      runtimeId: 'cpp-modern-engine-v2', profiles: ['c17-gcc14-compat-v2', 'cpp17-gcc14-compat-v2'],
      optimizationPolicy: '-O2', progressSubscribed: progress, progressEvents, progressUi,
      ui, modern, limits, cachedCold, frozenRegression: frozen,
      gate: {
        modernPass: Object.values(modern).every(value => value.pass),
        limitsPass: limits.pass,
        networkPass: network.policy.pass,
        progressPass: progressEvents.some(item => item.stage === 'READY' || item.state === 'READY')
          && progressUi.some(item => item.active && item.stage.length > 0),
        cachedColdPass: cachedCold.outputMatches === true && cachedCold.runStatus === 'PASS',
        largeAssetReusePass: performanceReport.largeAssetReuse.every(item => item.pass),
        uiPass: ui.localPreviewNames && ui.disclaimerVisible && ui.previewDisclaimerExact
          && ui.drawerHasV2 && ui.compilerDetails && ui.formalSubmitDisabled,
        frozenPass: Object.values(frozen).every(value => value.pass)
      }
    };
    e2e.gate.status = Object.values(e2e.gate).every(value => value === true) ? 'PASS' : 'BLOCKED';
    writeJson(E2E_PATH, e2e);
    writeJson(NETWORK_PATH, network);
    writeJson(NETWORK_ALIAS_PATH, network);
    writeJson(PERFORMANCE_PATH, performanceReport);
    console.log(`modern-cpp-checkpoint2: ${e2e.gate.status}`);
    console.log(JSON.stringify(e2e.gate, null, 2));
    if (e2e.gate.status !== 'PASS') process.exitCode = 1;
  } finally {
    try { await chrome?.context?.close(); } catch {}
    try { await chrome?.browser?.close(); } catch {}
    try { await chrome?.server?.close(); } catch {}
    await app.stop();
  }
}

await main();
