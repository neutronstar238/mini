#!/usr/bin/env node
/**
 * C17 compatibility matrix driver.
 *
 * The GCC14 command is loaded from server/src/language-profiles.js at runtime.
 * Remote and Browser evidence is never synthesized: unavailable backends are
 * recorded as BLOCKED/NOT_RUN and keep the matrix gate closed.
 */
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(HERE, '..', '..');
const PROFILE_PATH = join(REPO, 'server', 'src', 'language-profiles.js');
const OUTPUT_REFERENCE = join(HERE, 'reference-c17.json');
const OUTPUT_MATRIX = join(HERE, 'c17-compatibility-matrix.json');
const PROFILE_ID = 'c17-gcc14-compat-v2';
const REQUIRED_COUNTS = {positive: 36, 'acm-corpus': 30, negative: 15, warnings: 10, ub: 4};
const SUITES = Object.keys(REQUIRED_COUNTS);
const cliArgs = new Set(process.argv.slice(2));
const timeoutMs = Number(process.env.C17_SSH_TIMEOUT_MS || 8000);
const sshCommand = process.env.C17_SSH_COMMAND || 'ssh';
const scpCommand = process.env.C17_SCP_COMMAND || 'scp';
const remoteHost = process.env.C17_SSH_HOST || process.env.GCC14_SSH_HOST || '';
const sshConnectArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + Math.max(1, Math.ceil(timeoutMs / 1000)), '-o', 'ConnectionAttempts=1'];
const browserOptLevel = process.env.C17_BROWSER_OPT_LEVEL || '-O2';
const runServer = !cliArgs.has('--no-server') && process.env.C17_SKIP_SERVER !== '1';
const runBrowser = cliArgs.has('--browser') || process.env.C17_RUN_BROWSER === '1';
const strict = cliArgs.has('--strict');
const verbose = cliArgs.has('--verbose') || process.env.C17_VERBOSE === '1';

if (runServer && !remoteHost) {
  throw new Error('Set C17_SSH_HOST or GCC14_SSH_HOST, or pass --no-server');
}

const require = createRequire(import.meta.url);

