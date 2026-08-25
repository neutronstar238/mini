import {createHash} from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  attachRequestLog,
  browserVersion,
  launchChrome,
  loginAndOpenProblem,
  nowIso,
  startLocalContestServer
} from '../../compat-tests/java21/e2e/harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_REPORT = join(ROOT, 'output', 'contest-archive-browser-compat.json');
const INPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_RUN_TIMEOUT_MS = 360000;
let stopRequested = false;

const LANGUAGE_BY_CODE = new Map([
  [0, {language: 'c', profileId: 'c17-gcc14-compat-v2', label: 'C'}],
  [1, {language: 'cpp', profileId: 'cpp17-gcc14-compat-v2', label: 'C++'}],
  [3, {language: 'java', profileId: null, label: 'Java'}],
  [6, {language: 'python', profileId: null, label: 'Python'}]
]);

const VERDICT_BY_CODE = new Map([
  [4, 'AC'], [5, 'PE'], [6, 'WA'], [7, 'TLE'], [8, 'MLE'],
  [9, 'OLE'], [10, 'RE'], [11, 'CE']
]);

const FORBIDDEN_REQUEST = /\/api\/(?:judge|workers)(?:\/|$)|\/api\/contest\/(?:contests\/[^/]+\/)?submissions(?:$|[/?])|\/(?:judge|rejudge)(?:\/|$)/i;

export function requestIsForbidden(method, url) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return false;
  return FORBIDDEN_REQUEST.test(String(url || ''));
}

function isLocalTimeoutRun(run) {
  return !!run && run.harnessTimeout !== true
    && run.runStatus !== 'UNAVAILABLE'
    && run.runStatus !== 'HARNESS_TIMEOUT' && (
    run.runStatus === 'LOCAL_TIMEOUT' || run.timedOut === true
  );
}

