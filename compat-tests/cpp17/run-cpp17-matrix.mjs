#!/usr/bin/env node
'use strict';

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * GCC14 / Browser compatibility matrix driver.
 *
 * The official compile flags are read from server/src/language-profiles.js; this
 * file does not duplicate or mutate server/runtime configuration. The default
 * reference backend is an SSH host named yqzl-server. Browser validation uses
 * the existing real-Chrome E2E launcher by default; incomplete corpus
 * coverage remains a visible beta-gate blocker.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CORPUS_DIR = __dirname;
const ROOT_DIR = path.resolve(CORPUS_DIR, '..', '..');
const MANIFEST_PATH = path.join(CORPUS_DIR, 'matrix-manifest.json');
const REFERENCE_PATH = path.join(CORPUS_DIR, 'reference-cpp17.json');
const MATRIX_PATH = path.join(CORPUS_DIR, 'cpp17-compatibility-matrix.json');
const PROFILE_PATH = path.join(ROOT_DIR, 'server', 'src', 'language-profiles.js');
const BROWSER_PROFILE_ID = 'cpp17-gcc14-compat-v2';
const BITS_AB_SOURCE = [
  '#include <bits/stdc++.h>',
  '#include <iostream>',
  'int main(){long long a,b;if(std::cin>>a>>b)std::cout<<a+b<<"\\n";}'
].join('\n');
const EXPLICIT_AB_SOURCE = [
  '#include <iostream>',
  'int main(){long long a,b;if(std::cin>>a>>b)std::cout<<a+b<<"\\n";}'
].join('\n');
const HEADER_PROBES = Object.freeze([
  {header: 'algorithm', source: '#include <iostream>\n#include <vector>\nint main(){std::vector<int>v{2,1};std::sort(v.begin(),v.end());std::cout<<v[0]<<v[1]<<"\\n";}', expected: '12'},
  {header: 'vector', source: '#include <iostream>\nint main(){std::vector<int>v{1,2,3};std::cout<<v.size()<<"\\n";}', expected: '3'},
  {header: 'string', source: '#include <iostream>\nint main(){std::cout<<std::string("cpp17").size()<<"\\n";}', expected: '5'},
  {header: 'map', source: '#include <iostream>\nint main(){std::map<int,int>m{{1,7}};std::cout<<m.at(1)<<"\\n";}', expected: '7'},
  {header: 'set', source: '#include <iostream>\nint main(){std::set<int>s{1,1,2};std::cout<<s.size()<<"\\n";}', expected: '2'},
  {header: 'numeric', source: '#include <iostream>\nint main(){std::cout<<std::gcd(84,30)<<"\\n";}', expected: '6'},
  {header: 'memory', source: '#include <iostream>\nint main(){auto p=std::make_unique<int>(9);std::cout<<*p<<"\\n";}', expected: '9'},
  {header: 'functional', source: '#include <iostream>\nint main(){std::cout<<std::invoke([](int x){return x+1;},4)<<"\\n";}', expected: '5'},
  {header: 'tuple', source: '#include <iostream>\nint main(){std::tuple<int,int>t{3,8};std::cout<<std::get<1>(t)<<"\\n";}', expected: '8'},
  {header: 'optional', source: '#include <iostream>\nint main(){std::optional<int>x=11;std::cout<<x.value_or(0)<<"\\n";}', expected: '11'}
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const out = {
    sshHost: process.env.CPP17_SSH_HOST || 'yqzl-server',
    browserCommand: process.env.CPP17_BROWSER_HARNESS || '',
    skipRemote: false,
    browserOnly: false,
    maxCases: 0,
    benchmarkSamples: 3,
    timeoutMs: 30000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-remote') out.skipRemote = true;
    else if (arg === '--browser-only') out.browserOnly = true;
    else if (arg === '--ssh-host') out.sshHost = argv[++i];
    else if (arg === '--browser-command') out.browserCommand = argv[++i] || '';
    else if (arg === '--max-cases') out.maxCases = Number(argv[++i] || 0);
    else if (arg === '--benchmark-samples') out.benchmarkSamples = Math.max(1, Number(argv[++i] || 3));
    else if (arg === '--timeout-ms') out.timeoutMs = Math.max(1000, Number(argv[++i] || 30000));
    else if (arg === '--help') {
      console.log([
        'Usage: node run-cpp17-matrix.mjs [options]',
        '  --ssh-host HOST          SSH alias (default: yqzl-server)',
        '  --browser-command CMD    callable Browser harness command',
        '  --skip-remote            emit a truthful BLOCKED reference result',
        '  --browser-only           reuse reference-cpp17.json and run only Browser Chrome cases',
        '  --max-cases N            run only the first N corpus cases',
        '  --benchmark-samples N    no-PCH benchmark sample count',
        '  --timeout-ms N           local SSH process timeout'
      ].join('\n'));
      process.exit(0);
    }
  }
  return out;
}

function loadProfile() {
  // Deliberately require the profile source instead of copying its flags.
  const profileModule = require(PROFILE_PATH);
  const profile = profileModule.PROFILES && profileModule.PROFILES.cpp17;
  if (!profile || !profile.officialJudge) {
    throw new Error('cpp17 officialJudge profile is unavailable');
  }
  const command = profile.officialJudge.compileCommand;
  if (!Array.isArray(command) || command.length < 4) {
    throw new Error('cpp17 official compileCommand is malformed');
  }
  const compiler = command[0];
  const flags = [];
  for (let i = 1; i < command.length; i += 1) {
    const token = command[i];
    if (token === '<src>' || token === '<out>') continue;
    if (token === '-o') {
      i += 1;
      continue;
    }
    flags.push(token);
  }
  return {
    id: profile.id,
    status: profile.status,
    standard: profile.officialJudge.standard,
    compiler,
    flags,
    compileCommand: command.slice(),
    runCommand: profile.officialJudge.runCommand.slice(),
    referenceStatus: profile.officialJudge.referenceStatus,
    compilerVersion: profile.officialJudge.compilerVersion,
    os: profile.officialJudge.os,
    localRuntime: {
      runtimeId: profile.localRuntime.runtimeId,
      pchPolicy: profile.localRuntime.pchPolicy,
      status: profile.localRuntime.status,
      assetHash: profile.localRuntime.assetHash
    }
  };
}

function normalizeOutput(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\s+$/g, '');
}

