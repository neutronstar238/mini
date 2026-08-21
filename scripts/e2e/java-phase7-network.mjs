import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {
  attachRequestLog,
  browserVersion,
  launchChrome,
  loginAndOpenProblem,
  nowIso,
  startLocalContestServer,
  waitForText
} from '../../compat-tests/java21/e2e/harness.mjs';

const REPORT = process.env.JAVA21_NETWORK_REPORT
  || join(process.cwd(), 'compat-tests', 'java21', 'network', 'java21-network-isolation.json');
const BASE_URL = process.env.BASE_URL || '';
const JAVA_RUNTIME_ID = 'java21-browserjdk-compat-v2';
const JAVA_SOURCE = `import java.util.*;
public class Main { public static void main(String[] args) {
  Scanner s = new Scanner(System.in); System.out.print(s.nextInt() + s.nextInt());
} }`;

function classify(entries) {
  const localRuntime = entries.filter(r => r.method === 'GET' && r.url.includes(`/runtime/${JAVA_RUNTIME_ID}/`));
  const staticAssets = entries.filter(r => r.method === 'GET' && /\.(?:js|mjs|wasm|data|css|json)(?:\?|$)/i.test(r.url));
  const sourceLike = entries.filter(r => r.hasSourceLikeBody);
  const submissions = entries.filter(r => /\/api\/contest\/contests\/[^/]+\/submissions(?:$|\?)/.test(r.url));
  const nonGet = entries.filter(r => r.method !== 'GET');
  const knownBackground = nonGet.filter(r => /\/api\/contest\/devices\/heartbeat(?:$|\?)/.test(r.url) && r.bodyFields.length === 0);
  const forbiddenNonGet = nonGet.filter(r => !knownBackground.includes(r));
  const allowedLocalPolicy = sourceLike.length === 0 && submissions.length === 0 && forbiddenNonGet.length === 0;
  return {
    total: entries.length,
    localRuntimeGets: localRuntime,
    staticAssetGets: staticAssets,
    sourceLike,
    submissions,
    nonGet,
    knownBackground,
    forbiddenNonGet,
    allowedLocalPolicy,
    // Kept as an explicit diagnostic for callers that require a strictly GET-only window.
    allowedLocalGetOnly: nonGet.length === 0 && allowedLocalPolicy
  };
}

async function main() {
  const report = {
    checkpoint: 'JAVA_PHASE7_CHECKPOINT_2',
    area: 'A12 Network Isolation',
    runtimeId: JAVA_RUNTIME_ID,
    generatedAt: nowIso(),
    baseUrl: BASE_URL || null,
    browser: null,
    startFromProblemPage: false,
    localRun: null,
    formalSubmit: null,
    blockingFailures: [],
    caveats: [
      'Only request metadata, body field names, byte lengths, and SHA-256 digests are retained; test source and stdin are not written.',
      'The local run window begins immediately before clicking Run and excludes page bootstrap/API metadata requests.'
    ]
  };
  let app = null;
  let chrome = null;
  try {
    app = BASE_URL ? {baseUrl: BASE_URL, async stop() {}} : await startLocalContestServer();
    chrome = await launchChrome();
    report.browser = {version: await browserVersion(chrome.browser), headless: process.env.HEADLESS !== 'false', executable: 'Google Chrome'};
    const requests = attachRequestLog(chrome.page);
    const start = await loginAndOpenProblem(chrome.page, app.baseUrl);
    report.startFromProblemPage = /\/problems\/[^/]+$/.test(chrome.page.url());
    report.start = start;
    if (!report.startFromProblemPage) throw new Error('did not reach a real Problem Page');
    const java = chrome.page.locator('#ide-lang option[value="java"]');
    if (await java.count() === 0) {
      report.localRun = {status: 'BLOCKED', reason: 'Problem Page has no Java 21 selector'};
      report.formalSubmit = {status: 'BLOCKED', reason: 'Java 21 selector missing; no submit attempted'};
      report.blockingFailures.push({id: 'java-selector', reason: 'Problem Page has no Java 21 selector'});
    } else {
      await chrome.page.locator('#ide-lang').selectOption('java');
      const localStart = requests.mark();
      await chrome.page.locator('#ide-code').fill(JAVA_SOURCE);
      await chrome.page.locator('#ide-input').fill('7 8');
      await chrome.page.locator('#ide-run').click();
      await waitForText(chrome.page.locator('#ide-output'), text => text !== '…' && text.length > 0, 180000, 100);
      const localEntries = requests.since(localStart);
      const local = classify(localEntries);
      const stdout = await chrome.page.locator('#ide-output').innerText();
      const runtimeUnavailable = /不可用|初始化失败|BUILD_REQUIRED|加载失败/.test(stdout);
      report.localRun = {
        status: local.allowedLocalPolicy && stdout.includes('15') ? 'PASS' : (runtimeUnavailable && local.allowedLocalPolicy ? 'BLOCKED' : 'FAIL'),
        stdoutBytes: Buffer.byteLength(stdout),
        outputExcerpt: stdout.slice(0, 500),
        runtimeUnavailable,
        classification: local,
        requests: localEntries
      };
      if (report.localRun.status === 'FAIL') report.blockingFailures.push({id: 'local-run-network', reason: 'Local Run emitted a forbidden/non-GET/source-like request or wrong output'});
      if (report.localRun.status === 'BLOCKED') report.blockingFailures.push({id: 'local-runtime', reason: 'Local network policy passed, but Java runtime did not produce stdout'});

      const formalStart = requests.mark();
      let formalError = null;
      try {
        await chrome.page.locator('#submit-btn').click();
        await chrome.page.locator('#submit-result').waitFor({state: 'visible', timeout: 30000});
      } catch (error) { formalError = String(error?.message || error); }
      const formalEntries = requests.since(formalStart);
      const formal = classify(formalEntries);
      const sourceUpload = formal.submissions.some(r => r.method === 'POST' && r.bodyFields.includes('code'));
      report.formalSubmit = {
        status: sourceUpload ? 'PASS' : (formalError ? 'BLOCKED' : 'FAIL'),
        classification: formal,
        requests: formalEntries,
        sourceUpload,
        error: formalError
      };
      if (!sourceUpload) report.blockingFailures.push({id: 'formal-submit-network', reason: formalError || 'Formal Submit did not upload source through the official submission POST'});
    }
  } catch (error) {
    report.blockingFailures.push({id: 'network-harness', reason: String(error?.stack || error)});
    report.error = String(error?.stack || error);
  } finally {
    mkdirSync(dirname(REPORT), {recursive: true});
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    try { await chrome?.context?.close(); } catch (_) {}
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await app?.stop(); } catch (_) {}
  }
  console.log(JSON.stringify({report: REPORT, local: report.localRun?.status, formal: report.formalSubmit?.status, blockingFailures: report.blockingFailures.length}));
  if (report.blockingFailures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
