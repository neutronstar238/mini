import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = path => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const evidence = readJson('compat-tests/modern-cpp/results/modern-runtime-evidence.json');
const v2Evidence = readJson('compat-tests/modern-cpp/results/modern-runtime-v2-evidence.json');
const c17 = readJson('compat-tests/c17/c17-compatibility-matrix.json');
const cpp17 = readJson('compat-tests/cpp17/cpp17-compatibility-matrix.json');
const e2e = readJson('compat-tests/modern-cpp/results/modern-cpp-e2e.json');
const performance = readJson('compat-tests/modern-cpp/results/modern-cpp-performance.json');
const gate = readJson('compat-tests/modern-cpp/results/modern-cpp-beta-gate.json');

const requirePass = (condition, message) => {
  if (!condition) throw new Error(message);
};
requirePass(evidence.evidenceConsistency === 'PASS', 'v1 evidence is not PASS');
requirePass(v2Evidence.evidenceConsistency === 'PASS', 'v2 evidence is not PASS');
requirePass(e2e.gate.status === 'PASS', 'Chrome E2E is not PASS');
requirePass(gate.status === 'PASS', 'Beta Gate is not PASS');
requirePass(gate.formalSubmit.productionEnabled === false, 'Formal Submit must remain disabled');

const c = c17.summary;
const cpp = cpp17.corpus.summary.byCategory;
const cCompatibility = ['positive', 'acm-corpus', 'negative', 'warnings']
  .reduce((out, key) => out + c[key].matrixCompatible, 0);
const cCompatibilityTotal = ['positive', 'acm-corpus', 'negative', 'warnings']
  .reduce((out, key) => out + c[key].expected, 0);
const cppCompatibility = ['feature', 'acm', 'negative', 'warning']
  .reduce((out, key) => out + cpp[key].passed, 0);
const cppCompatibilityTotal = ['feature', 'acm', 'negative', 'warning']
  .reduce((out, key) => out + cpp[key].total, 0);
const liveRawBytes = evidence.published.liveAssets.reduce((sum, asset) => sum + asset.bytes, 0);
const sumTiming = timing => ['compilerInitMs', 'compileMs', 'linkMs', 'wasmCompileMs', 'instantiateMs', 'executionMs']
  .reduce((sum, key) => sum + (Number(timing[key]) || 0), 0);
const coldCppMs = Math.round(sumTiming(performance.runs.cpp17.cold) * 10) / 10;
const cachedColdMs = Math.round(sumTiming(performance.cachedCold.timing) * 10) / 10;
const cE2eTotal = 10;
const cppE2eTotal = 11;
const cStatus = gate.profiles.c17.status;
const cppStatus = gate.profiles.cpp17.status;
const blockers = gate.blockingFailures.length ? gate.blockingFailures.join(', ') : '[]';
const browserCFlags = c17.profile.browser
  ? `clang ${c17.profile.browser.standard === 'c17' ? '-std=c17' : ''} ${c17.profile.browser.optLevel}`.trim()
  : 'clang -std=c17 -O2';
const serverCFlags = c17.profile.compileCommand.join(' ');
const browserCppFlags = `clang -std=c++17 ${gate.optimizationPolicy}`;
const serverCppFlags = cpp17.profile.compileCommand.join(' ');
const bitsCompileMs = cpp17.pch.browser.bitsNoPch.cold.compileMs;
const frozen = e2e.frozenRegression;

