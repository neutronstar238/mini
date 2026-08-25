import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const v1Evidence = read('compat-tests/modern-cpp/results/modern-runtime-evidence.json');
const v2Evidence = read('compat-tests/modern-cpp/results/modern-runtime-v2-evidence.json');
const optimization = read('compat-tests/modern-cpp/results/modern-cpp-optimization.json');
const c17 = read('compat-tests/c17/c17-compatibility-matrix.json');
const cpp17 = read('compat-tests/cpp17/cpp17-compatibility-matrix.json');
const e2e = read('compat-tests/modern-cpp/results/modern-cpp-e2e.json');
const network = read('compat-tests/modern-cpp/results/modern-cpp-network.json');
const performance = read('compat-tests/modern-cpp/results/modern-cpp-performance.json');
const require = createRequire(import.meta.url);
const profiles = require('../server/src/language-profiles.js');
const cProfile = profiles.sanitizedPublicProfile('c17');
const cppProfile = profiles.sanitizedPublicProfile('cpp17');
const cCompiler = cProfile.officialJudge.compileFlags[0];
const cppCompiler = cppProfile.officialJudge.compileFlags[0];
const formalSubmit = {
  productionEnabled: cProfile.submissionEnabled === true || cppProfile.submissionEnabled === true,
  fallbackCompilerAllowed: cCompiler !== 'gcc-14' || cppCompiler !== 'g++-14',
  c17Compiler: cCompiler,
  cpp17Compiler: cppCompiler
};

function checkMap(entries) { return Object.fromEntries(entries.map(([id, pass, evidence]) => [id, {pass: !!pass, evidence}])); }
function failures(checks) { return Object.entries(checks).filter(([, value]) => !value.pass).map(([id]) => id); }
function cSummary(name) { return c17.summary[name]; }
function cppCategory(name) { return cpp17.corpus.summary.byCategory[name]; }
function browserCategory(name) {
  const rows = (cpp17.browser.results || []).filter(row => row.category === name);
  return {total: rows.length, passed: rows.filter(row => row.pass === true).length};
}

const common = checkMap([
  ['evidenceFix', v1Evidence.evidenceConsistency === 'PASS', v1Evidence.evidenceConsistency],
  ['runtimeV2Evidence', v2Evidence.evidenceConsistency === 'PASS', v2Evidence.evidenceConsistency],
  ['optimizationPolicy', optimization.summary?.status === 'PASS'
    && optimization.summary?.optimizationPolicy === '-O2', optimization.summary],
  ['chromeE2E', e2e.gate?.status === 'PASS', e2e.gate],
  ['networkIsolation', network.policy?.pass === true, network.policy],
  ['reproducibleBuild', v2Evidence.checks?.overlayGeneratorCheck?.status === 'PASS'
    && v2Evidence.checks?.reproducibleBuildField?.status === 'PASS', {
      generator: v2Evidence.checks?.overlayGeneratorCheck?.status,
      manifest: v2Evidence.checks?.reproducibleBuildField?.status
    }],
  ['engineeringRedistributionReady', v2Evidence.redistribution?.ENGINEERING_REDISTRIBUTION_READY === true,
    v2Evidence.redistribution],
  ['largeAssetReuse', performance.largeAssetReuse?.every(item => item.pass), performance.largeAssetReuse]
  ,['formalSubmitDisabled', formalSubmit.productionEnabled === false
    && formalSubmit.fallbackCompilerAllowed === false, formalSubmit]
]);

const c17Checks = checkMap([
  ...Object.entries(common).map(([id, value]) => [id, value.pass, value.evidence]),
  ['positiveCompile', c17.status === 'PASS' && cSummary('positive')?.browserMatchesExpected === cSummary('positive')?.expected,
    cSummary('positive')],
  ['negativeCE', cSummary('negative')?.browserMatchesExpected === cSummary('negative')?.expected, cSummary('negative')],
  ['warningNoCE', cSummary('warnings')?.browserMatchesExpected === cSummary('warnings')?.expected, cSummary('warnings')],
  ['acmMinimum', cSummary('acm-corpus')?.expected >= 30
    && cSummary('acm-corpus')?.browserMatchesExpected === cSummary('acm-corpus')?.expected, cSummary('acm-corpus')],
  ['compatibilityOutput', ['positive', 'acm-corpus', 'negative', 'warnings'].every(name =>
    cSummary(name)?.matrixCompatible === cSummary(name)?.expected), c17.summary],
  ['correctnessOutput', ['positive', 'acm-corpus'].every(name =>
    cSummary(name)?.browserMatchesExpected === cSummary(name)?.expected), c17.summary],
  ['timeout', e2e.modern?.c17?.timeout?.runStatus === 'LOCAL_TIMEOUT'
    && e2e.modern?.c17?.statsAfterTimeout?.ready === true
    && e2e.modern?.c17?.aliveAfterTimeout?.outputMatches === true, e2e.modern?.c17]
]);