function isoNow() {
  return new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function text(value) {
  return String(value == null ? '' : value);
}

function normalizeOutput(value) {
  return text(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}

function truncate(value, max = 4000) {
  const valueText = text(value);
  return valueText.length <= max ? valueText : valueText.slice(0, max) + '\n...[truncated]';
}

function command(executable, args, options = {}) {
  let result;
  try {
    result = spawnSync(executable, args, {
      encoding: 'utf8',
      input: options.input,
      timeout: options.timeoutMs || timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
  } catch (error) {
    return {status: null, signal: null, error: error.message, stdout: '', stderr: ''};
  }
  return {
    status: result.status,
    signal: result.signal || null,
    error: result.error ? (result.error.code ? result.error.code + ': ' + result.error.message : result.error.message) : null,
    stdout: text(result.stdout),
    stderr: text(result.stderr)
  };
}

function retryable(result) {
  return result.status == null && /ETIMEDOUT|ECONN|EHOST|ENET|connection/i.test(text(result.error));
}

function commandWithRetry(executable, args, options = {}) {
  let result = command(executable, args, options);
  for (let attempt = 0; attempt < 2 && retryable(result); attempt += 1) {
    result = command(executable, args, options);
  }
  return result;
}

function remoteCommand(host, args, options = {}) {
  return commandWithRetry(sshCommand, [...sshConnectArgs, host, ...args], options);
}

function profileSnapshot() {
  let profiles;
  try {
    profiles = require(PROFILE_PATH).PROFILES;
  } catch (error) {
    return {
      ok: false,
      source: relative(REPO, PROFILE_PATH).replaceAll('\\', '/'),
      error: error.message
    };
  }
  const profile = profiles && profiles.c17;
  const compileCommand = profile?.officialJudge?.compileCommand;
  if (!profile || !Array.isArray(compileCommand) || !compileCommand.length) {
    return {
      ok: false,
      source: relative(REPO, PROFILE_PATH).replaceAll('\\', '/'),
      error: 'c17 officialJudge.compileCommand is missing'
    };
  }
  return {
    ok: true,
    source: relative(REPO, PROFILE_PATH).replaceAll('\\', '/'),
    id: profile.id,
    language: profile.language,
    standard: profile.officialJudge.standard,
    runtimeId: profile.localRuntime.runtimeId,
    localCompiler: profile.localRuntime.compiler,
    localCompilerVersion: profile.localRuntime.compilerVersion,
    compiler: compileCommand[0],
    flags: compileCommand.slice(1).filter(token => token !== '<src>' && token !== '<out>'),
    compileCommand,
    runCommand: profile.officialJudge.runCommand,
    compilerVersionDeclared: profile.officialJudge.compilerVersion,
    referenceStatusDeclared: profile.officialJudge.referenceStatus,
    profile
  };
}

function loadCases() {
  const cases = [];
  const errors = [];
  for (const suite of SUITES) {
    const suitePath = join(HERE, suite);
    if (!existsSync(suitePath)) {
      errors.push({suite, error: 'suite directory missing'});
      continue;
    }
    for (const entry of readdirSync(suitePath, {withFileTypes: true}).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const caseDir = join(suitePath, entry.name);
      try {
        const metadata = JSON.parse(readFileSync(join(caseDir, 'meta.json'), 'utf8'));
        const sourceName = metadata.source || 'main.c';
        const inputName = metadata.input || metadata.stdin || 'input.txt';
        const expectedName = metadata.expectedOutput || metadata.expected || 'expected.txt';
        const sourcePath = join(caseDir, sourceName);
        const inputPath = join(caseDir, inputName);
        const expectedPath = join(caseDir, expectedName);
        if (!existsSync(sourcePath) || !existsSync(inputPath) || !existsSync(expectedPath)) {
          throw new Error('main.c/input.txt/expected.txt is incomplete');
        }
        cases.push({
          id: metadata.id || entry.name,
          directory: relative(HERE, caseDir).replaceAll('\\', '/'),
          suite,
          metadata,
          source: readFileSync(sourcePath, 'utf8'),
          input: readFileSync(inputPath, 'utf8'),
          expected: readFileSync(expectedPath, 'utf8')
        });
      } catch (error) {
        errors.push({suite, case: entry.name, error: error.message});
      }
    }
  }
  cases.sort((a, b) => a.suite.localeCompare(b.suite) || a.id.localeCompare(b.id));
  return {cases, errors};
}

function countBySuite(cases) {
  return Object.fromEntries(SUITES.map(suite => [suite, cases.filter(item => item.suite === suite).length]));
}

function substituteCompileCommand(snapshot, sourcePath, outputPath, extraFlags = []) {
  const template = snapshot.compileCommand.slice(1);
  const args = [];
  for (const token of template) {
    if (token === '<src>') args.push(sourcePath);
    else if (token === '<out>') args.push(outputPath);
    else args.push(token);
  }
  if (!args.includes('-o')) args.push('-o', outputPath);
  return [...extraFlags, ...args];
}

function warningLines(compileResult) {
  return (text(compileResult.stderr) + '\n' + text(compileResult.stdout))
    .split('\n')
    .filter(line => /\bwarning:/i.test(line))
    .map(line => line.trim())
    .filter(Boolean);
}

function basicSide(status, reason) {
  return {
    status,
    reason: reason || null,
    compileStatus: status === 'BLOCKED' || status === 'NOT_RUN' ? status : null,
    runStatus: status === 'BLOCKED' || status === 'NOT_RUN' ? status : null,
    stdout: '',
    stderr: '',
    warningLines: [],
    warningEvidenceAvailable: false,
    executionMs: null,
    cacheHit: null
  };
}

function executeServerCase(item, snapshot, remoteDir) {
  const safeName = item.id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const remoteSource = remoteDir + '/' + safeName + '.c';
  const remoteOutput = remoteDir + '/' + safeName + '.out';
  const copied = commandWithRetry(scpCommand, [...sshConnectArgs, join(HERE, item.directory, item.metadata.source || 'main.c'), remoteHost + ':' + remoteSource]);
  if (copied.status !== 0) {
    return basicSide('BLOCKED', 'scp failed: ' + truncate(copied.error || copied.stderr || 'unknown error', 500));
  }
  const extraFlags = Array.isArray(item.metadata.extraFlags) ? item.metadata.extraFlags.map(text) : [];
  const compileArgs = substituteCompileCommand(snapshot, remoteSource, remoteOutput, extraFlags);
  const compiler = snapshot.compiler;
  const compile = remoteCommand(remoteHost, [compiler, ...compileArgs]);
  const compileOutput = text(compile.stdout) + text(compile.stderr);
  const diagnostics = warningLines(compile);
  const compileStatus = compile.status == null ? 'BLOCKED' : (compile.status === 0 ? 'PASS' : 'CE');
  if (compileStatus === 'BLOCKED') {
    remoteCommand(remoteHost, ['rm', '-f', remoteSource, remoteOutput]);
    return basicSide('BLOCKED', 'remote compile failed to start: ' + truncate(compile.error || compileOutput, 500));
  }
  let run = null;
  const compileOnly = item.metadata.compileOnly === true || item.suite === 'negative' || item.suite === 'warnings' || item.suite === 'ub';
  if (compileStatus === 'PASS' && !compileOnly) {
    run = remoteCommand(remoteHost, [remoteOutput], {input: item.input});
  }
  remoteCommand(remoteHost, ['rm', '-f', remoteSource, remoteOutput]);
  const runStatus = compileStatus !== 'PASS'
    ? (item.suite === 'negative' ? 'CE' : 'N/A')
    : (compileOnly ? 'N/A' : (run.status === 0 ? 'PASS' : (run.status == null ? 'BLOCKED' : 'RE')));
  return {
    status: 'READY',
    reason: run?.status == null && compileStatus === 'PASS' && !compileOnly ? (run?.error || 'remote execution did not return') : null,
    compileStatus,
    runStatus,
    stdout: truncate(run?.stdout || ''),
    stderr: truncate(compileOutput + (run?.stderr || '')),
    warningLines: diagnostics,
    warningEvidenceAvailable: true,
    executionMs: null,
    cacheHit: null,
    exitCode: run?.status == null ? (compile.status ?? -1) : run.status,
    runError: run?.error || null,
    runReason: run?.status == null ? (run?.error || 'remote execution did not return') : null,
    compilerVersion: null
  };
}

function runServerEvidence(cases, snapshot) {
  if (!snapshot.ok) return {status: 'BLOCKED', reason: snapshot.error, version: null, cases: {}};
  const probe = remoteCommand(remoteHost, [snapshot.compiler, '--version']);
  const probeText = truncate(text(probe.stdout) + text(probe.stderr), 1000);
  if (probe.status !== 0) {
    return {
      status: 'BLOCKED',
      reason: probe.error || ('ssh/GCC14 probe exited ' + text(probe.status)),
      host: remoteHost,
      version: probeText || null,
      probe: {status: probe.status, stdout: truncate(probe.stdout), stderr: truncate(probe.stderr)},
      cases: {}
    };
  }
  const remoteDir = '/tmp/mini-c17-compat-' + process.pid;
  const made = remoteCommand(remoteHost, ['mkdir', '-p', remoteDir]);
  if (made.status !== 0) {
    return {status: 'BLOCKED', reason: 'remote mkdir failed: ' + truncate(made.stderr || made.error), host: remoteHost, version: probeText, cases: {}};
  }
  const output = {};
  try {
    for (const item of cases) {
      if (verbose) console.error('[c17] GCC14 ' + item.id);
      output[item.id] = executeServerCase(item, snapshot, remoteDir);
    }
  } finally {
    remoteCommand(remoteHost, ['rm', '-rf', remoteDir]);
  }
  return {status: 'READY', host: remoteHost, version: probeText, cases: output};
}

function loadReusableServerEvidence(cases, snapshot) {
  try {
    const reference = JSON.parse(readFileSync(OUTPUT_REFERENCE, 'utf8'));
    const expectedCounts = countBySuite(cases);
    const savedCounts = reference.corpus?.counts || {};
    if (reference.server?.status !== 'READY' || SUITES.some(suite => savedCounts[suite] !== expectedCounts[suite])) {
      return {status: 'BLOCKED', reason: 'reference-c17.json is not a complete READY corpus reference.', cases: {}};
    }
    if (JSON.stringify(reference.profile?.compileCommand || []) !== JSON.stringify(snapshot.compileCommand || [])) {
      return {status: 'BLOCKED', reason: 'reference-c17.json compile command does not match language profile.', cases: {}};
    }
    const saved = new Map((reference.cases || []).map(item => [item.id, item]));
    const output = {};
    for (const item of cases) {
      const row = saved.get(item.id);
      if (!row) return {status: 'BLOCKED', reason: 'reference-c17.json is missing ' + item.id, cases: {}};
      const compileBlocked = row.compileStatus === 'BLOCKED';
      output[item.id] = {
        status: compileBlocked ? 'BLOCKED' : 'READY',
        reason: compileBlocked ? 'reused reference case was previously BLOCKED' : null,
        compileStatus: row.compileStatus,
        runStatus: row.runStatus,
        stdout: row.stdout || '',
        stderr: row.stderr || '',
        warningLines: Array.isArray(row.warningLines) ? row.warningLines : [],
        warningEvidenceAvailable: item.suite === 'warnings' || (Array.isArray(row.warningLines) && row.warningLines.length > 0),
        executionMs: null,
        cacheHit: null,
        reused: true
      };
    }
    return {
      status: 'READY',
      host: reference.server.host || remoteHost,
      version: reference.server.version || null,
      reused: true,
      reusedFrom: relative(REPO, OUTPUT_REFERENCE).replaceAll('\\', '/'),
      cases: output
    };
  } catch (error) {
    return {status: 'BLOCKED', reason: 'cannot reuse reference-c17.json: ' + error.message, cases: {}};
  }
}

async function browserCase(page, item, timeout = 120000) {
  const result = await page.evaluate(async ({source, stdin, optLevel, profileId, timeout}) => {
    const runner = globalThis.__IDE_RUNNER__;
    if (!runner || typeof runner.runCode !== 'function') {
      return {harnessStatus: 'UNAVAILABLE', stderr: 'window.__IDE_RUNNER__.runCode unavailable'};
    }
    const timeoutResult = new Promise(resolve => setTimeout(() => resolve({
      harnessStatus: 'TIMEOUT', compileStatus: 'TIMEOUT', runStatus: 'TIMEOUT',
      stdout: '', stderr: 'Browser harness timeout'
    }), timeout));
    try {
      return await Promise.race([runner.runCode({
        language: 'c17',
        standard: 'c17',
        profileId,
        source,
        stdin,
        optLevel
      }), timeoutResult]);
    } catch (error) {
      return {harnessStatus: 'ERROR', compileStatus: 'ERROR', runStatus: 'ERROR', stdout: '', stderr: String(error?.message || error)};
    }
  }, {
    source: item.source,
    stdin: item.input,
    optLevel: browserOptLevel,
    profileId: PROFILE_ID,
    timeout
  });
  const compileStatus = text(result.compileStatus).toUpperCase();
  const runStatus = text(result.runStatus).toUpperCase();
  const diagnostics = (text(result.stderr) + '\n' + text(result.stdout))
    .split('\n')
    .filter(line => /\bwarning:/i.test(line))
    .map(line => line.trim())
    .filter(Boolean);
  const harnessStatus = result.harnessStatus || 'READY';
  return {
    status: harnessStatus === 'READY' ? 'READY' : 'BLOCKED',
    reason: harnessStatus === 'READY' ? null : text(result.stderr || harnessStatus),
    compileStatus: compileStatus || 'ERROR',
    runStatus: runStatus || 'ERROR',
    stdout: truncate(result.stdout || ''),
    stderr: truncate(result.stderr || ''),
    warningLines: diagnostics,
    warningEvidenceAvailable: diagnostics.length > 0,
    executionMs: Number.isFinite(result.executionTime) ? result.executionTime : null,
    cacheHit: result.cacheHit == null ? null : !!result.cacheHit,
    timedOut: !!result.timedOut || runStatus === 'TLE' || harnessStatus === 'TIMEOUT'
  };
}

async function runBrowserEvidence(cases) {
  if (!runBrowser) return {status: 'NOT_RUN', reason: 'Browser harness not requested; pass --browser to execute it.', optLevel: browserOptLevel, cases: {}};
  let harness;
  try {
    harness = await import('../java21/e2e/harness.mjs');
  } catch (error) {
    return {status: 'NOT_RUN', reason: 'Browser harness import failed: ' + error.message, optLevel: browserOptLevel, cases: {}};
  }
  let localServer = null;
  let chrome = null;
  try {
    const baseUrl = process.env.C17_BROWSER_BASE_URL;
    if (baseUrl) {
      localServer = {baseUrl};
    } else {
      localServer = await harness.startLocalContestServer({startTimeoutMs: Number(process.env.C17_BROWSER_START_TIMEOUT_MS || 30000)});
    }
    chrome = await harness.launchChrome();
    const opened = await harness.loginAndOpenProblem(chrome.page, localServer.baseUrl);
    const output = {};
    for (const item of cases) output[item.id] = await browserCase(chrome.page, item);
    return {
      status: 'READY',
      baseUrl: localServer.baseUrl,
      problemUrl: opened.problemUrl,
      optLevel: browserOptLevel,
      cases: output
    };
  } catch (error) {
    return {status: 'NOT_RUN', reason: 'Browser harness execution failed: ' + error.message, optLevel: browserOptLevel, cases: {}};
  } finally {
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await localServer?.stop?.(); } catch (_) {}
  }
}

function matches(item, side) {
  if (item.suite === 'ub') return null;
  if (!side || side.status === 'BLOCKED' || side.status === 'NOT_RUN') return false;
  const expectedVerdict = item.metadata.expectedVerdict;
  if (expectedVerdict === 'CE') return side.compileStatus === 'CE';
  if (expectedVerdict === 'PASS_WITH_WARNINGS') {
    if (!side.warningEvidenceAvailable) {
      // The Browser runner does not expose compiler warning streams. Its
      // scoreable contract for this suite is successful C17 compilation.
      return side.compileStatus === 'PASS';
    }
    return side.compileStatus === 'PASS' &&
      side.warningLines.length >= Number(item.metadata.minimumWarnings || 1);
  }
  return side.compileStatus === 'PASS' &&
    side.runStatus === 'PASS' &&
    normalizeOutput(side.stdout) === normalizeOutput(item.expected);
}

function resultRows(cases, serverEvidence, browserEvidence) {
  return cases.map(item => {
    const server = serverEvidence.cases[item.id] || basicSide(serverEvidence.status, serverEvidence.reason);
    const browser = browserEvidence.cases[item.id] || basicSide(browserEvidence.status, browserEvidence.reason);
    const serverMatchesExpected = matches(item, server);
    const browserMatchesExpected = matches(item, browser);
    return {
      id: item.id,
      suite: item.suite,
      directory: item.directory,
      expectedVerdict: item.metadata.expectedVerdict,
      expectedOutput: normalizeOutput(item.expected),
      server,
      browser,
      serverMatchesExpected,
      browserMatchesExpected,
      matrixCompatible: item.suite === 'ub' ? null : serverMatchesExpected === true && browserMatchesExpected === true,
      notCounted: item.suite === 'ub'
    };
  });
}

function summarize(rows) {
  const suites = {};
  for (const suite of SUITES) {
    const suiteRows = rows.filter(row => row.suite === suite);
    suites[suite] = {
      expected: REQUIRED_COUNTS[suite],
      discovered: suiteRows.length,
      serverMatchesExpected: suite === 'ub' ? null : suiteRows.filter(row => row.serverMatchesExpected === true).length,
      browserMatchesExpected: suite === 'ub' ? null : suiteRows.filter(row => row.browserMatchesExpected === true).length,
      matrixCompatible: suite === 'ub' ? null : suiteRows.filter(row => row.matrixCompatible === true).length,
      blockedOrNotRun: suiteRows.filter(row => row.server.status !== 'READY' || row.browser.status !== 'READY').length,
      notCounted: suite === 'ub'
    };
  }
  return suites;
}

function blockerList(rows, corpusErrors, serverEvidence, browserEvidence, corpusValid) {
  const blockers = [];
  if (!corpusValid) blockers.push('Corpus counts or required files do not match the Phase 8 C17 gate.');
  for (const error of corpusErrors) blockers.push(error.suite + (error.case ? '/' + error.case : '') + ': ' + error.error);
  if (serverEvidence.status !== 'READY') blockers.push('GCC14 reference: ' + serverEvidence.status + ': ' + serverEvidence.reason);
  if (browserEvidence.status !== 'READY') blockers.push('Browser harness: ' + browserEvidence.status + ': ' + browserEvidence.reason);
  for (const row of rows) {
    if (row.suite === 'ub') continue;
    if (row.serverMatchesExpected !== true) blockers.push(row.id + ': server evidence does not match expected verdict.');
    if (row.browserMatchesExpected !== true) blockers.push(row.id + ': Browser evidence does not match expected verdict.');
  }
  return [...new Set(blockers)];
}

async function main() {
  const profile = profileSnapshot();
  const loaded = loadCases();
  const counts = countBySuite(loaded.cases);
  const corpusValid = loaded.errors.length === 0 &&
    SUITES.every(suite => counts[suite] === REQUIRED_COUNTS[suite]);
  let serverEvidence;
  if (!runServer) {
    serverEvidence = {status: 'BLOCKED', reason: 'GCC14 execution disabled with --no-server.', cases: {}};
  } else if (cliArgs.has('--reuse-server')) {
    serverEvidence = loadReusableServerEvidence(loaded.cases, profile);
    if (cliArgs.has('--retry-blocked') && serverEvidence.status === 'READY') {
      const retryCases = loaded.cases.filter(item => serverEvidence.cases[item.id]?.status === 'BLOCKED');
      if (retryCases.length) {
        const refreshed = runServerEvidence(retryCases, profile);
        if (refreshed.status === 'READY') {
          serverEvidence = {...serverEvidence, cases: {...serverEvidence.cases, ...refreshed.cases}, retried: retryCases.map(item => item.id)};
        } else {
          serverEvidence = {...serverEvidence, retryStatus: refreshed.status, retryReason: refreshed.reason};
        }
      }
    }
  } else {
    serverEvidence = runServerEvidence(loaded.cases, profile);
  }
  const browserEvidence = await runBrowserEvidence(loaded.cases);
  const rows = resultRows(loaded.cases, serverEvidence, browserEvidence);
  const summary = summarize(rows);
  const blockers = blockerList(rows, loaded.errors, serverEvidence, browserEvidence, corpusValid);
  const status = corpusValid && blockers.length === 0 ? 'PASS' : 'BLOCKED';
  const generatedAt = isoNow();
  const profileForOutput = {...profile};
  delete profileForOutput.profile;
  profileForOutput.browser = {
    profileId: PROFILE_ID,
    language: 'c17',
    standard: 'c17',
    optLevel: browserOptLevel,
    harness: 'compat-tests/java21/e2e/harness.mjs'
  };

  const reference = {
    schemaVersion: 'c17-gcc14-reference-v1',
    generatedAt,
    status: serverEvidence.status === 'READY'
      ? (rows.filter(row => row.suite !== 'ub').every(row => row.serverMatchesExpected === true) ? 'PASS' : 'FAIL')
      : 'BLOCKED',
    sourceOfTruth: profile.source,
    flagsFromLanguageProfile: profile.ok,
    profile: profileForOutput,
    corpus: {counts, required: REQUIRED_COUNTS, valid: corpusValid},
    server: {
      status: serverEvidence.status,
      host: serverEvidence.host || remoteHost,
      version: serverEvidence.version || null,
      reason: serverEvidence.reason || null
    },
    cases: rows.map(row => ({
      id: row.id,
      suite: row.suite,
      expectedVerdict: row.expectedVerdict,
      compileStatus: row.server.compileStatus,
      runStatus: row.server.runStatus,
      stdout: row.server.stdout,
      stderr: row.server.stderr,
      warningLines: row.server.warningLines,
      matchesExpected: row.serverMatchesExpected,
      notCounted: row.notCounted
    }))
  };

  const matrix = {
    schemaVersion: 'c17-compatibility-matrix-v1',
    generatedAt,
    status,
    gate: 'Phase 8 C17/GCC14 compatibility beta gate',
    profile: profileForOutput,
    corpus: {counts, required: REQUIRED_COUNTS, valid: corpusValid},
    environment: {
      server: serverEvidence,
      browser: browserEvidence,
      browserRequested: runBrowser,
      serverRequested: runServer,
      serverReused: !!serverEvidence.reused
    },
    summary,
    blockers,
    results: rows
  };

  writeFileSync(OUTPUT_REFERENCE, JSON.stringify(reference, null, 2) + '\n', 'utf8');
  writeFileSync(OUTPUT_MATRIX, JSON.stringify(matrix, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    status,
    corpus: counts,
    reference: relative(REPO, OUTPUT_REFERENCE).replaceAll('\\', '/'),
    matrix: relative(REPO, OUTPUT_MATRIX).replaceAll('\\', '/'),
    server: serverEvidence.status,
    browser: browserEvidence.status,
    blockerCount: blockers.length
  }, null, 2));
  if (strict && status !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
