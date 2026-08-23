import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  acceptedCompatibilityIssues,
  assessExpectedVerdict,
  classifyObservedOutcome,
  executionPlanForSubmission,
  expectedVerdictReproduced,
  normalizeExpectedVerdict,
  profileFor,
  summarize
} from './codeforces-browser-compat.mjs';

test('normalizes Codeforces verdict aliases without accepting unknown verdicts', () => {
  assert.equal(normalizeExpectedVerdict('OK'), 'OK');
  assert.equal(normalizeExpectedVerdict('WRONG_ANSWER'), 'WA');
  assert.equal(normalizeExpectedVerdict('Compilation Error'), 'CE');
  assert.equal(normalizeExpectedVerdict('TIME-LIMIT-EXCEEDED'), 'TLE');
  assert.equal(normalizeExpectedVerdict('MEMORY LIMIT EXCEEDED'), 'MLE');
  assert.equal(normalizeExpectedVerdict('TESTING'), null);
});

test('classifies observed outcomes in failure-first order', () => {
  assert.equal(classifyObservedOutcome({compileFailed: true, timedOut: true}), 'compile_error');
  assert.equal(classifyObservedOutcome({timedOut: true}), 'timeout');
  assert.equal(classifyObservedOutcome({runtimeError: true}), 'runtime_error');
  assert.equal(classifyObservedOutcome({outputMismatch: true}), 'output_mismatch');
  assert.equal(classifyObservedOutcome({allTestsPassed: true}), 'all_pass');
  assert.equal(classifyObservedOutcome({unsupported: true}), 'unsupported');
});

test('expected verdict reproduction is evidence, not a pass/fail gate for WA/TLE/MLE', () => {
  assert.equal(expectedVerdictReproduced('CE', 'compile_error'), true);
  assert.equal(expectedVerdictReproduced('WA', 'all_pass'), false);
  assert.equal(expectedVerdictReproduced('TLE', 'all_pass'), false);

  const mle = assessExpectedVerdict('MLE', 'all_pass');
  assert.equal(mle.comparable, false);
  assert.equal(mle.reproduced, false);
  assert.equal(mle.note, 'memory_limit_is_not_observable_in_browser_runner');

  const rows = [
    {expectedVerdict: 'OK', observedOutcome: 'all_pass'},
    {expectedVerdict: 'WA', observedOutcome: 'all_pass'},
    {expectedVerdict: 'TLE', observedOutcome: 'all_pass'},
    {expectedVerdict: 'MLE', observedOutcome: 'all_pass'}
  ];
  assert.deepEqual(acceptedCompatibilityIssues(rows), []);
  assert.equal(acceptedCompatibilityIssues([
    {expectedVerdict: null, observedOutcome: 'output_mismatch'}
  ]).length, 1);
});

test('CE without public tests still gets one empty-stdin compile probe', () => {
  const plan = executionPlanForSubmission({verdict: 'COMPILATION_ERROR'}, []);
  assert.equal(plan.usesCompileProbe, true);
  assert.equal(plan.tests.length, 1);
  assert.equal(plan.tests[0].syntheticCompileProbe, true);
  assert.equal(plan.tests[0].input, '');
  assert.equal(plan.tests[0].output, '');

  const normal = executionPlanForSubmission({verdict: 'TLE'}, []);
  assert.equal(normal.usesCompileProbe, false);
  assert.deepEqual(normal.tests, []);
});

test('unsupported languages remain observable and summaries work by language/verdict', () => {
  assert.equal(profileFor('GNU C'), 'c');
  assert.equal(profileFor('GNU C11'), 'c');
  assert.equal(profileFor('GNU C++17'), 'cpp17');
  const rows = [
    {originalLanguage: 'GNU C', expectedVerdict: 'OK', observedOutcome: 'unsupported',
      compiled: false, allTestsPassed: false, compileFailed: false, timedOut: false,
      runtimeError: false, outputMismatch: false, expectedVerdictReproduced: false,
      expectedVerdictComparable: true},
    {originalLanguage: 'GNU C++', expectedVerdict: 'WA', observedOutcome: 'all_pass',
      compiled: true, allTestsPassed: true, compileFailed: false, timedOut: false,
      runtimeError: false, outputMismatch: false, expectedVerdictReproduced: false,
      expectedVerdictComparable: true}
  ];
  const byLanguage = summarize(rows, 'originalLanguage');
  const byVerdict = summarize(rows, 'expectedVerdict');
  assert.equal(byLanguage['GNU C'].submissions, 1);
  assert.equal(byLanguage['GNU C'].observedOutcomes.unsupported, 1);
  assert.equal(byVerdict.WA.expectedVerdictNotReproduced, 1);
});

test('network isolation and executable main guard remain in the replay harness', () => {
  const source = readFileSync(new URL('./codeforces-browser-compat.mjs', import.meta.url), 'utf8');
  assert.match(source, /Only same-origin GET requests for \/runtime, \/js\/contest and \/js\/runno/);
  assert.match(source, /route\.abort\('blockedbyclient'\)/);
  assert.match(source, /if \(process\.argv\[1\] && resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/);
});