const headerProbes = cpp17.browser?.headerMismatchProbes || [];
const cppScoreableTotal = ['feature', 'acm', 'negative', 'warning']
  .reduce((total, name) => total + (cppCategory(name)?.total || 0), 0);
const cpp17Checks = checkMap([
  ...Object.entries(common).map(([id, value]) => [id, value.pass, value.evidence]),
  ['positiveCompile', cpp17.betaGate?.status === 'PASS'
    && cppCategory('feature')?.passed === cppCategory('feature')?.total
    && browserCategory('feature').passed === browserCategory('feature').total, {
      reference: cppCategory('feature'), browser: browserCategory('feature')
    }],
  ['negativeCE', cppCategory('negative')?.passed === cppCategory('negative')?.total
    && browserCategory('negative').passed === browserCategory('negative').total, {
      reference: cppCategory('negative'), browser: browserCategory('negative')
    }],
  ['warningNoCE', cppCategory('warning')?.passed === cppCategory('warning')?.total
    && browserCategory('warning').passed === browserCategory('warning').total, {
      reference: cppCategory('warning'), browser: browserCategory('warning')
    }],
  ['acmMinimum', cppCategory('acm')?.total >= 40 && cppCategory('acm')?.passed === cppCategory('acm')?.total
    && browserCategory('acm').passed === browserCategory('acm').total, {
      reference: cppCategory('acm'), browser: browserCategory('acm')
    }],
  ['bits', cpp17.browser?.bitsNoPchAB?.pass === true, cpp17.browser?.bitsNoPchAB],
  ['pchPolicy', cpp17.pch?.policy === 'DISABLED' && cpp17.pch?.browser?.decision === 'DISABLED', cpp17.pch],
  ['pchNeutrality', cpp17.pch?.policy === 'DISABLED', 'N/A when PCH is disabled'],
  ['headerGuard', headerProbes.length === 10 && headerProbes.every(probe =>
    probe.guardRequired ? probe.guardEnabled === true && probe.guardPass === true : probe.status === 'MATCH'), headerProbes],
  ['compatibilityOutput', cpp17.browser?.summary?.passed === cppScoreableTotal
    && cpp17.browser?.summary?.failed === 0 && cpp17.browser?.summary?.blocked === 0, {
      expected: cppScoreableTotal, browser: cpp17.browser?.summary
    }],
  ['correctnessOutput', ['feature', 'acm'].every(name => browserCategory(name).passed === browserCategory(name).total), {
      feature: browserCategory('feature'), acm: browserCategory('acm')
    }],
  ['timeout', e2e.modern?.cpp17?.timeout?.runStatus === 'LOCAL_TIMEOUT'
    && e2e.modern?.cpp17?.statsAfterTimeout?.ready === true
    && e2e.modern?.cpp17?.aliveAfterTimeout?.outputMatches === true, e2e.modern?.cpp17]
]);

const c17Failures = failures(c17Checks);
const cpp17Failures = failures(cpp17Checks);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  engineRuntimeId: 'cpp-modern-engine-v2',
  optimizationPolicy: optimization.summary.optimizationPolicy,
  profiles: {
    c17: {runtimeId: 'c17-gcc14-compat-v2', checks: c17Checks, blockers: c17Failures,
      status: c17Failures.length ? 'EXPERIMENTAL' : 'BETA', submissionEnabled: false},
    cpp17: {runtimeId: 'cpp17-gcc14-compat-v2', checks: cpp17Checks, blockers: cpp17Failures,
      status: cpp17Failures.length ? 'EXPERIMENTAL' : 'BETA', submissionEnabled: false}
  },
  blockingFailures: [
    ...c17Failures.map(id => 'c17.' + id),
    ...cpp17Failures.map(id => 'cpp17.' + id)
  ],
  formalSubmit,
  status: c17Failures.length === 0 && cpp17Failures.length === 0 ? 'PASS' : 'BLOCKED'
};
const output = join(ROOT, 'compat-tests', 'modern-cpp', 'results', 'modern-cpp-beta-gate.json');
mkdirSync(dirname(output), {recursive: true});
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(`modern-cpp-beta-gate: ${result.status}`);
if (result.status !== 'PASS') {
  console.log(result.blockingFailures.join('\n'));
  process.exitCode = 1;
}