function decodeBase64(value) {
  if (!value) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

function marker(output, name) {
  const re = new RegExp('^__CPP17_' + name + '=(.*)$', 'm');
  const match = re.exec(output || '');
  return match ? match[1] : null;
}

function remoteScriptFor(source, stdin, compiler, flags) {
  const sourceB64 = Buffer.from(source, 'utf8').toString('base64');
  const inputB64 = Buffer.from(stdin, 'utf8').toString('base64');
  const command = [compiler]
    .concat(flags)
    .concat(['"$d/main.cpp"', '-o', '"$d/main"'])
    .join(' ');
  return [
    'set -eu',
    'd=$(mktemp -d /tmp/mini-cpp17.XXXXXX)',
    'trap \u0027rm -rf "$d"\u0027 EXIT',
    'printf %s ' + sourceB64 + ' | base64 -d > "$d/main.cpp"',
    'printf %s ' + inputB64 + ' | base64 -d > "$d/input"',
    'set +e',
    't0=$(date +%s%N)',
    command + ' 2>"$d/compile.err"',
    'compile_rc=$?',
    't1=$(date +%s%N)',
    'printf "__CPP17_COMPILE_RC=%s\\n" "$compile_rc"',
    'printf "__CPP17_COMPILE_MS=%s\\n" "$(( (t1 - t0) / 1000000 ))"',
    'printf "__CPP17_COMPILE_ERR_B64="; base64 -w0 "$d/compile.err"; printf "\\n"',
    'if [ "$compile_rc" -ne 0 ]; then exit 0; fi',
    't2=$(date +%s%N)',
    'timeout --signal=KILL 10s "$d/main" <"$d/input" >"$d/run.out" 2>"$d/run.err"',
    'run_rc=$?',
    't3=$(date +%s%N)',
    'printf "__CPP17_RUN_RC=%s\\n" "$run_rc"',
    'printf "__CPP17_RUN_MS=%s\\n" "$(( (t3 - t2) / 1000000 ))"',
    'printf "__CPP17_RUN_OUT_B64="; base64 -w0 "$d/run.out"; printf "\\n"',
    'printf "__CPP17_RUN_ERR_B64="; base64 -w0 "$d/run.err"; printf "\\n"',
    'exit 0'
  ].join('\n');
}

function runSsh(host, remoteCommand, timeoutMs) {
  const result = childProcess.spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCommand],
    { cwd: ROOT_DIR, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }
  );
  return {
    status: result.status,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function runReferenceSource(options, source, stdin, extraFlags) {
  const flags = options.profile.flags.concat(extraFlags || []);
  const command = remoteScriptFor(source, stdin, options.profile.compiler, flags);
  let ssh = runSsh(options.sshHost, command, options.timeoutMs);
  // A long corpus opens many short SSH sessions; transient connection drops
  // are retried so the reference reflects GCC14, not transport flakiness.
  for (let attempt = 1; attempt < 3 && !marker(ssh.stdout, 'COMPILE_RC'); attempt += 1) {
    if (attempt > 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    ssh = runSsh(options.sshHost, command, options.timeoutMs);
  }
  const compileRc = marker(ssh.stdout, 'COMPILE_RC');
  if (compileRc === null) {
    return {
      status: 'BLOCKED',
      transportError: ssh.error || ssh.stderr.trim() || 'SSH/GCC14 probe returned no result markers',
      sshStatus: ssh.status,
      sshSignal: ssh.signal,
      stdout: ssh.stdout,
      stderr: ssh.stderr
    };
  }
  const compileMs = Number(marker(ssh.stdout, 'COMPILE_MS') || 0);
  const compileStderr = decodeBase64(marker(ssh.stdout, 'COMPILE_ERR_B64'));
  const compileOk = Number(compileRc) === 0;
  if (!compileOk) {
    return {
      status: 'COMPILE_ERROR',
      compileOk: false,
      compileRc: Number(compileRc),
      compileMs,
      compileStderr
    };
  }
  const runRc = Number(marker(ssh.stdout, 'RUN_RC') || 0);
  return {
    status: runRc === 0 ? 'PASS' : 'RUNTIME_ERROR',
    compileOk: true,
    compileRc: 0,
    compileMs,
    compileStderr,
    runOk: runRc === 0,
    runRc,
    runMs: Number(marker(ssh.stdout, 'RUN_MS') || 0),
    stdout: decodeBase64(marker(ssh.stdout, 'RUN_OUT_B64')),
    stderr: decodeBase64(marker(ssh.stdout, 'RUN_ERR_B64'))
  };
}

function caseResult(options, testCase) {
  const sourcePath = path.join(CORPUS_DIR, testCase.source);
  const inputPath = path.join(CORPUS_DIR, testCase.input);
  const expectedPath = path.join(CORPUS_DIR, testCase.expected);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const stdin = fs.readFileSync(inputPath, 'utf8');
  const expected = fs.readFileSync(expectedPath, 'utf8');
  const probe = runReferenceSource(options, source, stdin, testCase.extraFlags);
  const result = {
    id: testCase.id,
    category: testCase.category,
    source: testCase.source,
    input: testCase.input,
    expected: testCase.expected,
    expectation: testCase.expectation,
    scoreable: testCase.scoreable,
    extraFlags: testCase.extraFlags,
    ...probe
  };
  if (probe.status === 'BLOCKED') return result;
  if (testCase.expectation === 'compile') {
    result.pass = probe.compileOk === false;
    result.assertion = 'compile must fail';
  } else if (testCase.expectation === 'ub') {
    result.pass = probe.compileOk === true;
    result.assertion = 'compile is recorded; runtime is implementation-sensitive';
    result.scoreable = false;
    result.status = probe.compileOk ? 'REPORTED' : probe.status;
  } else {
    const outputMatches = probe.runOk === true &&
      normalizeOutput(probe.stdout) === normalizeOutput(expected);
    result.warningCount = testCase.category === 'warning'
      ? ((probe.compileStderr.match(/warning:/g) || []).length)
      : 0;
    result.pass = outputMatches &&
      (testCase.category !== 'warning' || result.warningCount > 0);
    result.assertion = testCase.category === 'warning'
      ? 'run output matches and -Wall/-Wextra emits a warning'
      : 'compile, run, and normalized output match';
  }
  return result;
}

function runHeaderMismatchProbes(options) {
  return HEADER_PROBES.map((probe) => {
    const gcc = options.skipRemote
      ? {status: 'BLOCKED', reason: '--skip-remote requested'}
      : runReferenceSource(options, probe.source, '', []);
    const gccPass = gcc.status === 'PASS'
      && gcc.runOk === true
      && normalizeOutput(gcc.stdout) === normalizeOutput(probe.expected);
    return {
      id: 'header-' + probe.header,
      header: probe.header,
      omittedHeader: probe.header,
      expected: probe.expected,
      gcc14: {
        status: gcc.status,
        pass: gccPass,
        compileMs: gcc.compileMs || null,
        runMs: gcc.runMs || null,
        compileStderr: gcc.compileStderr || ''
      }
    };
  });
}

function readBitsHeaderReference() {
  const file = path.join(CORPUS_DIR, 'bits', 'gcc14-reference-headers.json');
  if (!fs.existsSync(file)) return {file: 'bits/gcc14-reference-headers.json', status: 'BLOCKED'};
  const evidence = readJson(file);
  return {
    file: 'bits/gcc14-reference-headers.json',
    status: evidence.status || 'UNKNOWN',
    compilerVersion: evidence.compilerVersion || null,
    command: evidence.command || null,
    nativeBits: {
      path: evidence.nativeBits?.path || null,
      sha256: evidence.nativeBits?.sha256 || null,
      transitiveHeaderCount: evidence.nativeBits?.transitiveHeaderCount || null
    },
    modernShim: {
      path: evidence.modernShim?.path || null,
      sha256: evidence.modernShim?.sha256 || null,
      headerCount: evidence.modernShim?.headerCount || null
    }
  };
}

function runBitsAndPchProbes(options) {
  const shimPath = path.join(CORPUS_DIR, 'bits', 'include', 'bits', 'stdc++.h');
  const shimSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(shimPath))
    .digest('hex');
  const bitsSource = [
    '#include <bits/stdc++.h>',
    '#include <iostream>',
    'int main(){std::vector<int> v{2,4,6};',
    'std::cout << std::accumulate(v.begin(),v.end(),0) << "\\n";}'
  ].join('\n');
  const header = options.skipRemote
    ? { status: 'BLOCKED', reason: '--skip-remote requested' }
    : runReferenceSource(options, bitsSource, '', []);
  const bitsAPlusB = options.skipRemote
    ? { status: 'BLOCKED', reason: '--skip-remote requested' }
    : runReferenceSource(options, BITS_AB_SOURCE, '3 5', []);
  const samples = [];
  if (!options.skipRemote) {
    for (let i = 0; i < options.benchmarkSamples; i += 1) {
      const sample = runReferenceSource(options, BITS_AB_SOURCE, '3 5', []);
      samples.push({
        sample: i + 1,
        status: sample.status,
        compileMs: sample.compileMs || null,
        runMs: sample.runMs || null,
        output: normalizeOutput(sample.stdout)
      });
    }
  }
  return {
    shim: {
      path: 'bits/include/bits/stdc++.h',
      sha256: shimSha256,
      policy: 'explicit opt-in include path; no global runtime mutation',
      gcc14ReferenceHeaders: readBitsHeaderReference()
    },
    gcc14NativeHeaderProbe: {
      source: 'generated probe: #include <bits/stdc++.h>',
      expectedOutput: '12',
      ...header
    },
    bitsAPlusB: {
      source: 'generated probe: #include <bits/stdc++.h> A+B',
      stdin: '3 5',
      expectedOutput: '8',
      pchPolicy: 'DISABLED',
      ...bitsAPlusB
    },
    pchDecision: {
      policy: 'DISABLED',
      decision: 'PCH_DISABLED',
      benchmark: {
        samples,
        sampleCount: samples.length,
        metric: 'remote compiler wall time (ms), no PCH',
        candidate: 'bits/stdc++.h A+B',
        pchArtifactBuilt: false
      },
      rationale: [
        'The v2 Browser profile declares pchPolicy=none and publishes no PCH artifact.',
        'Keep PCH disabled until a separate cache/artifact contract is approved.'
      ]
    },
    headerMismatch: runHeaderMismatchProbes(options)
  };
}

async function runChromeCorpusHarness(options, cases) {
  const harnessPath = path.join(ROOT_DIR, 'compat-tests', 'java21', 'e2e', 'harness.mjs');
  const harness = await import(pathToFileURL(harnessPath).href);
  const selected = cases.filter((testCase) =>
    testCase.category === 'feature' ||
    testCase.category === 'acm' ||
    testCase.category === 'negative' ||
    testCase.category === 'warning');
  const skipped = cases.filter((testCase) => !selected.includes(testCase));
  const app = process.env.BASE_URL
    ? {baseUrl: process.env.BASE_URL, async stop() {}}
    : await harness.startLocalContestServer({startTimeoutMs: 30000});
  let chrome = null;
  try {
    chrome = await harness.launchChrome();
    const page = chrome.page;
    const requests = harness.attachRequestLog(page);
    const start = await harness.loginAndOpenProblem(page, app.baseUrl);
    await page.waitForFunction(
      () => globalThis.__IDE_RUNNER__ && typeof globalThis.__IDE_RUNNER__.runCode === 'function',
      null,
      {timeout: 30000}
    );
    const results = [];
    for (const testCase of selected) {
      const source = fs.readFileSync(path.join(CORPUS_DIR, testCase.source), 'utf8');
      const stdin = fs.readFileSync(path.join(CORPUS_DIR, testCase.input), 'utf8');
      const expected = fs.readFileSync(path.join(CORPUS_DIR, testCase.expected), 'utf8');
      const browserResult = await page.evaluate(async ({source, stdin, timeoutMs}) => {
        const runner = globalThis.__IDE_RUNNER__;
        const timeout = new Promise(resolve => setTimeout(() => resolve({
          compileStatus: 'HARNESS_TIMEOUT',
          runStatus: 'HARNESS_TIMEOUT',
          stdout: '',
          stderr: '',
          timedOut: true
        }), timeoutMs));
        return Promise.race([runner.runCode({
          language: 'cpp17',
          profileId: 'cpp17-gcc14-compat-v2',
          standard: 'c++17',
          source,
          stdin,
          optLevel: '-O2'
        }), timeout]);
      }, {source, stdin, timeoutMs: Number(process.env.MODERN_CPP_RUN_TIMEOUT_MS || 90000)});
      const compileError = browserResult?.compileStatus === 'CE';
      const blocked = ['NOT_READY', 'UNAVAILABLE', 'PENDING', 'HARNESS_TIMEOUT'].includes(browserResult?.compileStatus)
        || ['UNAVAILABLE', 'HARNESS_TIMEOUT'].includes(browserResult?.runStatus);
      const outputMatches = normalizeOutput(browserResult?.stdout) === normalizeOutput(expected);
      const pass = testCase.expectation === 'compile'
        ? !blocked && (compileError || browserResult?.runStatus !== 'PASS')
        : !blocked && browserResult?.compileStatus === 'PASS'
          && browserResult?.runStatus === 'PASS' && outputMatches;
      results.push({
        id: testCase.id,
        category: testCase.category,
        compileStatus: browserResult?.compileStatus || null,
        runStatus: browserResult?.runStatus || null,
        pass,
        outputMatches,
        stdout: browserResult?.stdout || '',
        stderr: browserResult?.stderr || '',
        timing: browserResult?.timing || null
      });
    }
    const runProbe = async (source, stdin) => page.evaluate(async ({source, stdin, timeoutMs}) => {
      const runner = globalThis.__IDE_RUNNER__;
      const timeout = new Promise(resolve => setTimeout(() => resolve({
        compileStatus: 'HARNESS_TIMEOUT', runStatus: 'HARNESS_TIMEOUT', stdout: '', stderr: '', timedOut: true
      }), timeoutMs));
      return Promise.race([runner.runCode({
        language: 'cpp17', profileId: 'cpp17-gcc14-compat-v2', standard: 'c++17',
        source, stdin, optLevel: '-O2'
      }), timeout]);
    }, {source, stdin, timeoutMs: Number(process.env.MODERN_CPP_RUN_TIMEOUT_MS || 90000)});
    const bitsRaw = await runProbe(BITS_AB_SOURCE, '3 5');
    const bitsPass = bitsRaw?.compileStatus === 'PASS'
      && bitsRaw?.runStatus === 'PASS'
      && normalizeOutput(bitsRaw?.stdout) === '8';
    const referenceHeaders = options.headerMismatchReference || [];
    const headerMismatchProbes = [];
    for (const probe of HEADER_PROBES) {
      const raw = await runProbe(probe.source, '');
      const browserPass = raw?.compileStatus === 'PASS'
        && raw?.runStatus === 'PASS'
        && normalizeOutput(raw?.stdout) === normalizeOutput(probe.expected);
      const gcc = referenceHeaders.find(item => item.header === probe.header)?.gcc14 || null;
      const guardMissing = raw?.headerGuard?.missing;
      const guardMissingHeader = Array.isArray(guardMissing)
        ? guardMissing.some(item => String(item?.header || '').toLowerCase() === probe.header)
        : (guardMissing == null || String(guardMissing).toLowerCase() === probe.header);
      const guardEvidence = raw?.compileStatus === 'CE'
        && raw?.runStatus === 'CE'
        && raw?.stage === 'gcc14-header'
        && raw?.headerGuard?.policy === 'proven-mismatch-v1'
        && String(raw?.stderr || '').startsWith('Local GCC14 compatibility CE:')
        && guardMissingHeader;
      const guardRequired = guardEvidence || (browserPass && gcc?.status === 'COMPILE_ERROR');
      const guardDecision = guardEvidence ? 'ENABLED+PASS' : 'NOT_NEEDED';
      const status = guardEvidence ? 'GUARDED'
        : gcc?.pass === browserPass ? 'MATCH' : (gcc ? 'MISMATCH' : 'UNVERIFIED');
      headerMismatchProbes.push({
        id: 'header-' + probe.header,
        header: probe.header,
        omittedHeader: probe.header,
        expected: probe.expected,
        browser: {
          status: raw?.compileStatus || null,
          runStatus: raw?.runStatus || null,
          pass: browserPass,
          stdout: raw?.stdout || '',
          stderr: raw?.stderr || '',
          timing: raw?.timing || null
        },
        gcc14: gcc,
        guardRequired,
        guardDecision,
        guardEnabled: guardEvidence,
        guardPass: guardEvidence ? true : !guardRequired,
        status
      });
    }
    const bitsBenchmarkSource = BITS_AB_SOURCE + '\n// cpp17-v2-bits-nopch-cold-warm';
    const explicitBenchmarkSource = EXPLICIT_AB_SOURCE + '\n// cpp17-v2-explicit-cold-warm';
    const bitsCold = await runProbe(bitsBenchmarkSource, '3 5');
    const bitsWarm = await runProbe(bitsBenchmarkSource, '3 5');
    const explicitCold = await runProbe(explicitBenchmarkSource, '3 5');
    const explicitWarm = await runProbe(explicitBenchmarkSource, '3 5');
    const timingOf = raw => ({
      compileMs: raw?.timing?.compileMs ?? raw?.compileTime ?? null,
      linkMs: raw?.timing?.linkMs ?? raw?.linkTime ?? null,
      totalMs: raw?.timing?.totalMs ?? null,
      cacheHit: raw?.timing?.cacheHit ?? raw?.cacheHit ?? null,
      compileStatus: raw?.compileStatus || null,
      runStatus: raw?.runStatus || null,
      stdout: raw?.stdout || '',
      stderr: raw?.stderr || ''
    });
    const bitsColdTiming = timingOf(bitsCold);
    const explicitColdTiming = timingOf(explicitCold);
    const bitsCompileMs = Number(bitsColdTiming.compileMs);
    const explicitCompileMs = Number(explicitColdTiming.compileMs);
    const overheadRatio = Number.isFinite(bitsCompileMs) && Number.isFinite(explicitCompileMs)
      && explicitCompileMs > 0 ? (bitsCompileMs - explicitCompileMs) / explicitCompileMs : null;
    const threshold = {
      compileMs: 500,
      aggregateOverheadRatio: 0.25,
      minimumPchBenefitRatio: 0.30
    };
    const thresholdTriggered = Number.isFinite(bitsCompileMs)
      && bitsCompileMs >= threshold.compileMs
      && overheadRatio != null && overheadRatio >= threshold.aggregateOverheadRatio;
    const bitsPerformance = {
      profileId: BROWSER_PROFILE_ID,
      pchPolicy: 'DISABLED',
      bitsNoPch: {cold: bitsColdTiming, warm: timingOf(bitsWarm)},
      explicitIncludes: {cold: explicitColdTiming, warm: timingOf(explicitWarm)},
      thresholds: threshold,
      observed: {
        coldCompileOverheadRatio: overheadRatio,
        thresholdTriggered,
        pchBenefitMeasured: false
      },
      decision: 'DISABLED',
      decisionReason: 'No Browser PCH artifact is published; retain DISABLED even when the cold/warm threshold is triggered.'
    };
    requests.detach();
    const blockedCount = results.filter(result => ['NOT_READY', 'UNAVAILABLE', 'PENDING', 'HARNESS_TIMEOUT'].includes(result.compileStatus)
      || ['UNAVAILABLE', 'HARNESS_TIMEOUT'].includes(result.runStatus)).length;
    const failed = results.filter(result => result.pass !== true);
    const headerBlocked = headerMismatchProbes.filter(result => result.status === 'UNVERIFIED').length;
    const headerFailed = headerMismatchProbes.filter(result => result.status === 'MISMATCH').length;
    const bitsBlocked = ['NOT_READY', 'UNAVAILABLE', 'PENDING', 'HARNESS_TIMEOUT'].includes(bitsRaw?.compileStatus)
      || ['UNAVAILABLE', 'HARNESS_TIMEOUT'].includes(bitsRaw?.runStatus);
    return {
      status: (blockedCount + headerBlocked + (bitsBlocked ? 1 : 0)) > 0
        && failed.length + headerFailed === 0 ? 'BLOCKED'
        : (failed.length + headerFailed || !bitsPass ? 'FAIL' : 'PASS'),
      mode: 'real-chrome',
      harness: 'compat-tests/java21/e2e/harness.mjs',
      profileId: BROWSER_PROFILE_ID,
      baseUrl: app.baseUrl,
      start,
      selectedCaseCount: selected.length,
      skippedCaseCount: skipped.length,
      skipped: {
        bits: [],
        acm: skipped.filter(testCase => testCase.category === 'acm').length,
        ub: skipped.filter(testCase => testCase.category === 'ub').length,
        reason: 'UB remains evidence-only; all feature, ACM, negative, and warning cases are selected.'
      },
      bitsNoPchAB: {
        status: bitsRaw?.compileStatus || null,
        runStatus: bitsRaw?.runStatus || null,
        pass: bitsPass,
        pchPolicy: 'DISABLED',
        stdout: bitsRaw?.stdout || '',
        stderr: bitsRaw?.stderr || '',
        timing: bitsRaw?.timing || null
      },
      bitsPerformance,
      headerMismatchProbes,
      network: {
        totalRequests: requests.entries.length,
        sourceLikeRequests: requests.entries.filter(item => item.hasSourceLikeBody).length,
        submissions: requests.entries.filter(item => /\/submissions(?:$|\?)/.test(item.url)).length
      },
      summary: {
        passed: results.filter(result => result.pass === true).length,
        failed: failed.length + headerFailed + (!bitsPass && !bitsBlocked ? 1 : 0),
        blocked: blockedCount + headerBlocked + (bitsBlocked ? 1 : 0)
      },
      results
    };
  } finally {
    try { await chrome?.context?.close(); } catch (_) {}
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await app.stop(); } catch (_) {}
  }
}


