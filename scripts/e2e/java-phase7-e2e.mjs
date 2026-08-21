import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
  attachRequestLog,
  browserVersion,
  byteLength,
  collectMemoryMetrics,
  cdpMetrics,
  evaluateJavaRun,
  launchChrome,
  loginAndOpenProblem,
  nowIso,
  startLocalContestServer,
  sleep,
  waitForText
} from '../../compat-tests/java21/e2e/harness.mjs';

const REPORT = process.env.JAVA21_E2E_REPORT
  || join(process.cwd(), 'compat-tests', 'java21', 'e2e', 'java21-e2e-results.json');
const BASE_URL = process.env.BASE_URL || '';
const RUN_FROZEN = process.env.RUN_FROZEN_REGRESSIONS !== '0';
const JAVA_RUNTIME_ID = 'java21-browserjdk-compat-v2';
const CASE_TIMEOUT_MS = Number(process.env.JAVA21_E2E_CASE_TIMEOUT_MS || 90000);
const OP_TIMEOUT_MS = Number(process.env.JAVA21_E2E_OP_TIMEOUT_MS || 210000);
const PRE_JAVA_SETTLE_MS = Number(process.env.JAVA21_PRE_JAVA_SETTLE_MS || 0);

const JAVA_SOURCE = `import java.util.*;
public class Main {
  public static void main(String[] args) {
    Scanner sc = new Scanner(System.in);
    int a = sc.nextInt();
    int b = sc.nextInt();
    System.out.println(a + b);
  }
}`;
const JAVA_SAMPLE_SOURCE = `import java.io.*;
public class Main {
  public static void main(String[] args) throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
    String line; StringBuilder out = new StringBuilder();
    while ((line = br.readLine()) != null) {
      String[] p = line.trim().split("\\\\s+");
      if (p.length >= 2) out.append(Long.parseLong(p[0]) + Long.parseLong(p[1])).append('\\n');
    }
    System.out.print(out);
  }
}`;
const JAVA_CACHE_SOURCE = `import java.io.*;
public class Main {
  public static void main(String[] args) throws Exception {
    BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
    System.out.print(br.readLine());
  }
}`;
const JAVA_CACHE_SOURCE_MUTATED = JAVA_CACHE_SOURCE.replace('br.readLine()', 'br.readLine() + "!"');
const JAVA_TIMEOUT_SOURCE = 'public class Main { public static void main(String[] args) { while (true) {} } }';
const JAVA_ALIVE_SOURCE = 'public class Main { public static void main(String[] args) { System.out.print("ALIVE"); } }';
const JAVA_CE_SOURCE = 'public class Main { public static void main(String[] args) { int x = ; } }';
const JAVA_RE_SOURCE = 'public class Main { public static void main(String[] args) { int x = 1 / 0; System.out.print(x); } }';
const JAVA_OUTPUT_SOURCE = 'public class Main { public static void main(String[] args) { System.out.print("x".repeat(1048600)); } }';

function record(id, status, details = {}) { return {id, status, ...details}; }

function failure(id, error, details = {}) {
  return record(id, 'FAIL', {error: String(error?.stack || error), ...details});
}

function progress(id, details = '') {
  console.error(`[JAVA_PHASE7_A11] ${new Date().toISOString()} ${id}${details ? ` ${details}` : ''}`);
}