function isTransientEnvironmentGapRun(run) {
  if (!run || isLocalTimeoutRun(run)) return false;
  return run.harnessTimeout === true
    || run.runStatus === 'HARNESS_TIMEOUT'
    || run.runStatus === 'UNAVAILABLE'
    || run.runStatus === 'ABORTED';
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const archives = [];
  const options = {
    archives,
    report: DEFAULT_REPORT,
    languages: new Set(['c', 'cpp', 'python', 'java']),
    resume: false,
    retryCoverage: new Set(),
    inventoryOnly: false,
    stream: null,
    maxSubmissions: Infinity,
    runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--archive') archives.push(resolve(argv[++i]));
    else if (arg === '--report') options.report = resolve(argv[++i]);
    else if (arg === '--languages') options.languages = new Set(String(argv[++i]).split(',').map(v => v.trim()).filter(Boolean));
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--retry-coverage') options.retryCoverage = new Set(String(argv[++i]).split(',').map(v => v.trim()).filter(Boolean));
    else if (arg === '--inventory-only') options.inventoryOnly = true;
    else if (arg === '--stream') options.stream = resolve(argv[++i]);
    else if (arg === '--max-submissions') options.maxSubmissions = Math.max(0, Number(argv[++i]) || 0);
    else if (arg === '--run-timeout-ms') options.runTimeoutMs = Math.max(10000, Number(argv[++i]) || DEFAULT_RUN_TIMEOUT_MS);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (archives.length === 0) throw new Error('at least one --archive PATH is required');
  return options;
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function extractProblemBundle(archiveRoot) {
  const zipPath = join(archiveRoot, 'problems', 'OJ-Problem-csgoj.zip');
  if (!existsSync(zipPath)) throw new Error('problem bundle not found');
  const extractedRoot = mkdtempSync(join(tmpdir(), 'webjudge-contest-archive-'));
  const result = spawnSync('tar', ['-xf', zipPath, '-C', extractedRoot], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    rmSync(extractedRoot, {recursive: true, force: true});
    throw new Error(`cannot extract problem bundle: ${result.stderr || result.stdout}`);
  }
  const problems = JSON.parse(readFileSync(join(extractedRoot, 'problemlist.json'), 'utf8'));
  return {extractedRoot, problems};
}

export function problemIsInteractive(problem) {
  const text = [problem?.title, problem?.description, problem?.input, problem?.output, problem?.hint]
    .filter(Boolean).join('\n');
  return String(problem?.spj) === '2' || /交互题|交互器|interactive|interactor/i.test(text);
}

function naturalCompare(left, right) {
  return left.localeCompare(right, 'en', {numeric: true, sensitivity: 'base'});
}

function loadProblemTests(extractedRoot, problemIndex) {
  const directory = join(extractedRoot, `TEST_${String(problemIndex).padStart(5, '0')}`);
  if (!existsSync(directory)) return [];
  const inputs = readdirSync(directory).filter(name => name.endsWith('.in')).sort(naturalCompare);
  return inputs.map(inputName => {
    const stem = inputName.slice(0, -3);
    const outputName = `${stem}.out`;
    const inputPath = join(directory, inputName);
    const outputPath = join(directory, outputName);
    const inputBytes = statSync(inputPath).size;
    const outputBytes = existsSync(outputPath) ? statSync(outputPath).size : null;
    const skipReasons = [];
    if (inputBytes > INPUT_LIMIT_BYTES) skipReasons.push('LOCAL_INPUT_LIMIT');
    if (outputBytes != null && outputBytes > OUTPUT_LIMIT_BYTES) skipReasons.push('LOCAL_OUTPUT_LIMIT');
    return {
      name: stem,
      inputPath,
      outputPath: existsSync(outputPath) ? outputPath : null,
      inputBytes,
      outputBytes,
      sample: /^sample$/i.test(stem),
      skipReasons
    };
  });
}

export function expectedFailureReproduced(verdict, run) {
  if (isTransientEnvironmentGapRun(run)) return false;
  if (verdict === 'CE') return run.compileStatus === 'CE' || run.compileFailed;
  if (run.compileStatus === 'CE' || run.compileFailed) return false;
  if (verdict === 'WA') return run.outputMatches === false;
  if (verdict === 'TLE') return run.runStatus === 'LOCAL_TIMEOUT' || run.timedOut;
  if (verdict === 'RE') return run.runStatus === 'RE' || run.runtimeError
    || (run.exitCode != null && run.exitCode !== 0 && run.runStatus !== 'LOCAL_TIMEOUT');
  if (verdict === 'OLE') return run.coverageLimited && run.reason === 'LOCAL_OUTPUT_LIMIT';
  return false;
}

export function tokenOutputMatches(actual, expected) {
  const left = String(actual ?? '').trim().split(/\s+/).filter(Boolean);
  const right = String(expected ?? '').trim().split(/\s+/).filter(Boolean);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function summarize(rows) {
  const countBy = (key) => Object.fromEntries([...new Set(rows.map(row => row[key] ?? 'unknown'))]
    .map(value => [value, rows.filter(row => (row[key] ?? 'unknown') === value).length]));
  return {
    submissions: rows.length,
    byContest: countBy('contestId'),
    byLanguage: countBy('language'),
    byOfficialVerdict: countBy('officialVerdict'),
    byCoverage: countBy('coverage'),
    testsRun: rows.reduce((sum, row) => sum + (row.testsRun?.length || 0), 0),
    testsSkippedForIo: rows.reduce((sum, row) => sum + (row.testsSkipped?.length || 0), 0),
    expectedFailureReproduced: rows.filter(row => row.expectedFailureReproduced).length,
    compatibilityFailures: rows.filter(row => /failure|mismatch|gap/.test(row.coverage || '')).length
  };
}

function checkpoint(report, reportPath) {
  report.updatedAt = nowIso();
  report.summary = summarize(report.submissions);
  mkdirSync(dirname(reportPath), {recursive: true});
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function streamResult(row, options) {
  if (!options.stream) return;
  mkdirSync(dirname(options.stream), {recursive: true});
  appendFileSync(options.stream, `${JSON.stringify({
    at: nowIso(), event: 'submission_attempt', attempt: row.attempt || 1, ...row
  })}\n`, 'utf8');
}

function archiveInventory(archiveRoot, bundle) {
  const manifest = JSON.parse(readFileSync(join(archiveRoot, 'manifest.json'), 'utf8'));
  const sourceIndex = JSON.parse(readFileSync(join(archiveRoot, 'data', 'source_index.json'), 'utf8'));
  const solutions = readJsonLines(join(archiveRoot, 'data', 'solutions.jsonl'));
  const problemMap = new Map(bundle.problems.map(problem => [Number(problem.problem_new_id), problem]));
  const languageCounts = {};
  const verdictCounts = {};
  for (const solution of solutions) {
    const language = LANGUAGE_BY_CODE.get(Number(solution.language))?.language || `code_${solution.language}`;
    const verdict = VERDICT_BY_CODE.get(Number(solution.result)) || `code_${solution.result}`;
    languageCounts[language] = (languageCounts[language] || 0) + 1;
    verdictCounts[verdict] = (verdictCounts[verdict] || 0) + 1;
  }
  const problems = [...problemMap].sort((a, b) => a[0] - b[0]).map(([index, problem]) => {
    const tests = loadProblemTests(bundle.extractedRoot, index);
    return {
      index,
      problemId: Number(problem.problem_id),
      title: problem.title,
      interactive: problemIsInteractive(problem),
      specialJudge: String(problem.spj) === '1',
      tests: tests.length,
      eligibleTests: tests.filter(test => test.skipReasons.length === 0).length,
      skippedInputLimit: tests.filter(test => test.skipReasons.includes('LOCAL_INPUT_LIMIT')).length,
      skippedOutputLimit: tests.filter(test => test.skipReasons.includes('LOCAL_OUTPUT_LIMIT')).length,
      maxInputBytes: Math.max(0, ...tests.map(test => test.inputBytes)),
      maxOutputBytes: Math.max(0, ...tests.map(test => test.outputBytes || 0))
    };
  });
  return {
    contestId: Number(manifest.source_contest_id),
    label: basename(archiveRoot),
    submissions: solutions.length,
    sources: Object.keys(sourceIndex).length,
    languageCounts,
    verdictCounts,
    problems
  };
}

function submissionKey(contestId, submissionId) {
  return `${contestId}:${submissionId}`;
}

function compactRunResult(test, result, expected, specialJudge) {
  const harnessTimeout = !!result.harnessTimeout || result.runStatus === 'HARNESS_TIMEOUT';
  const localTimeout = !harnessTimeout
    && result.runStatus !== 'UNAVAILABLE'
    && result.runStatus !== 'HARNESS_TIMEOUT'
    && (result.runStatus === 'LOCAL_TIMEOUT' || result.timedOut === true || result.status === 'interrupted');
  const outputMatches = specialJudge || expected == null ? null : tokenOutputMatches(result.stdout, expected);
  return {
    test: test.name,
    sample: test.sample,
    inputBytes: test.inputBytes,
    expectedOutputBytes: test.outputBytes,
    compileStatus: result.compileStatus || null,
    runStatus: localTimeout ? 'LOCAL_TIMEOUT' : (result.runStatus || null),
    exitCode: result.exitCode ?? null,
    timedOut: localTimeout || !!result.timedOut,
    runtimeError: !!result.runtimeError || result.runStatus === 'RE',
    coverageLimited: !!result.coverageLimited || result.runStatus === 'LOCAL_UNSUPPORTED',
    reason: result.reason || null,
    outputMatches,
    stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(String(result.stdout || ''), 'utf8'),
    stderr: String(result.stderr || '').slice(0, 800),
    executionTime: result.executionTime ?? result.executionMs ?? null,
    compileTime: result.compileTime ?? null,
    cacheHit: !!result.cacheHit,
    harnessTimeout
  };
}

async function browserRun(page, payload, timeoutMs) {
  return page.evaluate(async ({payload, timeoutMs}) => {
    const runner = globalThis.__IDE_RUNNER__;
    if (!runner || typeof runner.runCode !== 'function') throw new Error('browser runner unavailable');
    const killers = [];
    const runPayload = {...payload, killers};
    let timer = null;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        for (const kill of [...killers]) {
          try { kill(); } catch (_) { /* page reload remains the final fallback */ }
        }
        resolve({
          compileStatus: 'SKIP', runStatus: 'HARNESS_TIMEOUT', harnessTimeout: true,
          stdout: '', stderr: `browser replay harness exceeded ${timeoutMs}ms`, exitCode: -1
        });
      }, timeoutMs);
    });
    try { return await Promise.race([runner.runCode(runPayload), timeout]); }
    finally { if (timer) clearTimeout(timer); }
  }, {payload, timeoutMs});
}

