import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  browserVersion,
  launchChrome,
  loginAndOpenProblem,
  nowIso
} from '../../compat-tests/java21/e2e/harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const CORPUS = resolve(process.env.CF_COMPAT_CORPUS || process.argv[2]
  || join(ROOT, 'tmp', 'codeforces-compat', 'contest-908-corpus.json'));
const REPORT = resolve(process.env.CF_COMPAT_REPORT
  || join(ROOT, 'output', 'codeforces-908-browser-compat.json'));
const RUN_TIMEOUT_MS = Math.max(10000, Number(process.env.CF_COMPAT_RUN_TIMEOUT_MS || 20000));

const baseOrigin = new URL(BASE_URL).origin;

const VERDICT_ALIASES = new Map([
  ['OK', 'OK'],
  ['AC', 'OK'],
  ['ACCEPTED', 'OK'],
  ['WA', 'WA'],
  ['WRONG_ANSWER', 'WA'],
  ['WRONGANSWER', 'WA'],
  ['CE', 'CE'],
  ['COMPILATION_ERROR', 'CE'],
  ['COMPILATIONERROR', 'CE'],
  ['RE', 'RE'],
  ['RUNTIME_ERROR', 'RE'],
  ['RUNTIMEERROR', 'RE'],
  ['TLE', 'TLE'],
  ['TIME_LIMIT_EXCEEDED', 'TLE'],
  ['TIMELIMITEXCEEDED', 'TLE'],
  ['MLE', 'MLE'],
  ['MEMORY_LIMIT_EXCEEDED', 'MLE'],
  ['MEMORYLIMITEXCEEDED', 'MLE']
]);

const EXPECTED_OUTCOME_BY_VERDICT = Object.freeze({
  OK: 'all_pass',
  WA: 'output_mismatch',
  CE: 'compile_error',
  RE: 'runtime_error',
  TLE: 'timeout'
});

/**
 * Normalize both Codeforces API verdicts and the short labels used by the
 * public corpus. Unknown verdicts intentionally return null: they must be
 * reported, but must not be treated as a browser compatibility failure.
 */
export function normalizeExpectedVerdict(value) {
  if (value == null) return null;
  const key = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  return VERDICT_ALIASES.get(key) || null;
}

export function expectedVerdictValue(submission) {
  if (!submission || typeof submission !== 'object') return null;
  return submission.verdict ?? submission.originalVerdict ?? submission.original_verdict
    ?? submission.result ?? submission.status ?? null;
}

export function expectedOutcomeForVerdict(verdict) {
  return EXPECTED_OUTCOME_BY_VERDICT[normalizeExpectedVerdict(verdict)] || null;
}

/**
 * MLE deliberately has no expected outcome here. The browser runner has no
 * portable memory-limit signal, so an MLE source that passes the public
 * inputs is a non-reproduction, not a test failure.
 */
export function expectedVerdictReproduced(expectedVerdict, observedOutcome) {
  const expectedOutcome = expectedOutcomeForVerdict(expectedVerdict);
  return expectedOutcome != null && expectedOutcome === observedOutcome;
}

export function assessExpectedVerdict(expectedVerdict, observedOutcome) {
  const normalized = normalizeExpectedVerdict(expectedVerdict);
  const expectedOutcome = expectedOutcomeForVerdict(normalized);
  const comparable = expectedOutcome != null;
  return {
    expectedVerdict: normalized,
    expectedOutcome,
    comparable,
    reproduced: comparable && expectedOutcome === observedOutcome,
    // MLE is intentionally explicit instead of being mislabelled RE/TLE.
    note: normalized === 'MLE' ? 'memory_limit_is_not_observable_in_browser_runner' : null
  };
}

export function classifyObservedOutcome(item) {
  if (!item || item.unsupported) return 'unsupported';
  if (item.compileFailed) return 'compile_error';
  if (item.timedOut) return 'timeout';
  if (item.runtimeError) return 'runtime_error';
  if (item.outputMismatch) return 'output_mismatch';
  if (item.allTestsPassed) return 'all_pass';
  return 'unsupported';
}

export function sourceLanguage(submission) {
  if (!submission || typeof submission !== 'object') return null;
  return submission.programmingLanguage ?? submission.language ?? submission.originalLanguage ?? null;
}

