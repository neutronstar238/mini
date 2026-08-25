import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  expectedFailureReproduced,
  problemIsInteractive,
  requestIsForbidden,
  tokenOutputMatches
} from './contest-archive-browser-compat.mjs';

const FOUR_MIB = 4 * 1024 * 1024;
const ONE_MIB = 1024 * 1024;
const archiveScriptPath = fileURLToPath(new URL('./contest-archive-browser-compat.mjs', import.meta.url));
let archiveTestModule;

async function loadArchiveTestModule() {
  if (archiveTestModule) return archiveTestModule;

  const source = readFileSync(archiveScriptPath, 'utf8');
  const harnessImport = /import \{\s*attachRequestLog,\s*browserVersion,\s*launchChrome,\s*loginAndOpenProblem,\s*nowIso,\s*startLocalContestServer\s*\} from '..\/..\/compat-tests\/java21\/e2e\/harness\.mjs';/;
  assert.match(source, harnessImport, 'archive replay harness import must remain recognizable');

  const testRoot = mkdtempSync(join(tmpdir(), 'contest-archive-test-module-'));
  const testModulePath = join(testRoot, 'contest-archive-browser-compat.mjs');
  const testHarness = `
const attachRequestLog = () => ({entries: []});
const browserVersion = async () => 'test-browser';
const launchChrome = async () => ({
  context: {route: async () => {}, close: async () => {}},
  page: {on() {}, waitForFunction: async () => {}},
  browser: {close: async () => {}},
  server: {close: async () => {}}
});
const loginAndOpenProblem = async () => {};
const nowIso = () => '2026-08-25T00:00:00.000Z';
const startLocalContestServer = async () => ({
  baseUrl: 'http://contest-archive-test.invalid',
  stop: async () => {}
});
`;
  const testStubs = `
function extractProblemBundle() {
  return globalThis.__contestArchiveTestBundle;
}

async function browserRun() {
  const result = globalThis.__contestArchiveTestRuns?.shift();
  if (!result) throw new Error('test browser result queue exhausted');
  return result;
}

export {classifyCoverage, main, prepareResumedReport};
`;
  const transformed = source
    .replace(harnessImport, testHarness)
    .replace('function extractProblemBundle(archiveRoot) {', 'function extractProblemBundleOriginal(archiveRoot) {')
    .replace('async function browserRun(page, payload, timeoutMs) {', 'async function browserRunOriginal(page, payload, timeoutMs) {')
    .replace('const invokedPath =', `${testStubs}\nconst invokedPath =`);
  writeFileSync(testModulePath, transformed, 'utf8');
  try {
    archiveTestModule = await import(`${pathToFileURL(testModulePath).href}?test=${Date.now()}`);
    return archiveTestModule;
  } finally {
    rmSync(testRoot, {recursive: true, force: true});
  }
}

function createArchiveFixture({inputBytes = 0, outputBytes = 0} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'contest-archive-fixture-'));
  const dataRoot = join(root, 'data');
  const sourceRoot = join(root, 'src');
  const extractedRoot = join(root, 'extracted');
  const testRoot = join(extractedRoot, 'TEST_00001');
  mkdirSync(dataRoot, {recursive: true});
  mkdirSync(sourceRoot, {recursive: true});
  mkdirSync(testRoot, {recursive: true});
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({source_contest_id: 1075}));
  writeFileSync(join(dataRoot, 'source_index.json'), JSON.stringify({'1': 'src/1.c'}));
  writeFileSync(join(dataRoot, 'solutions.jsonl'), `${JSON.stringify({
    legacy_solution_id: 1,
    legacy_problem_id: 1,
    problem_export_index: 1,
    team_id: 1,
    language: 0,
    result: 4
  })}\n`);
  writeFileSync(join(sourceRoot, '1.c'), 'int main(void) { return 0; }\n');
  if (inputBytes > 0) writeFileSync(join(testRoot, 'case.in'), Buffer.alloc(inputBytes, 97));
  if (outputBytes > 0) writeFileSync(join(testRoot, 'case.out'), Buffer.alloc(outputBytes, 98));
  return {
    root,
    bundle: {
      extractedRoot,
      problems: [{problem_new_id: 1, problem_id: 101, title: 'A + B', spj: '0'}]
    }
  };
}