async function resetRunnerPage(page) {
  await page.reload({waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => globalThis.__IDE_RUNNER__ && typeof globalThis.__IDE_RUNNER__.runCode === 'function', null, {timeout: 30000});
}

function classifyCoverage(row, officialVerdict, specialJudge) {
  const runs = Array.isArray(row.testsRun) ? row.testsRun : [];
  if (row.interactive) return 'excluded_interactive';
  if (row.sourceMissing) return 'source_missing';
  if (runs.some(isTransientEnvironmentGapRun)) return 'environment_gap';
  if (runs.some(run => run.coverageLimited)) return 'partially_covered_runtime_limit';
  if (officialVerdict !== 'CE' && runs.some(run => run.compileStatus === 'CE')) return 'compatibility_compile_failure';
  if (officialVerdict === 'AC' && runs.some(run => run.runStatus === 'RE'
    || run.runStatus === 'LOCAL_TIMEOUT'
    || run.runtimeError === true
    || (run.exitCode != null && run.exitCode !== 0))) return 'compatibility_runtime_failure';
  if (officialVerdict === 'AC' && !specialJudge && runs.some(run => run.outputMatches === false)) return 'semantic_mismatch';
  if (officialVerdict === 'AC' && (row.testsSkipped?.length || 0) > 0) return 'partially_covered_io_limits';
  if (officialVerdict === 'AC' && specialJudge) return 'runtime_covered_special_judge';
  if (officialVerdict === 'AC') return 'covered';
  if (officialVerdict === 'CE') return row.expectedFailureReproduced
    ? 'covered_expected_ce'
    : 'official_failure_not_reproduced';
  if (officialVerdict === 'MLE') return 'runtime_covered_mle_unobservable';
  if (specialJudge) return 'runtime_covered_special_judge';
  if (!row.expectedFailureReproduced) return 'official_failure_not_reproduced';
  return 'runtime_covered';
}

function normalizeReportRow(row) {
  const originalRuns = Array.isArray(row.testsRun) ? row.testsRun : [];
  const testsRun = originalRuns.map(run => {
    if (!isLocalTimeoutRun(run)) return run;
    if (run.runStatus === 'LOCAL_TIMEOUT' && run.timedOut === true) return run;
    return {...run, runStatus: 'LOCAL_TIMEOUT', timedOut: true};
  });
  const changed = testsRun.some((run, index) => run !== originalRuns[index]);
  const hasOfficialVerdict = typeof row.officialVerdict === 'string' && row.officialVerdict.length > 0;
  if (!changed && !hasOfficialVerdict) return row;
  const normalized = changed ? {...row, testsRun} : {...row};
  if (changed && hasOfficialVerdict) {
    normalized.expectedFailureReproduced = testsRun.some(run => expectedFailureReproduced(
      normalized.officialVerdict, run
    ));
  }
  if (hasOfficialVerdict) {
    normalized.coverage = classifyCoverage(normalized, normalized.officialVerdict, !!normalized.specialJudge);
  }
  return normalized;
}

function isRetryableEnvironmentGap(row) {
  return row?.coverage === 'environment_gap'
    || (row?.testsRun || []).some(isTransientEnvironmentGapRun);
}

function prepareResumedReport(report) {
  const latestByKey = new Map();
  for (const row of report.submissions || []) {
    const normalized = normalizeReportRow(row);
    latestByKey.set(normalized.key, normalized);
  }
  report.submissions = [...latestByKey.values()];
}

function nextAttempt(report, key) {
  const previous = report.submissions.find(row => row.key === key);
  if (!previous) return 1;
  return Math.max(1, Number(previous.attempt) || 1) + 1;
}

function recordSubmission(report, row) {
  const index = report.submissions.findIndex(existing => existing.key === row.key);
  if (index >= 0) report.submissions[index] = row;
  else report.submissions.push(row);
}

async function runArchive({archiveRoot, bundle, report, completed, page, options, progress}) {
  const manifest = JSON.parse(readFileSync(join(archiveRoot, 'manifest.json'), 'utf8'));
  const contestId = Number(manifest.source_contest_id);
  const sourceIndex = JSON.parse(readFileSync(join(archiveRoot, 'data', 'source_index.json'), 'utf8'));
  const solutions = readJsonLines(join(archiveRoot, 'data', 'solutions.jsonl'));
  const problemMap = new Map(bundle.problems.map(problem => [Number(problem.problem_new_id), problem]));
  const testCache = new Map();

  for (const solution of solutions) {
    if (stopRequested || progress.processed >= options.maxSubmissions) break;
    const submissionId = Number(solution.legacy_solution_id);
    const key = submissionKey(contestId, submissionId);
    if (completed.has(key)) continue;
    const languageProfile = LANGUAGE_BY_CODE.get(Number(solution.language));
    if (!languageProfile || !options.languages.has(languageProfile.language)) continue;
    progress.processed += 1;

    const problemIndex = Number(solution.problem_export_index);
    const problem = problemMap.get(problemIndex) || null;
    const relativeSource = sourceIndex[String(submissionId)] || null;
    const sourcePath = relativeSource ? join(archiveRoot, relativeSource) : null;
    const officialVerdict = VERDICT_BY_CODE.get(Number(solution.result)) || `CODE_${solution.result}`;
    const row = {
      key,
      attempt: nextAttempt(report, key),
      contestId,
      submissionId,
      teamId: solution.team_id || null,
      problemIndex: Number.isFinite(problemIndex) ? problemIndex : null,
      problemId: problem ? Number(problem.problem_id) : Number(solution.legacy_problem_id) || null,
      language: languageProfile.language,
      languageLabel: languageProfile.label,
      originalLanguageCode: Number(solution.language),
      officialVerdict,
      originalVerdictCode: Number(solution.result),
      sourcePath: relativeSource,
      sourceHash: null,
      interactive: problem ? problemIsInteractive(problem) : false,
      specialJudge: problem ? String(problem.spj) === '1' : false,
      testsRun: [],
      testsSkipped: [],
      expectedFailureReproduced: false,
      coverage: null
    };

    if (row.interactive) {
      row.coverage = 'excluded_interactive';
      recordSubmission(report, row);
      completed.add(key);
      streamResult(row, options);
      checkpoint(report, options.report);
      continue;
    }
    if (!sourcePath || !existsSync(sourcePath)) {
      row.sourceMissing = true;
      row.coverage = 'source_missing';
      recordSubmission(report, row);
      completed.add(key);
      streamResult(row, options);
      checkpoint(report, options.report);
      continue;
    }

    const source = readFileSync(sourcePath, 'utf8');
    row.sourceHash = sha256(source);
    let tests = [];
    if (problem) {
      if (!testCache.has(problemIndex)) testCache.set(problemIndex, loadProblemTests(bundle.extractedRoot, problemIndex));
      const allTests = testCache.get(problemIndex);
      row.testsSkipped = allTests.filter(test => test.skipReasons.length > 0).map(test => ({
        test: test.name,
        inputBytes: test.inputBytes,
        expectedOutputBytes: test.outputBytes,
        reasons: test.skipReasons
      }));
      tests = allTests.filter(test => test.skipReasons.length === 0);
    }

    if (tests.length === 0 || officialVerdict === 'CE') {
      tests = [{name: 'compile-probe', inputBytes: 0, outputBytes: 0, sample: false,
        inputPath: null, outputPath: null, skipReasons: []}];
    } else if (officialVerdict === 'MLE') {
      tests = [tests.find(test => !test.sample) || tests[0]];
    } else if (officialVerdict !== 'AC') {
      tests = [...tests].sort((a, b) => Number(a.sample) - Number(b.sample) || b.inputBytes - a.inputBytes);
    }

    for (const test of tests) {
      if (stopRequested) return;
      const stdin = test.inputPath ? readFileSync(test.inputPath, 'utf8') : '';
      const expected = test.outputPath ? readFileSync(test.outputPath, 'utf8') : null;
      let result;
      try {
        result = await browserRun(page, {
          language: languageProfile.language === 'cpp' ? 'cpp17'
            : (languageProfile.language === 'c' ? 'c17' : languageProfile.language),
          profileId: languageProfile.profileId,
          source,
          stdin
        }, options.runTimeoutMs);
      } catch (error) {
        result = {compileStatus: 'SKIP', runStatus: 'UNAVAILABLE', stdout: '',
          stderr: error.message || String(error), exitCode: -1};
      }
      const compact = compactRunResult(test, result, expected, row.specialJudge);
      row.testsRun.push(compact);
      console.log(`[contest-replay:test] ${key} ${row.language} ${test.name} compile=${compact.compileStatus} run=${compact.runStatus} match=${compact.outputMatches} time=${compact.executionTime ?? '-'}ms`);
      if (compact.harnessTimeout) await resetRunnerPage(page);
      if (expectedFailureReproduced(officialVerdict, compact)) {
        row.expectedFailureReproduced = true;
        if (officialVerdict !== 'AC') break;
      }
      if (compact.compileStatus === 'CE' || compact.coverageLimited || compact.runStatus === 'UNAVAILABLE') break;
    }

    row.coverage = classifyCoverage(row, officialVerdict, row.specialJudge);
    recordSubmission(report, row);
    completed.add(key);
    streamResult(row, options);
    checkpoint(report, options.report);
    const done = report.submissions.length;
    console.log(`[contest-replay] ${done} ${key} ${row.language} ${row.officialVerdict} -> ${row.coverage} runs=${row.testsRun.length}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.stream && !options.resume) rmSync(options.stream, {force: true});
  const report = options.resume && existsSync(options.report)
    ? JSON.parse(readFileSync(options.report, 'utf8'))
    : {
        schemaVersion: 1,
        createdAt: nowIso(),
        limits: {inputBytes: INPUT_LIMIT_BYTES, outputBytes: OUTPUT_LIMIT_BYTES},
        mode: 'browser-only-no-judge',
        inventory: [],
        submissions: [],
        network: {forbiddenRequests: [], sourceLikeRequests: []}
      };
  if (options.resume) prepareResumedReport(report);
  const completed = new Set(report.submissions.map(row => row.key));
  if (options.resume) {
    for (const row of report.submissions) {
      if (isRetryableEnvironmentGap(row) || options.retryCoverage.has(row.coverage)) completed.delete(row.key);
    }
  }
  const bundles = [];
  try {
    for (const archiveRoot of options.archives) {
      const bundle = extractProblemBundle(archiveRoot);
      bundles.push({archiveRoot, ...bundle});
      const inventory = archiveInventory(archiveRoot, bundle);
      const existing = report.inventory.findIndex(item => item.contestId === inventory.contestId);
      if (existing >= 0) report.inventory[existing] = inventory;
      else report.inventory.push(inventory);
    }
    checkpoint(report, options.report);
    if (options.inventoryOnly) {
      console.log(JSON.stringify({report: options.report, inventory: report.inventory}, null, 2));
      return;
    }

    const app = await startLocalContestServer();
    let chrome = null;
    try {
      chrome = await launchChrome();
      const forbidden = [];
      await chrome.context.route('**/*', async route => {
        if (requestIsForbidden(route.request().method(), route.request().url())) {
          forbidden.push({method: route.request().method(), url: new URL(route.request().url()).pathname});
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
      const requestLog = attachRequestLog(chrome.page);
      const pageErrors = [];
      chrome.page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 1000)));
      await loginAndOpenProblem(chrome.page, app.baseUrl);
      await chrome.page.waitForFunction(() => globalThis.__IDE_RUNNER__ && typeof globalThis.__IDE_RUNNER__.runCode === 'function');
      report.browser = {version: await browserVersion(chrome.browser), executable: 'Google Chrome', pageErrors};
      const progress = {processed: 0};
      for (const bundle of bundles) {
        if (stopRequested) break;
        await runArchive({archiveRoot: bundle.archiveRoot, bundle, report, completed,
          page: chrome.page, options, progress});
      }
      report.network.forbiddenRequests = forbidden;
      report.network.sourceLikeRequests = requestLog.entries.filter(entry => entry.hasSourceLikeBody)
        .map(entry => ({method: entry.method, path: new URL(entry.url).pathname, bodyFields: entry.bodyFields}));
      checkpoint(report, options.report);
      if (forbidden.length > 0 || report.network.sourceLikeRequests.length > 0) {
        throw new Error('browser replay attempted a forbidden Judge/submission/source upload request');
      }
    } finally {
      try { await chrome?.context?.close(); } catch (_) { /* cleanup */ }
      try { await chrome?.browser?.close(); } catch (_) { /* cleanup */ }
      try { await chrome?.server?.close(); } catch (_) { /* cleanup */ }
      await app.stop();
    }
  } finally {
    for (const bundle of bundles) rmSync(bundle.extractedRoot, {recursive: true, force: true});
  }
  console.log(JSON.stringify({report: options.report, summary: report.summary}, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const requestStop = signal => {
    if (stopRequested) {
      console.error(`[contest-replay] received ${signal} again; forcing exit`);
      process.exit(130);
    }
    stopRequested = true;
    console.error(`[contest-replay] received ${signal}; stopping after the current browser case and cleaning up`);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  main().catch(error => {
    console.error(`[contest-replay] ${error.stack || error.message || error}`);
    process.exitCode = 1;
  });
}