export function profileFor(language) {
  if (!language) return null;
  const label = String(language);
  if (label === 'GNU C' || label === 'GNU C11') return 'c';
  if (label === 'C17') return 'c17';
  if (label === 'C++14 (GCC 6-32)') return 'cpp17';
  if (label === 'Python 3' || label.startsWith('PyPy 3')) return 'python3';
  if (label.startsWith('Java ')) return 'java21';
  if (label.includes('C++17')) return 'cpp17';
  if (label.includes('C++')) return 'cpp';
  return null;
}

function shouldStopAfterMeasurement(expectedVerdict, item) {
  if (item.compileFailed) return true;
  if (expectedVerdict === 'WA' && item.outputMismatch) return true;
  if (expectedVerdict === 'RE' && item.runtimeError) return true;
  if (expectedVerdict === 'TLE' && item.timedOut) return true;
  return false;
}

export function executionPlanForSubmission(submission, publicTests) {
  const tests = Array.isArray(publicTests) ? publicTests : [];
  if (tests.length > 0) return {tests, usesCompileProbe: false};
  if (normalizeExpectedVerdict(expectedVerdictValue(submission)) === 'CE') {
    return {
      tests: [{test_i: null, input: '', output: '', syntheticCompileProbe: true}],
      usesCompileProbe: true
    };
  }
  return {tests: [], usesCompileProbe: false};
}

function tokens(value) { return String(value || '').trim().split(/\s+/).filter(Boolean); }

function outputMatches(problemId, actual, expected) {
  const left = tokens(actual);
  const right = tokens(expected);
  if (left.length !== right.length) return false;
  if (problemId !== '908/C') return left.every((value, index) => value === right[index]);
  return left.every((value, index) => {
    const a = Number(value);
    const b = Number(right[index]);
    return Number.isFinite(a) && Number.isFinite(b)
      && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  });
}

export function summarize(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key] ?? null;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return Object.fromEntries([...groups].map(([value, items]) => [value, {
    submissions: items.length,
    compiled: items.filter(item => item.compiled).length,
    allTestsPassed: items.filter(item => item.allTestsPassed).length,
    compileFailed: items.filter(item => item.compileFailed).length,
    timedOut: items.filter(item => item.timedOut).length,
    runtimeError: items.filter(item => item.runtimeError).length,
    outputMismatch: items.filter(item => item.outputMismatch).length,
    observedOutcomes: Object.fromEntries([...new Set(items.map(item => item.observedOutcome))]
      .map(outcome => [outcome, items.filter(item => item.observedOutcome === outcome).length])),
    expectedVerdictReproduced: items.filter(item => item.expectedVerdictReproduced === true).length,
    expectedVerdictComparable: items.filter(item => item.expectedVerdictComparable === true).length,
    expectedVerdictNotReproduced: items.filter(item => item.expectedVerdictComparable === true
      && item.expectedVerdictReproduced !== true).length
  }]));
}

async function runOne(page, profile, source, test) {
  return page.evaluate(async ({profile, source, test, timeoutMs}) => {
    const runner = globalThis.__IDE_RUNNER__;
    const started = performance.now();
    const timeout = new Promise(resolve => setTimeout(() => resolve({
      harnessTimeout: true, compileStatus: 'HARNESS_TIMEOUT', runStatus: 'HARNESS_TIMEOUT',
      stdout: '', stderr: 'compatibility harness timeout'
    }), timeoutMs));
    const execution = Promise.resolve().then(() => runner.runCode({
      language: profile, source, stdin: test.input, optLevel: '-O2', pchLevel: 'none'
    })).catch(error => ({
      runnerError: true,
      compileStatus: 'PASS',
      runStatus: 'RE',
      runtimeError: true,
      exitCode: -1,
      stdout: '',
      stderr: String(error?.stack || error?.message || error).slice(0, 2000)
    }));
    const result = await Promise.race([
      execution,
      timeout
    ]);
    return {
      wallMs: Math.round((performance.now() - started) * 10) / 10,
      runtimeId: result.runtimeId || null,
      compileStatus: result.compileStatus || null,
      runStatus: result.runStatus || null,
      compileFailed: !!result.compileFailed || result.compileStatus === 'CE',
      timedOut: !!result.timedOut || !!result.harnessTimeout || result.runStatus === 'LOCAL_TIMEOUT',
      runtimeError: !!result.runtimeError || result.runStatus === 'RE'
        || result.runStatus === 'ABORTED'
        || (result.exitCode != null && result.exitCode !== 0
          && result.runStatus !== 'LOCAL_TIMEOUT' && result.runStatus !== 'HARNESS_TIMEOUT'),
      runnerError: !!result.runnerError,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || '').slice(0, 2000),
      exitCode: result.exitCode == null ? null : result.exitCode,
      compileMs: result.compileTime ?? result.timing?.compileMs ?? null,
      linkMs: result.linkTime ?? result.timing?.linkMs ?? null,
      executionMs: result.executionTime ?? result.timing?.executionMs ?? null,
      cacheHit: !!result.cacheHit
    };
  }, {profile, source, test, timeoutMs: RUN_TIMEOUT_MS});
}