function attachPageDiagnostics(page) {
  const diagnostics = {console: [], pageErrors: [], requestFailures: [], runtimeResponses: []};
  const clip = value => String(value || '').slice(0, 2000);
  page.on('console', message => diagnostics.console.push({type: message.type(), text: clip(message.text())}));
  page.on('pageerror', error => diagnostics.pageErrors.push({message: clip(error?.message || error), stack: clip(error?.stack)}));
  page.on('requestfailed', request => diagnostics.requestFailures.push({url: request.url(), method: request.method(), failure: clip(request.failure()?.errorText)}));
  page.on('response', response => {
    if (response.url().includes(`/runtime/${JAVA_RUNTIME_ID}/`)) {
      const headers = response.headers();
      diagnostics.runtimeResponses.push({
        url: response.url(), status: response.status(), statusText: response.statusText(),
        contentType: headers['content-type'] || null,
        contentLength: headers['content-length'] || null,
        contentEncoding: headers['content-encoding'] || null,
        crossOriginResourcePolicy: headers['cross-origin-resource-policy'] || null,
        crossOriginOpenerPolicy: headers['cross-origin-opener-policy'] || null,
        accessControlAllowOrigin: headers['access-control-allow-origin'] || null,
        xContentTypeOptions: headers['x-content-type-options'] || null
      });
    }
  });
  return diagnostics;
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

async function pageState(page) {
  return page.evaluate(() => ({
    url: String(location.href),
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : null,
    javaOption: !!document.querySelector('#ide-lang option[value="java"]'),
    language: document.querySelector('#ide-lang')?.value || null,
    runtimeStatus: document.querySelector('#runtime-status')?.textContent || '',
    runtimeProgress: document.querySelector('#runtime-progress')?.textContent || '',
    output: document.querySelector('#ide-output')?.innerText || '',
    outputHead: document.querySelector('#ide-output-head')?.innerText || '',
    timing: document.querySelector('#ide-timing')?.innerText || '',
    sampleResult: document.querySelector('#ide-samples-result')?.innerText || ''
  }));
}

async function uiRun(page, source, stdin, options = {}) {
  await page.locator('#ide-code').fill(source);
  await page.locator('#ide-input').fill(stdin || '');
  const before = await pageState(page);
  const runtimeTrace = [];
  const traceTimer = setInterval(() => {
    pageState(page).then(state => runtimeTrace.push({at: Date.now(), runtimeStatus: state.runtimeStatus, progress: state.runtimeProgress})).catch(() => {});
  }, 100);
  try {
    await page.locator('#ide-run').click();
    await waitForText(page.locator('#ide-output'), text => text !== '…' && text.length > 0, options.timeoutMs || 180000, 100);
  } finally { clearInterval(traceTimer); }
  const after = await pageState(page);
  return {before, after, runtimeTrace};
}

async function uiSamples(page, source, options = {}) {
  await page.locator('#ide-code').fill(source);
  await page.locator('#ide-run-samples').click();
  const text = await waitForText(page.locator('#ide-samples-result'), value => /Passed|编译失败|自测失败|WA|RE|TLE/.test(value), options.timeoutMs || 180000, 100);
  return {text, state: await pageState(page)};
}

async function runnerCase(page, id, source, stdin, expected = {}, executionState = null) {
  if (executionState?.aborted) return record(id, 'BLOCKED', {reason: 'previous Java runner operation timed out'});
  progress(`case:${id}`, 'begin');
  try {
    const harnessTimeoutMs = expected.harnessTimeoutMs || CASE_TIMEOUT_MS;
    const result = await withTimeout(
      evaluateJavaRun(page, source, stdin, harnessTimeoutMs),
      Math.max(harnessTimeoutMs + 5000, CASE_TIMEOUT_MS),
      `Java case ${id}`
    );
    if (result.runStatus === 'UNAVAILABLE' || result.reason === 'RUNTIME_LOAD_FAILED') {
      progress(`case:${id}`, `blocked ${result.runStatus || result.reason}`);
      return record(id, 'BLOCKED', {result, expected, reason: 'Java runtime unavailable'});
    }
    const pass = Object.entries(expected).every(([key, value]) => {
      if (key === 'harnessTimeoutMs') return true;
      if (key === 'stdout') return result.stdout === value;
      return result[key] === value;
    });
    progress(`case:${id}`, pass ? 'pass' : 'fail');
    return record(id, pass ? 'PASS' : 'FAIL', {result, expected});
  } catch (error) {
    const timedOut = /timed out after/i.test(String(error?.message || error));
    if (timedOut && executionState) executionState.aborted = true;
    progress(`case:${id}`, `${timedOut ? 'blocked timeout' : 'error'} ${String(error?.message || error).slice(0, 160)}`);
    return timedOut
      ? record(id, 'BLOCKED', {reason: String(error?.message || error), expected})
      : failure(id, error);
  }
}

function classifyNetworkRequests(entries) {
  const submissions = entries.filter(entry => /\/api\/contest\/contests\/[^/]+\/submissions(?:$|\?)/.test(entry.url));
  const sourceLike = entries.filter(entry => entry.hasSourceLikeBody);
  const runtimeGets = entries.filter(entry => entry.method === 'GET' && entry.url.includes(`/runtime/${JAVA_RUNTIME_ID}/`));
  return {count: entries.length, submissions, sourceLike, runtimeGets};
}

async function frozenRegression(page, language, source, stdin, expectedOut) {
  const result = {language, cases: []};
  const requiredIds = [
    `${language}-a-plus-b`, `${language}-sample`, `${language}-ce`,
    `${language}-re`, `${language}-cache`, `${language}-execution-time`
  ];
  const runnerEval = (payload, label) => withTimeout(page.evaluate(async ({language: evalLanguage, source: evalSource, stdin: evalStdin}) => {
    const runner = globalThis.__IDE_RUNNER__;
    if (!runner?.runCode) throw new Error('runner unavailable');
    return runner.runCode({language: evalLanguage, source: evalSource, stdin: evalStdin});
  }, payload), CASE_TIMEOUT_MS, label);
  try {
    await page.locator('#ide-lang').selectOption(language);
    progress(`frozen:${language}`, 'A+B begin');
    const run = await runnerEval({language, source, stdin}, `${language} A+B`);
    result.cases.push(record(`${language}-a-plus-b`, run.runStatus === 'PASS' && run.stdout === expectedOut ? 'PASS' : 'FAIL', {result: run}));
    try {
      const sample = await withTimeout(uiSamples(page, source, {timeoutMs: CASE_TIMEOUT_MS}), CASE_TIMEOUT_MS + 5000, `${language} sample`);
      const sampleUnavailable = /不可用|初始化失败|BUILD_REQUIRED|加载失败|RUNTIME_LOAD_FAILED/i.test(sample.text);
      result.cases.push(record(`${language}-sample`, sampleUnavailable ? 'BLOCKED' : (/Passed/.test(sample.text) ? 'PASS' : 'FAIL'), {sampleText: sample.text}));
    } catch (error) { result.cases.push(record(`${language}-sample`, 'BLOCKED', {reason: String(error?.message || error)})); }
    const second = await runnerEval({language, source, stdin: '1 2'}, `${language} cache`);
    result.cases.push(record(`${language}-cache`, second.cacheHit || second.timing?.cacheHit ? 'PASS' : 'FAIL', {result: second}));
    const ceSource = language === 'python' ? 'print(' : (language === 'c' ? 'int main(void) { return ; }' : '#include <iostream>\nint main(){ std::cout << ; }');
    const ce = await runnerEval({language, source: ceSource, stdin: ''}, `${language} CE`);
    result.cases.push(record(`${language}-ce`, ce.compileStatus === 'CE' || ce.runStatus === 'CE' ? 'PASS' : 'FAIL', {result: ce}));
    const reSource = language === 'python' ? 'raise RuntimeError("boom")' : (language === 'c' ? '#include <stdio.h>\nint main(void){ int x=0; return 1/x; }' : '#include <iostream>\nint main(){ int x=0; std::cout << 1/x; }');
    const re = await runnerEval({language, source: reSource, stdin: ''}, `${language} RE`);
    result.cases.push(record(`${language}-re`, re.runStatus === 'RE' || re.exitCode !== 0 ? 'PASS' : 'FAIL', {result: re}));
    result.cases.push(record(`${language}-execution-time`, Number.isFinite(run.executionTime) ? 'PASS' : 'FAIL', {executionTime: run.executionTime}));
    progress(`frozen:${language}`, 'complete');
  } catch (error) {
    const reason = String(error?.message || error);
    for (const id of requiredIds) {
      if (!result.cases.some(item => item.id === id)) result.cases.push(record(id, 'BLOCKED', {reason}));
    }
    result.cases.push(record(`${language}-regression`, 'BLOCKED', {reason}));
  }
  return result;
}

async function main() {
  const report = {
    checkpoint: 'JAVA_PHASE7_CHECKPOINT_2',
    area: 'A11 Chrome E2E',
    runtimeId: JAVA_RUNTIME_ID,
    generatedAt: nowIso(),
    baseUrl: BASE_URL || null,
    browser: null,
    startFromProblemPage: false,
    cases: [],
    network: {localRun: null, formalSubmit: null},
    metrics: {idle: null, afterRun: null},
    blockingFailures: [],
    caveats: [
      'The online Chrome tab inspected separately did not expose a Java 21 selector; this report uses the repository local contest server when BASE_URL is not supplied.',
      'Local Run and Formal Submit request bodies are represented by field names and SHA-256 only; source/stdin text is never written to the report.'
    ]
  };
  let app = null;
  let chrome = null;
  let diagnostics = null;
  try {
    progress('harness', 'starting local server');
    app = BASE_URL ? {baseUrl: BASE_URL, async stop() {}} : await startLocalContestServer();
    progress('harness', `server ${app.baseUrl}`);
    chrome = await launchChrome();
    progress('harness', 'Chrome connected');
    report.browser = {version: await browserVersion(chrome.browser), headless: process.env.HEADLESS !== 'false', executable: 'Google Chrome'};
    if (process.env.JAVA21_CORP_OVERRIDE) {
      const override = process.env.JAVA21_CORP_OVERRIDE;
      await chrome.context.route(`**/runtime/${JAVA_RUNTIME_ID}/*`, async route => {
        const response = await route.fetch();
        const headers = {...response.headers(), 'cross-origin-resource-policy': override};
        await route.fulfill({response, headers});
      });
      report.corpOverride = override;
      report.caveats.push(`Test-only response header override: Cross-Origin-Resource-Policy=${override}`);
    }
    diagnostics = attachPageDiagnostics(chrome.page);
    report.diagnostics = diagnostics;
    const net = attachRequestLog(chrome.page);
    progress('navigation', 'login/problem begin');
    const start = await loginAndOpenProblem(chrome.page, app.baseUrl);
    progress('navigation', `problem ${start.title}`);
    report.startFromProblemPage = /\/problems\/[^/]+$/.test(chrome.page.url());
    report.start = { ...start, state: await pageState(chrome.page) };
    progress('navigation', `waiting ${PRE_JAVA_SETTLE_MS}ms for default language prewarm`);
    await sleep(PRE_JAVA_SETTLE_MS);
    report.preJavaSettleMs = PRE_JAVA_SETTLE_MS;
    report.cases.push(record('problem-page', report.startFromProblemPage ? 'PASS' : 'FAIL', {url: chrome.page.url(), title: report.start.title}));
    report.metrics.idle = {page: await collectMemoryMetrics(chrome.page), cdp: await cdpMetrics(chrome.page)};

    const initial = await pageState(chrome.page);
    const javaOption = chrome.page.locator('#ide-lang option[value="java"]');
    const hasJava = await javaOption.count() > 0;
    report.cases.push(record('java-21-selector', hasJava ? 'PASS' : 'BLOCKED', {initial, reason: hasJava ? null : 'Problem Page did not expose #ide-lang option[value=java]'}));
    if (!hasJava) {
      report.blockingFailures.push({id: 'java-21-selector', reason: 'Java 21 option missing from real Problem Page'});
    } else {
      await chrome.page.locator('#ide-lang').selectOption('java');
      const selected = await pageState(chrome.page);
      report.cases.push(record('runtime-not-loaded', /NOT_LOADED|idle|^$/.test(initial.runtimeStatus) ? 'PASS' : 'FAIL', {initial, afterLanguageSelection: selected}));
      const localStart = net.mark();
      progress('local-run', 'begin');
      const localRun = await withTimeout(uiRun(chrome.page, JAVA_SOURCE, '7 8'), OP_TIMEOUT_MS, 'Java local UI run');
      progress('local-run', 'complete');
      const localRequests = net.since(localStart);
      const localNetwork = classifyNetworkRequests(localRequests);
      const localPass = localRun.after.output.includes('15') && localNetwork.submissions.length === 0 && localNetwork.sourceLike.length === 0;
      const localUnavailable = /不可用|BUILD_REQUIRED|NOT_READY|加载失败|RUNTIME_LOAD_FAILED/i.test(
        `${localRun.after.runtimeStatus}\n${localRun.after.output}`
      );
      report.network.localRun = {requests: localRequests, classification: localNetwork, sourceUpload: false};
      report.cases.push(record('java-local-custom-stdin', localUnavailable ? 'BLOCKED' : (localPass ? 'PASS' : 'FAIL'), {run: localRun, network: localNetwork}));
      const actualReadyLabel = /Java 21 Runtime:\s*Ready\b/i.test(localRun.after.runtimeStatus);
      report.cases.push(record('runtime-ready', actualReadyLabel && !/失败|不可用|超时/i.test(localRun.after.runtimeStatus) ? 'PASS' : 'BLOCKED', {state: localRun.after, criterion: 'requires the Java 21 Runtime label itself to be Ready; Interrupt READY alone is insufficient'}));
      const progressText = localRun.runtimeTrace.map(item => `${item.runtimeStatus}\n${item.progress}`).join('\n');
      const progressStages = [...new Set(progressText.split(/\s+/).filter(Boolean))];
      const hasRealProgress = /Java 21 Runtime:\s*(Loading|Preparing|Ready)\b/i.test(progressText)
        && (actualReadyLabel || /DOWNLOAD|BOOT_JVM|INITIALIZE_COMPILER|下载|启动|初始化/i.test(progressText));
      report.cases.push(record('runtime-progress-stages', hasRealProgress && !/失败|不可用|超时/i.test(progressText) ? 'PASS' : 'BLOCKED', {stages: progressStages, traceSamples: localRun.runtimeTrace.length, criterion: 'requires Java lifecycle text/stages, not the Interrupt READY suffix'}));
      report.metrics.afterRun = {page: await collectMemoryMetrics(chrome.page), cdp: await cdpMetrics(chrome.page)};

      const executionState = {aborted: false};
      const blockedJava = id => record(id, 'BLOCKED', {reason: 'Java runtime unavailable; test was not executed', runtimeStatus: localRun.after.runtimeStatus});
      const cache = localUnavailable
        ? ['cache-source-stdin-1', 'cache-source-stdin-2', 'cache-source-stdin-3', 'cache-source-mutated-source'].map(blockedJava)
        : [
          await runnerCase(chrome.page, 'cache-source-stdin-1', JAVA_CACHE_SOURCE, 'one', {stdout: 'one'}, executionState),
          await runnerCase(chrome.page, 'cache-source-stdin-2', JAVA_CACHE_SOURCE, 'two', {stdout: 'two'}, executionState),
          await runnerCase(chrome.page, 'cache-source-stdin-3', JAVA_CACHE_SOURCE, 'three', {stdout: 'three'}, executionState),
          await runnerCase(chrome.page, 'cache-source-mutated-source', JAVA_CACHE_SOURCE_MUTATED, 'four', {stdout: 'four!'}, executionState)
        ];
      const cachePass = cache[0]?.result?.cacheHit === false && cache[1]?.result?.cacheHit === true && cache[2]?.result?.cacheHit === true && cache[3]?.result?.cacheHit === false;
      const cacheBlocked = cache.length > 0 && cache.every(item => item.status === 'BLOCKED');
      report.cases.push(record('compile-cache-same-source-different-stdin', cacheBlocked ? 'BLOCKED' : (cachePass ? 'PASS' : 'FAIL'), {runs: cache}));

      const samples = localUnavailable
        ? {text: localRun.after.output, state: localRun.after}
        : await withTimeout(uiSamples(chrome.page, JAVA_SAMPLE_SOURCE), OP_TIMEOUT_MS, 'Java sample run');
      const sampleBlocked = /不可用|初始化失败|BUILD_REQUIRED|加载失败/.test(samples.text);
      report.cases.push(record('java-sample-run', sampleBlocked ? 'BLOCKED' : (/Passed/.test(samples.text) ? 'PASS' : 'FAIL'), {samples}));
      report.cases.push(record('local-sample-passed-not-accepted', sampleBlocked ? 'BLOCKED' : (/正式结果以服务器评测为准|正式/.test(samples.text) ? 'PASS' : 'FAIL'), {sampleText: samples.text}));

      report.cases.push(localUnavailable ? blockedJava('java-ce') : await runnerCase(chrome.page, 'java-ce', JAVA_CE_SOURCE, '', {runStatus: 'CE'}, executionState));
      report.cases.push(localUnavailable ? blockedJava('java-re') : await runnerCase(chrome.page, 'java-re', JAVA_RE_SOURCE, '', {runStatus: 'RE'}, executionState));
      const timeout = localUnavailable
        ? blockedJava('java-local-timeout')
        : await runnerCase(chrome.page, 'java-local-timeout', JAVA_TIMEOUT_SOURCE, '', {runStatus: 'TLE', harnessTimeoutMs: 30000}, executionState);
      report.cases.push(timeout);
      const alive = localUnavailable
        ? blockedJava('java-timeout-recovery')
        : await runnerCase(chrome.page, 'java-timeout-recovery', JAVA_ALIVE_SOURCE, '', {stdout: 'ALIVE'}, executionState);
      report.cases.push(alive);

      const cap = localUnavailable
        ? blockedJava('java-output-cap-1mib')
        : await runnerCase(chrome.page, 'java-output-cap-1mib', JAVA_OUTPUT_SOURCE, '', {}, executionState);
      const capBytes = byteLength(cap.result?.stdout || '');
      cap.outputBytes = capBytes;
      cap.capBytes = 1024 * 1024;
      if (cap.status !== 'BLOCKED') cap.status = cap.result?.outputTruncated === true && capBytes <= 1024 * 1024 ? 'PASS' : 'FAIL';
      report.cases.push(cap);

      const formalStart = net.mark();
      let formalError = null;
      try {
        progress('formal-submit', 'begin');
        await chrome.page.locator('#ide-code').fill(JAVA_SOURCE);
        await chrome.page.locator('#submit-btn').click();
        await chrome.page.locator('#submit-result').waitFor({state: 'visible', timeout: 30000});
      } catch (error) { formalError = String(error?.message || error); }
      progress('formal-submit', formalError ? `ui-not-visible ${formalError.slice(0, 120)}` : 'ui-visible');
      const formalAfterRequests = net.since(formalStart);
      const formalNetwork = classifyNetworkRequests(formalAfterRequests);
      const formalUpload = formalNetwork.submissions.length > 0 && formalNetwork.sourceLike.length > 0;
      report.network.formalSubmit = {requests: formalAfterRequests, classification: formalNetwork, sourceUpload: formalUpload, error: formalError};
      report.cases.push(record('formal-submit-source-upload', formalUpload ? 'PASS' : (formalError ? 'BLOCKED' : 'FAIL'), {network: report.network.formalSubmit}));

      if (RUN_FROZEN) {
        progress('frozen-regression', 'begin');
        const frozen = [];
        frozen.push(await frozenRegression(chrome.page, 'cpp', '#include <iostream>\nint main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b; }', '7 8', '15'));
        frozen.push(await frozenRegression(chrome.page, 'c', '#include <stdio.h>\nint main(void){ long long a,b; scanf("%lld%lld", &a, &b); printf("%lld", a+b); }', '7 8', '15'));
        frozen.push(await frozenRegression(chrome.page, 'python', 'import sys\na,b=map(int,sys.stdin.read().split())\nprint(a+b)', '7 8', '15\n'));
        report.frozenRegression = frozen;
        progress('frozen-regression', 'complete');
      }

      const errorPage = await chrome.context.newPage();
      await errorPage.route(`**/runtime/${JAVA_RUNTIME_ID}/loader.mjs`, route => route.fulfill({status: 404, contentType: 'text/plain', body: 'simulated missing loader'}));
      await errorPage.goto(report.start.problemUrl, {waitUntil: 'domcontentloaded'});
      await errorPage.locator('#p-title').waitFor({state: 'visible', timeout: 15000});
      await errorPage.locator('#ide-lang').selectOption('java');
      const loadError = await withTimeout(uiRun(errorPage, JAVA_SOURCE, '1 2', {timeoutMs: 30000}), 45000, 'simulated runtime loading error');
      const errorState = await pageState(errorPage);
      const loadErrorPass = /失败|不可用|BUILD_REQUIRED|loader/i.test(errorState.runtimeStatus + errorState.output + errorState.timing);
      report.cases.push(record('runtime-loading-error', loadErrorPass ? 'PASS' : 'FAIL', {state: errorState, run: loadError}));
      await errorPage.close();
    }
  } catch (error) {
    report.blockingFailures.push({id: 'e2e-harness', reason: String(error?.stack || error)});
    report.cases.push(failure('e2e-harness', error));
  } finally {
    if (diagnostics) report.network.runtimeResponses = diagnostics.runtimeResponses;
    const existing = new Set(report.blockingFailures.map(item => item.id));
    report.cases.filter(item => (item.status === 'FAIL' || item.status === 'BLOCKED') && !existing.has(item.id))
      .forEach(item => report.blockingFailures.push({id: item.id, reason: item.error || item.reason || 'acceptance condition not met'}));
    mkdirSync(dirname(REPORT), {recursive: true});
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    try { await chrome?.context?.close(); } catch (_) {}
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await app?.stop(); } catch (_) {}
  }
  console.log(JSON.stringify({report: REPORT, blockingFailures: report.blockingFailures.length, cases: report.cases.length}));
  if (report.blockingFailures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