async function runBrowserHarness(options, cases) {
  if (!options.browserCommand) {
    try {
      return await runChromeCorpusHarness(options, cases);
    } catch (error) {
      return {
        status: 'BLOCKED',
        mode: 'real-chrome',
        harness: 'compat-tests/java21/e2e/harness.mjs',
        reason: String(error && error.stack ? error.stack : error)
      };
    }
  }
  const env = {
    ...process.env,
    CPP17_MATRIX_MANIFEST: MANIFEST_PATH,
    CPP17_REFERENCE_JSON: REFERENCE_PATH,
    CPP17_PROFILE_ID: options.profile.id
  };
  const result = childProcess.spawnSync(
    options.browserCommand,
    [],
    { cwd: ROOT_DIR, env, shell: true, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: 8 * 1024 * 1024 }
  );
  return {
    status: result.status === 0 ? 'PASS' : 'FAIL',
    command: options.browserCommand,
    exitCode: result.status,
    signal: result.signal || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String(result.error.message || result.error) : null
  };
}

function summarize(cases) {
  const scoreable = cases.filter((x) => x.scoreable);
  return {
    total: cases.length,
    passed: scoreable.filter((x) => x.pass === true).length,
    failed: scoreable.filter((x) => x.pass === false).length,
    blocked: scoreable.filter((x) => x.status === 'BLOCKED').length,
    ubReported: cases.filter((x) => x.category === 'ub' && x.status === 'REPORTED').length,
    byCategory: ['feature', 'acm', 'negative', 'warning', 'ub'].reduce((out, category) => {
      const group = cases.filter((x) => x.category === category);
      out[category] = {
        total: group.length,
        passed: group.filter((x) => x.pass === true).length,
        failed: group.filter((x) => x.pass === false).length,
        blocked: group.filter((x) => x.status === 'BLOCKED').length
      };
      return out;
    }, {})
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readJson(MANIFEST_PATH);
  const profile = loadProfile();
  options.profile = profile;
  const cases = options.maxCases > 0
    ? manifest.cases.slice(0, options.maxCases)
    : manifest.cases;
  const startedAt = new Date().toISOString();
  let results = [];
  let probes;
  if (options.browserOnly) {
    const existing = readJson(REFERENCE_PATH);
    results = existing.cases;
    probes = existing.probes;
  } else if (options.skipRemote) {
    for (const testCase of cases) {
      results.push({
        id: testCase.id,
        category: testCase.category,
        source: testCase.source,
        input: testCase.input,
        expected: testCase.expected,
        expectation: testCase.expectation,
        scoreable: testCase.scoreable,
        status: 'BLOCKED',
        pass: null,
        reason: '--skip-remote requested'
      });
    }
  } else {
    for (const testCase of cases) {
      results.push(caseResult(options, testCase));
    }
  }
  if (!probes) probes = runBitsAndPchProbes(options);
  const reference = {
    schemaVersion: 'cpp17-gcc14-reference-v1',
    generatedAt: startedAt,
    profile: {
      id: profile.id,
      standard: profile.standard,
      compiler: profile.compiler,
      flags: profile.flags,
      compileCommand: profile.compileCommand,
      referenceStatus: profile.referenceStatus,
      compilerVersion: profile.compilerVersion,
      os: profile.os
    },
    backend: {
      type: 'ssh',
      host: options.sshHost,
      commandPolicy: 'profile-derived; source/input transferred through ephemeral SSH tempdir',
      timeoutSeconds: 10
    },
    corpus: {
      manifest: 'matrix-manifest.json',
      selectedCases: cases.length,
      declaredCounts: manifest.counts,
      summary: summarize(results)
    },
    probes,
    cases: results
  };
  if (!options.browserOnly) writeJson(REFERENCE_PATH, reference);
  options.headerMismatchReference = probes.headerMismatch || [];
  const browser = await runBrowserHarness(options, cases);
  const referenceStatus = options.skipRemote
    ? 'BLOCKED'
    : (results.some((x) => x.status === 'BLOCKED') ? 'BLOCKED' : 'GCC14_REFERENCE_READY');
  const assertionFailure = results.some((x) => x.pass === false);
  const browserCoverageComplete = browser.status === 'PASS'
    && (!browser.skipped || (browser.skipped.bits.length === 0
      && browser.skipped.acm === 0));
  const matrix = {
    schemaVersion: 'cpp17-compatibility-matrix-v1',
    generatedAt: startedAt,
    profile: profile,
    corpus: {
      manifest: 'matrix-manifest.json',
      declaredCounts: manifest.counts,
      summary: summarize(results)
    },
    reference: {
      status: referenceStatus,
      file: 'reference-cpp17.json',
      host: options.sshHost
    },
    browser,
    browserCoverageComplete,
    pch: {
      ...probes.pchDecision,
      browser: browser.bitsPerformance || null
    },
    betaGate: {
      status: referenceStatus === 'GCC14_REFERENCE_READY' && browserCoverageComplete && !assertionFailure ? 'PASS' : 'BLOCKED',
      reason: referenceStatus !== 'GCC14_REFERENCE_READY'
        ? 'GCC14 reference is not ready; inspect reference-cpp17.json'
        : browser.status === 'BLOCKED'
        ? browser.reason
        : !browserCoverageComplete
          ? 'Browser subset passed; ACM and bits probes remain pending shim integration'
        : browser.status !== 'PASS' || assertionFailure
          ? 'One or more Browser or corpus assertions failed; inspect matrix evidence'
          : null
    }
  };
  writeJson(MATRIX_PATH, matrix);
  console.log(JSON.stringify({
    reference: REFERENCE_PATH,
    matrix: MATRIX_PATH,
    referenceSummary: reference.corpus.summary,
    browser: browser.status,
    betaGate: matrix.betaGate.status
  }, null, 2));
}

main().catch((error) => {
  console.error('[cpp17-matrix] ERROR:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