async function runArchiveMain(module, fixture, reportPath, {
  resume = false,
  retryCoverage = [],
  runs = []
} = {}) {
  const previousArgv = process.argv;
  globalThis.__contestArchiveTestBundle = fixture.bundle;
  globalThis.__contestArchiveTestRuns = [...runs];
  process.argv = [
    'node',
    'contest-archive-browser-compat.mjs',
    '--archive', fixture.root,
    '--report', reportPath,
    '--languages', 'c',
    ...(resume ? ['--resume'] : []),
    ...(retryCoverage.length > 0 ? ['--retry-coverage', retryCoverage.join(',')] : [])
  ];
  try {
    await module.main();
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } finally {
    process.argv = previousArgv;
    delete globalThis.__contestArchiveTestBundle;
    delete globalThis.__contestArchiveTestRuns;
  }
}

test('contest archive replay detects interactive metadata and text', () => {
  assert.equal(problemIsInteractive({spj: '2'}), true);
  assert.equal(problemIsInteractive({spj: '0', description: '这是一道交互题'}), true);
  assert.equal(problemIsInteractive({spj: '1', description: '普通 Special Judge'}), false);
});

test('standard output comparison follows token-based OJ semantics', () => {
  assert.equal(tokenOutputMatches('1  2\n3', '1\n2 3\n'), true);
  assert.equal(tokenOutputMatches('1 2 4', '1 2 3'), false);
});

test('network guard allows read-only submission status and blocks mutations', () => {
  const url = '/api/contest/contests/test/submissions/me';
  assert.equal(requestIsForbidden('GET', url), false);
  assert.equal(requestIsForbidden('HEAD', url), false);
  assert.equal(requestIsForbidden('POST', url), true);
  assert.equal(requestIsForbidden('DELETE', '/api/judge/jobs/1'), true);
});

test('official failures are compared without inventing an MLE verdict', () => {
  assert.equal(expectedFailureReproduced('CE', {compileStatus: 'CE'}), true);
  assert.equal(expectedFailureReproduced('WA', {outputMatches: false}), true);
  assert.equal(expectedFailureReproduced('TLE', {runStatus: 'LOCAL_TIMEOUT'}), true);
  assert.equal(expectedFailureReproduced('RE', {runStatus: 'RE', exitCode: 1}), true);
  assert.equal(expectedFailureReproduced('RE', {compileStatus: 'CE', runStatus: 'CE', exitCode: 1}), false);
  assert.equal(expectedFailureReproduced('WA', {compileStatus: 'CE', outputMatches: false}), false);
  assert.equal(expectedFailureReproduced('MLE', {runStatus: 'RE', exitCode: 137}), false);
});

test('a local timeout reproduces an official TLE as runtime_covered', async () => {
  const module = await loadArchiveTestModule();
  const row = {
    interactive: false,
    sourceMissing: false,
    testsRun: [{runStatus: 'LOCAL_TIMEOUT', timedOut: true}],
    testsSkipped: [],
    expectedFailureReproduced: true
  };

  assert.equal(expectedFailureReproduced('TLE', row.testsRun[0]), true);
  assert.equal(module.classifyCoverage(row, 'TLE', false), 'runtime_covered');
});

test('unreproduced non-AC verdicts distinguish ordinary and special-judge coverage', async () => {
  const module = await loadArchiveTestModule();
  const row = {
    interactive: false,
    sourceMissing: false,
    testsRun: [{compileStatus: 'PASS', runStatus: 'PASS', outputMatches: true}],
    testsSkipped: [],
    expectedFailureReproduced: false
  };

  assert.equal(module.classifyCoverage(row, 'WA', false), 'official_failure_not_reproduced');
  assert.equal(module.classifyCoverage(row, 'WA', true), 'runtime_covered_special_judge');
  assert.equal(module.classifyCoverage(row, 'CE', false), 'official_failure_not_reproduced');
  assert.equal(module.classifyCoverage({
    ...row,
    testsRun: [{compileStatus: 'CE', runStatus: 'CE'}],
    expectedFailureReproduced: true
  }, 'CE', true), 'covered_expected_ce');
});

test('formal AC runtime failures take precedence over semantic mismatch', async () => {
  const module = await loadArchiveTestModule();
  const row = {
    interactive: false,
    sourceMissing: false,
    testsSkipped: [],
    expectedFailureReproduced: false
  };

  for (const run of [
    {compileStatus: 'PASS', runStatus: 'RE', exitCode: null, outputMatches: false},
    {compileStatus: 'PASS', runStatus: null, exitCode: 1, outputMatches: false}
  ]) {
    assert.equal(module.classifyCoverage({...row, testsRun: [run]}, 'AC', false),
      'compatibility_runtime_failure');
  }
});