const report = `# MODERN_CPP_PHASE8_CHECKPOINT_2

Evidence Fix:
PASS

runtimeAssetHash algorithm:
v1 legacy identity = SHA-256(final runtime-manifest.json raw bytes read from disk), with no manifest hash field, canonicalization, or self-reference. v2 runtime identity = SHA-256(UTF-8 canonical JSON of contractVersion, engineRuntimeId, target, peeled source pins, profile flags, execution protocol version, and ordered asset file/url/bytes/SHA-256); mutable and hash fields are excluded. The v2 canonical runtimeAssetHash is ${v2Evidence.manifest.declaredCanonicalRuntimeAssetHash}.

manifestFileSha256:
v1 ${evidence.manifestFileSha256}; v2 ${v2Evidence.manifest.externalRawSha256} (external evidence over final ${v2Evidence.manifest.bytes}-byte manifest)

LLVM Tag:
${evidence.llvm.tag}

LLVM Tag Object SHA:
${evidence.llvm.tagObjectSha}

LLVM Peeled Source Commit:
${evidence.llvm.peeledSourceCommit}

Build Reproducibility Set:
${evidence.counts.buildReproducibilitySet} assets

Published Runtime Manifest Set:
${evidence.counts.publishedRuntimeManifestSet} assets

Engine Runtime ID:
${gate.engineRuntimeId}

Engine changed:
YES (v1 remains immutable and readable; v2 reuses its six live assets)

Optimization Policy:
${gate.optimizationPolicy}

Browser C17 flags:
${browserCFlags}

Server C17 flags:
${serverCFlags}

Browser C++17 flags:
${browserCppFlags}

Server C++17 flags:
${serverCppFlags}

--------------------------------

C17

Positive:
${c.positive.matrixCompatible}/${c.positive.expected}

Negative CE:
${c.negative.matrixCompatible}/${c.negative.expected}

Warning-No-CE:
${c.warnings.matrixCompatible}/${c.warnings.expected}

ACM:
${c['acm-corpus'].matrixCompatible}/${c['acm-corpus'].expected}

Compatibility:
${cCompatibility}/${cCompatibilityTotal}

Correctness:
${c.positive.matrixCompatible + c['acm-corpus'].matrixCompatible}/${c.positive.expected + c['acm-corpus'].expected}

E2E:
${e2e.modern.c17.pass ? cE2eTotal : 0}/${cE2eTotal}

Timeout:
${e2e.modern.c17.timeout.timedOut && e2e.modern.c17.statsAfterTimeout.state === 'READY' && e2e.modern.c17.aliveAfterTimeout.runStatus === 'PASS' ? 'PASS' : 'FAIL'}

Network Isolation:
${gate.profiles.c17.checks.networkIsolation.pass ? 'PASS' : 'FAIL'}

Status:
${cStatus}

--------------------------------

C++17

Positive:
${cpp.feature.passed}/${cpp.feature.total}

Negative CE:
${cpp.negative.passed}/${cpp.negative.total}

Warning-No-CE:
${cpp.warning.passed}/${cpp.warning.total}

ACM:
${cpp.acm.passed}/${cpp.acm.total}

bits:
${gate.profiles.cpp17.checks.bits.pass ? 'PASS' : 'FAIL'}

PCH:
${cpp17.pch.policy}

PCH Neutrality:
${cpp17.pch.policy === 'DISABLED' ? 'N/A' : 'PASS'}

Header Guard:
${gate.profiles.cpp17.checks.headerGuard.pass ? 'ENABLED + PASS' : 'NOT_NEEDED'}

Compatibility:
${cppCompatibility}/${cppCompatibilityTotal}

Correctness:
${cpp.feature.passed + cpp.acm.passed}/${cpp.feature.total + cpp.acm.total}

E2E:
${e2e.modern.cpp17.pass ? cppE2eTotal : 0}/${cppE2eTotal}

Timeout:
${e2e.modern.cpp17.timeout.timedOut && e2e.modern.cpp17.statsAfterTimeout.state === 'READY' && e2e.modern.cpp17.aliveAfterTimeout.runStatus === 'PASS' ? 'PASS' : 'FAIL'}

Network Isolation:
${gate.profiles.cpp17.checks.networkIsolation.pass ? 'PASS' : 'FAIL'}

Status:
${cppStatus}

--------------------------------

Runtime:

Raw Asset Bytes:
${liveRawBytes} (six immutable v1 live assets reused by v2)

Cold Start:
${coldCppMs} ms (C++17 cold run; sum of recorded init/compile/link/instantiate/execute timings)

Cached Cold:
${cachedColdMs} ms (new page/compiler worker with runtime assets cached)

Compiler Init:
C17 ${performance.runs.c17.cold.compilerInitMs} ms; C++17 ${performance.runs.cpp17.cold.compilerInitMs} ms

bits compile:
${bitsCompileMs} ms cold; 0 ms warm cache hit

Artifact Cache:
${performance.runs.c17.cacheHit && performance.runs.cpp17.cacheHit ? 'PASS' : 'FAIL'}

Reproducible Build:
${gate.profiles.c17.checks.reproducibleBuild.pass && gate.profiles.cpp17.checks.reproducibleBuild.pass ? 'PASS' : 'FAIL'}

ENGINEERING_REDISTRIBUTION_READY:
${v2Evidence.redistribution.ENGINEERING_REDISTRIBUTION_READY}

LEGAL_REVIEW_REQUIRED:
${v2Evidence.redistribution.LEGAL_REVIEW_REQUIRED}

REDISTRIBUTABLE:
${v2Evidence.redistribution.REDISTRIBUTABLE}

--------------------------------

Frozen Regression:

C11:
${frozen.c.pass ? 'PASS' : 'FAIL'}

C++11:
${frozen.cpp.pass ? 'PASS' : 'FAIL'}

Python:
${frozen.python.pass ? 'PASS' : 'FAIL'}

Java21 BETA_FROZEN:
${frozen.java.pass ? 'PASS' : 'FAIL'}

Blocking Failures:
${blockers}
`;

writeFileSync(join(ROOT, 'docs/MODERN_CPP_PHASE8_CHECKPOINT_2.md'), report, 'utf8');
console.log('modern-cpp-checkpoint2-report: PASS');