function testRecord(measured, test, problemId) {
  const passedStatus = measured.runStatus === 'PASS' || measured.runStatus === 'AC';
  const matched = passedStatus && outputMatches(problemId, measured.stdout, test.output);
  return {
    testIndex: test.test_i,
    syntheticCompileProbe: !!test.syntheticCompileProbe,
    inputBytes: Buffer.byteLength(test.input || ''),
    expectedOutputBytes: Buffer.byteLength(test.output || ''),
    matched,
    wallMs: measured.wallMs,
    runtimeId: measured.runtimeId,
    compileStatus: measured.compileStatus,
    runStatus: measured.runStatus,
    compileMs: measured.compileMs,
    linkMs: measured.linkMs,
    executionMs: measured.executionMs,
    cacheHit: measured.cacheHit,
    exitCode: measured.exitCode,
    actualPreview: matched ? null : measured.stdout.slice(0, 300),
    expectedPreview: matched ? null : String(test.output || '').slice(0, 300),
    stderr: measured.stderr
  };
}

function updateItemFromMeasurement(item, measured, record) {
  item.compiled ||= !measured.compileFailed && !measured.runnerError
    && measured.compileStatus !== 'HARNESS_TIMEOUT';
  item.compileFailed ||= measured.compileFailed;
  item.timedOut ||= measured.timedOut;
  item.runtimeError ||= !measured.compileFailed && !measured.timedOut && measured.runtimeError;
  item.outputMismatch ||= !measured.compileFailed && !measured.timedOut
    && !measured.runtimeError && measured.runStatus !== 'RE'
    && measured.runStatus !== 'ABORTED' && measured.runStatus !== 'HARNESS_TIMEOUT'
    && !record.matched;
}

function outcomeCounts(rows) {
  return Object.fromEntries([...new Set(rows.map(row => row.observedOutcome))]
    .map(outcome => [outcome, rows.filter(row => row.observedOutcome === outcome).length]));
}

export function acceptedCompatibilityIssues(rows) {
  return rows.filter(row => (row.expectedVerdict === 'OK' || row.expectedVerdict == null)
    && row.observedOutcome !== 'all_pass');
}