test('resume migration recomputes complete legacy rows for new coverage classes', async () => {
  const module = await loadArchiveTestModule();
  const report = {submissions: [{
    key: '1075:1',
    officialVerdict: 'WA',
    interactive: false,
    sourceMissing: false,
    specialJudge: false,
    testsRun: [{compileStatus: 'PASS', runStatus: 'PASS', outputMatches: true}],
    testsSkipped: [],
    expectedFailureReproduced: false,
    coverage: 'runtime_covered'
  }]};

  module.prepareResumedReport(report);

  assert.equal(report.submissions[0].coverage, 'official_failure_not_reproduced');
});

test('retry-coverage reruns and replaces migrated compatibility_runtime_failure rows', async () => {
  const module = await loadArchiveTestModule();
  const fixture = createArchiveFixture();
  const reportPath = join(fixture.root, 'runtime-retry-report.json');
  writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 1,
    createdAt: '2026-08-25T00:00:00.000Z',
    limits: {inputBytes: FOUR_MIB, outputBytes: ONE_MIB},
    mode: 'browser-only-no-judge',
    inventory: [],
    submissions: [{
      key: '1075:1',
      officialVerdict: 'AC',
      interactive: false,
      sourceMissing: false,
      specialJudge: false,
      testsRun: [{
        compileStatus: 'PASS',
        runStatus: 'RE',
        exitCode: 1,
        runtimeError: true,
        outputMatches: false
      }],
      testsSkipped: [],
      expectedFailureReproduced: false,
      coverage: 'semantic_mismatch'
    }],
    network: {forbiddenRequests: [], sourceLikeRequests: []}
  }));

  try {
    const report = await runArchiveMain(module, fixture, reportPath, {
      resume: true,
      retryCoverage: ['compatibility_runtime_failure'],
      runs: [{compileStatus: 'PASS', runStatus: 'PASS', stdout: '', exitCode: 0}]
    });
    const rows = report.submissions.filter(row => row.key === '1075:1');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempt, 2);
    assert.equal(rows[0].coverage, 'covered');
    assert.equal(rows[0].testsRun[0].runStatus, 'PASS');
  } finally {
    rmSync(fixture.root, {recursive: true, force: true});
  }
});

test('metadata-poor environment_gap rows are retried on resume and replaced', async () => {
  const module = await loadArchiveTestModule();
  const fixture = createArchiveFixture();
  const reportPath = join(fixture.root, 'resume-report.json');
  writeFileSync(reportPath, JSON.stringify({
    schemaVersion: 1,
    createdAt: '2026-08-25T00:00:00.000Z',
    limits: {inputBytes: FOUR_MIB, outputBytes: ONE_MIB},
    mode: 'browser-only-no-judge',
    inventory: [],
    submissions: [{
      key: '1075:1',
      coverage: 'environment_gap'
    }],
    network: {forbiddenRequests: [], sourceLikeRequests: []}
  }));

  try {
    const report = await runArchiveMain(module, fixture, reportPath, {
      resume: true,
      runs: [{compileStatus: 'PASS', runStatus: 'PASS', stdout: '', exitCode: 0}]
    });
    const rows = report.submissions.filter(row => row.key === '1075:1');

    assert.equal(rows.length, 1, 'the stale environment_gap must not survive as a duplicate');
    assert.equal(rows[0].coverage, 'covered');
    assert.equal(rows[0].testsRun[0].runStatus, 'PASS', 'the gap must be retried');
  } finally {
    rmSync(fixture.root, {recursive: true, force: true});
  }
});

test('oversized input and expected output remain explicit browser coverage limits', async () => {
  const module = await loadArchiveTestModule();
  const fixture = createArchiveFixture({inputBytes: FOUR_MIB + 1, outputBytes: ONE_MIB + 1});
  const reportPath = join(fixture.root, 'limits-report.json');

  try {
    const report = await runArchiveMain(module, fixture, reportPath, {
      runs: [{compileStatus: 'PASS', runStatus: 'PASS', stdout: '', exitCode: 0}]
    });
    const row = report.submissions[0];
    const reasons = new Set(row.testsSkipped.flatMap(item => item.reasons));

    assert.deepEqual(reasons, new Set(['LOCAL_INPUT_LIMIT', 'LOCAL_OUTPUT_LIMIT']));
    assert.equal(row.coverage, 'partially_covered_io_limits');
    assert.deepEqual(row.testsRun.map(run => run.test), ['compile-probe']);
    assert.equal(row.testsRun[0].runStatus, 'PASS');
    assert.doesNotMatch(JSON.stringify(row), /\b(?:TLE|WA|RE)\b/);
  } finally {
    rmSync(fixture.root, {recursive: true, force: true});
  }
});