async function main() {
  const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
  const testsByProblem = new Map();
  for (const test of corpus.tests || []) {
    if (!testsByProblem.has(test.problem_id)) testsByProblem.set(test.problem_id, []);
    testsByProblem.get(test.problem_id).push(test);
  }

  const {server, browser, context, page} = await launchChrome();
  const observedBrowser = await browserVersion(browser);
  const blockedNetwork = [];
  const results = [];

  try {
    await loginAndOpenProblem(page, BASE_URL);
    await page.waitForFunction(() => !!globalThis.__IDE_RUNNER__, null, {timeout: 20000});
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const allowedRuntimeGet = request.method() === 'GET' && url.origin === baseOrigin
        && (url.pathname.startsWith('/runtime/') || url.pathname.startsWith('/js/contest/')
          || url.pathname.startsWith('/js/runno/'));
      if (allowedRuntimeGet) return route.continue();
      blockedNetwork.push({method: request.method(), origin: url.origin, pathname: url.pathname});
      return route.abort('blockedbyclient');
    });

    for (const [index, submission] of (corpus.sources || []).entries()) {
      const publicTests = testsByProblem.get(submission.problem_id) || [];
      const plan = executionPlanForSubmission(submission, publicTests);
      const language = sourceLanguage(submission);
      const profile = profileFor(language);
      const originalVerdict = expectedVerdictValue(submission);
      const expectedVerdict = normalizeExpectedVerdict(originalVerdict);
      process.stderr.write(`[cf-compat] ${index + 1}/${corpus.sources.length} ${submission.submission_id} `
        + `${submission.problem_id} ${language || '(unknown language)'} `
        + `${originalVerdict ? `[${originalVerdict}] ` : ''}-> ${profile || 'unsupported'}\n`);
      const item = {
        submissionId: submission.submission_id,
        problemId: submission.problem_id,
        originalLanguage: language,
        originalVerdict: originalVerdict == null ? null : String(originalVerdict),
        expectedVerdict,
        browserProfile: profile,
        sourceBytes: Buffer.byteLength(submission.source || ''),
        publicTestCount: publicTests.length,
        tests: [],
        compileProbe: null,
        compiled: false,
        compileFailed: false,
        timedOut: false,
        runtimeError: false,
        outputMismatch: false,
        allTestsPassed: false,
        unsupported: !profile || (publicTests.length === 0 && !plan.usesCompileProbe)
      };
      if (profile) {
        for (const test of plan.tests) {
          const measured = await runOne(page, profile, submission.source || '', test);
          const record = testRecord(measured, test, submission.problem_id);
          if (test.syntheticCompileProbe) item.compileProbe = record;
          else item.tests.push(record);
          updateItemFromMeasurement(item, measured, record);
          if (shouldStopAfterMeasurement(expectedVerdict, item)) break;
        }
      }
      item.allTestsPassed = !item.unsupported && publicTests.length > 0
        && item.tests.length === publicTests.length
        && item.tests.every(test => test.matched);
      item.observedOutcome = classifyObservedOutcome(item);
      const assessment = assessExpectedVerdict(expectedVerdict, item.observedOutcome);
      item.expectedOutcome = assessment.expectedOutcome;
      item.expectedVerdictComparable = assessment.comparable;
      item.expectedVerdictReproduced = assessment.reproduced;
      item.expectedVerdictNote = assessment.note;
      item.expectedVerdictMismatch = assessment.comparable && !assessment.reproduced;
      results.push(item);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const report = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    contestId: corpus.contestId,
    corpus: CORPUS,
    browser: observedBrowser,
    safety: {
      source: 'Third-party Codeforces sources executed only inside browser workers.',
      networkPolicy: 'Only same-origin GET requests for /runtime, /js/contest and /js/runno were allowed.',
      blockedNetworkRequests: blockedNetwork
    },
    totals: {
      submissions: results.length,
      compiled: results.filter(item => item.compiled).length,
      allTestsPassed: results.filter(item => item.allTestsPassed).length,
      compileFailed: results.filter(item => item.compileFailed).length,
      timedOut: results.filter(item => item.timedOut).length,
      runtimeError: results.filter(item => item.runtimeError).length,
      outputMismatch: results.filter(item => item.outputMismatch).length,
      unsupported: results.filter(item => item.observedOutcome === 'unsupported').length,
      observedOutcomes: outcomeCounts(results),
      expectedVerdictReproduced: results.filter(item => item.expectedVerdictReproduced).length,
      expectedVerdictComparable: results.filter(item => item.expectedVerdictComparable).length,
      expectedVerdictNotReproduced: results.filter(item => item.expectedVerdictComparable
        && !item.expectedVerdictReproduced).length,
      compatibilityIssues: acceptedCompatibilityIssues(results).length,
      testRuns: results.reduce((sum, item) => sum + item.tests.length, 0),
      matchedTestRuns: results.reduce((sum, item) => sum + item.tests.filter(test => test.matched).length, 0)
    },
    // Keep the original AC-oriented summaries and add verdict/language views.
    byOriginalLanguage: summarize(results, 'originalLanguage'),
    byLanguage: summarize(results, 'originalLanguage'),
    byVerdict: summarize(results, 'expectedVerdict'),
    byBrowserProfile: summarize(results, 'browserProfile'),
    results
  };

  mkdirSync(dirname(REPORT), {recursive: true});
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({report: REPORT, totals: report.totals,
    byLanguage: report.byLanguage, byVerdict: report.byVerdict,
    blockedNetworkRequests: blockedNetwork.length}, null, 2));
  // Only an originally Accepted source failing public tests is a compatibility
  // failure. WA/TLE/MLE non-reproduction is expected with public samples and
  // must never make this replay command fail.
  if (report.totals.compatibilityIssues > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
