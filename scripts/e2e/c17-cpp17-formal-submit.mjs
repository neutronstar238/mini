#!/usr/bin/env node
/**
 * C17/C++17 Formal Submit enablement gate.
 *
 * Safety contract:
 *   - This script never creates a contest/problem.
 *   - Without --execute it only performs a read-only preflight.
 *   - With --execute it refuses to POST while either profile has
 *     submissionEnabled !== true.
 *   - It uses the existing test contest/problem only.
 *
 * Credentials and the test account are supplied by environment variables:
 *   P9_USERNAME=user1 P9_PASSWORD=user123
 *
 * Examples:
 *   node scripts/e2e/c17-cpp17-formal-submit.mjs --help
 *   P9_USERNAME=user1 P9_PASSWORD=user123 \
 *     node scripts/e2e/c17-cpp17-formal-submit.mjs
 *   P9_USERNAME=user1 P9_PASSWORD=user123 \
 *     node scripts/e2e/c17-cpp17-formal-submit.mjs --execute
 *
 * The default evidence output is tmp/c17-cpp17-formal-submit-<UTC>.json.
 * This API-only harness cannot prove a process argv path from the public API;
 * it records the exact profile mapping and uses a GCC 14.2 compile-time gate
 * in the AC sources. A server-side log/telemetry audit remains a final caveat.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';

dns.setDefaultResultOrder('ipv4first');

const BASE_URL = (process.env.P9_BASE_URL || 'https://contest.mini.nstarzx.cn').replace(/\/$/, '');
const USERNAME = process.env.P9_USERNAME || '';
const PASSWORD = process.env.P9_PASSWORD || '';
const CONTEST_TITLE = process.env.P9_TEST_CONTEST_TITLE || 'Browser OJ E2E Test';
const PROBLEM_TITLE = process.env.P9_TEST_PROBLEM_TITLE || 'A + B';
const REQUEST_TIMEOUT_MS = Number(process.env.P9_REQUEST_TIMEOUT_MS || 20000);
const JUDGE_TIMEOUT_MS = Number(process.env.P9_JUDGE_TIMEOUT_MS || 90000);
const SSE_TIMEOUT_MS = Number(process.env.P9_SSE_TIMEOUT_MS || 30000);
const SCOREBOARD_TIMEOUT_MS = Number(process.env.P9_SCOREBOARD_TIMEOUT_MS || 35000);
const TEST_CONTEST_OVERRIDE = process.env.P9_ALLOW_NON_TEST_CONTEST === '1';
const args = new Set(process.argv.slice(2));
let lastFormalSubmitAt = 0;

const EXPECTED_COMPILERS = {
  c17: {
    compilerPath: '/usr/bin/gcc-14',
    compilerLabel: 'GCC (gcc-14)',
    standard: 'c17',
    flags: ['-std=c17', '-O2', '-Wall', '-Wextra', '-DONLINE_JUDGE'],
    macroGate: '__GNUC__ == 14 && __GNUC_MINOR__ == 2'
  },
  cpp17: {
    compilerPath: '/usr/bin/g++-14',
    compilerLabel: 'G++ (g++-14)',
    standard: 'c++17',
    flags: ['-std=c++17', '-O2', '-Wall', '-Wextra', '-DONLINE_JUDGE'],
    macroGate: '__GNUC__ == 14 && __GNUC_MINOR__ == 2'
  }
};

const C17_GCC14_GATE = `#if !defined(__GNUC__) || __GNUC__ != 14 || __GNUC_MINOR__ != 2
#error PHASE9_EXPECTED_GCC14_2
#endif`;
const CPP17_GCC14_GATE = `#if !defined(__GNUC__) || __GNUC__ != 14 || __GNUC_MINOR__ != 2
#error PHASE9_EXPECTED_GXX14_2
#endif`;

const CASES = [
  {
    name: 'c17-ac',
    language: 'c17',
    expected: 'AC',
    compilerGate: true,
    source: `${C17_GCC14_GATE}
#include <stdio.h>
int main(void) {
    long long a, b;
    if (scanf("%lld%lld", &a, &b) != 2) return 0;
    printf("%lld\\n", a + b);
    return 0;
}`
  },
  {
    name: 'c17-ce',
    language: 'c17',
    expected: 'CE',
    source: `#include <stdio.h>
int main(void) {
    int x = ;
    return x;
}`
  },
  {
    name: 'c17-re',
    language: 'c17',
    expected: 'RE',
    source: `#include <stdio.h>
int main(void) {
    int *p = NULL;
    *p = 1;
    return 0;
}`
  },
  {
    name: 'c17-wa',
    language: 'c17',
    expected: 'WA',
    source: `#include <stdio.h>
int main(void) {
    long long a, b;
    if (scanf("%lld%lld", &a, &b) != 2) return 0;
    printf("%lld\\n", a - b);
    return 0;
}`
  },
  {
    name: 'cpp17-ac',
    language: 'cpp17',
    expected: 'AC',
    compilerGate: true,
    source: `${CPP17_GCC14_GATE}
#include <iostream>
int main() {
    long long a, b;
    std::cin >> a >> b;
    std::cout << a + b << '\\n';
    return 0;
}`
  },
  {
    name: 'cpp17-bits-ac',
    language: 'cpp17',
    expected: 'AC',
    compilerGate: true,
    source: `${CPP17_GCC14_GATE}
#include <bits/stdc++.h>
using namespace std;
int main() {
    long long a, b;
    cin >> a >> b;
    cout << a + b << '\\n';
    return 0;
}`
  },
  {
    name: 'cpp17-ce',
    language: 'cpp17',
    expected: 'CE',
    source: `#include <iostream>
int main() {
    std::cout << ;
    return 0;
}`
  },
  {
    name: 'cpp17-re',
    language: 'cpp17',
    expected: 'RE',
    source: `#include <bits/stdc++.h>
using namespace std;
int main() {
    vector<int> a;
    cout << a.at(1) << '\\n';
    return 0;
}`
  },
  {
    name: 'cpp17-wa',
    language: 'cpp17',
    expected: 'WA',
    source: `#include <iostream>
int main() {
    int a, b;
    std::cin >> a >> b;
    std::cout << a - b << '\\n';
    return 0;
}`
  }
];

const REQUIRED_STATUSES = ['QUEUED', 'JUDGING', 'FINISHED'];

class HarnessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'HarnessError';
    this.details = details;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage() {
  return `C17/C++17 Formal Submit acceptance harness

Read-only preflight (default):
  P9_USERNAME=user1 P9_PASSWORD=user123 node scripts/e2e/c17-cpp17-formal-submit.mjs

Execute real submissions (only after profiles report submissionEnabled=true):
  P9_USERNAME=user1 P9_PASSWORD=user123 node scripts/e2e/c17-cpp17-formal-submit.mjs --execute

Environment:
  P9_BASE_URL                 default: https://contest.mini.nstarzx.cn
  P9_USERNAME / P9_PASSWORD  required for API calls
  P9_TEST_CONTEST_TITLE       default: Browser OJ E2E Test
  P9_TEST_PROBLEM_TITLE       default: A + B
  P9_EVIDENCE_FILE            optional output path
  P9_ALLOW_NON_TEST_CONTEST=1 explicitly allows a non-test-looking contest title
`;
}

function outputPath() {
  const configured = process.env.P9_EVIDENCE_FILE;
  if (configured) return path.resolve(configured);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return path.resolve('tmp', `c17-cpp17-formal-submit-${stamp}.json`);
}

async function apiRequest(pathname, { token, method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { response, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function assertResponse(result, label) {
  if (!result.response.ok) {
    throw new HarnessError(`${label} HTTP ${result.response.status}`, {
      status: result.response.status,
      body: result.data
    });
  }
}

async function login() {
  if (!USERNAME || !PASSWORD) {
    throw new HarnessError('P9_USERNAME and P9_PASSWORD are required; no submission was attempted');
  }
  const result = await apiRequest('/api/contest/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD }
  });
  assertResponse(result, 'login');
  if (!result.data?.token || !result.data?.user?.id) {
    throw new HarnessError('login response did not contain token/user id');
  }
  return { token: result.data.token, user: result.data.user };
}

async function getProfiles() {
  const result = await apiRequest('/api/public/runtime-profiles');
  assertResponse(result, 'runtime profiles');
  const profiles = Array.isArray(result.data?.profiles) ? result.data.profiles : [];
  const byId = Object.fromEntries(profiles.map((profile) => [profile.id, profile]));
  return { profiles, byId };
}

function profileEvidence(profile, language) {
  const expected = EXPECTED_COMPILERS[language];
  const official = profile?.officialJudge || {};
  const flags = Array.isArray(official.compileFlags) ? official.compileFlags : [];
  const missingFlags = expected.flags.filter((flag) => !flags.includes(flag));
  const compilerVersionPass = /\b14\.2(?:\.\d+)?\b/.test(String(official.compilerVersion || ''));
  const mappingPass = profile &&
    profile.id === language &&
    official.supported === true &&
    official.compiler === expected.compilerLabel &&
    official.standard === expected.standard &&
    compilerVersionPass &&
    missingFlags.length === 0;
  return {
    language,
    mappedCompilerPath: expected.compilerPath,
    profileCompiler: official.compiler || null,
    profileCompilerVersion: official.compilerVersion || null,
    compilerVersionPass,
    profileStandard: official.standard || null,
    profileCompileFlags: flags,
    requiredCompileFlags: expected.flags,
    missingCompileFlags: missingFlags,
    macroGate: expected.macroGate,
    mappingPass: !!mappingPass,
    submissionEnabled: profile?.submissionEnabled === true,
    formalReady: !!mappingPass && profile?.submissionEnabled === true,
    note: 'Public API does not expose child_process argv; macro gate proves GCC 14.2-family compilation for the AC evidence source, while the exact path comes from the production profile mapping.'
  };
}

function assertFormalProfiles(byId) {
  const evidence = {};
  const disabled = [];
  for (const language of ['c17', 'cpp17']) {
    const profile = byId[language];
    if (!profile) throw new HarnessError(`missing public profile: ${language}`);
    evidence[language] = profileEvidence(profile, language);
    if (!evidence[language].mappingPass) {
      throw new HarnessError(`profile mapping is not ready for ${language}`, evidence[language]);
    }
    if (profile.submissionEnabled !== true) disabled.push(language);
  }
  return { evidence, disabled };
}

function assertTestContestTitle(title) {
  if (TEST_CONTEST_OVERRIDE) return;
  if (!/(test|e2e|browser|测试|验收)/i.test(String(title))) {
    throw new HarnessError(`refusing non-test contest title: ${title}; set P9_ALLOW_NON_TEST_CONTEST=1 only with explicit approval`);
  }
}

async function resolveTestTarget(token) {
  const contestsResult = await apiRequest('/api/contest/contests', { token });
  assertResponse(contestsResult, 'contest list');
  const contests = Array.isArray(contestsResult.data?.contests) ? contestsResult.data.contests : [];
  const contest = contests.find((item) => item.title === CONTEST_TITLE);
  if (!contest) throw new HarnessError(`test contest not found: ${CONTEST_TITLE}`);
  assertTestContestTitle(contest.title);

  const problemsResult = await apiRequest(`/api/contest/contests/${encodeURIComponent(contest.id)}/problems`, { token });
  assertResponse(problemsResult, 'problem list');
  const problems = Array.isArray(problemsResult.data?.problems) ? problemsResult.data.problems : [];
  const problem = problems.find((item) => item.title === PROBLEM_TITLE);
  if (!problem) throw new HarnessError(`test problem not found: ${PROBLEM_TITLE}`);

  const problemResult = await apiRequest(`/api/contest/contests/${encodeURIComponent(contest.id)}/problems/${encodeURIComponent(problem.id)}`, { token });
  assertResponse(problemResult, 'public problem boundary');
  assertNoHiddenLeak(problemResult.data, 'public problem');

  return { contest, problem, publicProblem: problemResult.data };
}

function assertNoHiddenLeak(payload, label) {
  const forbiddenKeys = new Set([
    'testcases', 'testcase', 'hiddenTest', 'hiddenTests', 'hiddenInput',
    'hiddenOutput', 'expectedOutput', 'solutionCode', 'genCode',
    'hiddenTestPath', 'testDataPath', 'filesystemPath'
  ]);
  const violations = [];
  function walk(value, keyPath = '$') {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) violations.push(`${keyPath}.${key}`);
      walk(child, `${keyPath}.${key}`);
    }
  }
  walk(payload);
  if (violations.length) throw new HarnessError(`${label} leaked hidden-test fields`, { violations });
  return { label, pass: true, forbiddenKeysChecked: [...forbiddenKeys] };
}

async function openPageSse(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SSE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE_URL}/api/contest/events?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' }
    });
    if (!response.ok || !String(response.headers.get('content-type') || '').startsWith('text/event-stream')) {
      throw new HarnessError(`SSE open failed: HTTP ${response.status} ${response.headers.get('content-type') || ''}`);
    }
    return {
      response,
      controller,
      timer,
      reader: response.body.getReader(),
      decoder: new TextDecoder(),
      buffer: ''
    };
  } catch (error) {
    clearTimeout(timer);
    controller.abort();
    throw error;
  }
}

function parseSseChunk(stream, chunk, submissionId, state) {
  stream.buffer += stream.decoder.decode(chunk, { stream: true });
  const records = stream.buffer.split('\n\n');
  stream.buffer = records.pop() || '';
  for (const record of records) {
    const eventName = record.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() || '';
    const line = record.split('\n').find((item) => item.startsWith('data:'));
    if (!line) continue;
    let data;
    try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
    state.events.push({ event: eventName, data });
    if (data && data.id === submissionId && data.status) {
      if (!state.statuses.includes(data.status)) state.statuses.push(data.status);
      if (data.status === 'FINISHED') state.finished = true;
    }
  }
}

async function observeSse(stream, submissionId) {
  const state = { statuses: [], events: [], finished: false };
  try {
    while (!state.finished) {
      const { value, done } = await stream.reader.read();
      if (done) break;
      parseSseChunk(stream, value, submissionId, state);
    }
  } catch (error) {
    if (!stream.controller.signal.aborted) state.error = String(error?.message || error);
  } finally {
    clearTimeout(stream.timer);
    stream.controller.abort();
    try { await stream.reader.cancel(); } catch { /* already closed */ }
  }
  return {
    contentType: stream.response.headers.get('content-type'),
    statuses: state.statuses,
    events: state.events,
    finished: state.finished,
    error: state.error || null
  };
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

async function waitForFinished(id, token, initialStatus) {
  const statuses = [];
  addUnique(statuses, initialStatus);
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < JUDGE_TIMEOUT_MS) {
    const result = await apiRequest(`/api/contest/submissions/${encodeURIComponent(id)}`, { token });
    assertResponse(result, `submission ${id}`);
    last = result.data?.submission;
    addUnique(statuses, last?.status);
    if (last?.status === 'FINISHED') {
      return { submission: last, statuses, elapsedMs: Date.now() - startedAt };
    }
    await sleep(250);
  }
  throw new HarnessError(`submission ${id} did not reach FINISHED`, { statuses, last });
}

function statusPass(statuses) {
  return REQUIRED_STATUSES.every((status) => statuses.includes(status));
}

function ssePass(statuses, contentType, finished) {
  return String(contentType || '').startsWith('text/event-stream') &&
    finished === true && statusPass(statuses);
}

async function runFormalCase({ token, contest, problem, spec, runId }) {
  // Open the page stream before POST so a fast judge cannot race past JUDGING.
  const stream = await openPageSse(token);
  const submitDelay = Math.max(0, 1200 - (Date.now() - lastFormalSubmitAt));
  if (submitDelay) await sleep(submitDelay);
  const clientRequestId = `phase9-formal-${runId}-${spec.name}`;
  const sourceSha256 = crypto.createHash('sha256').update(spec.source, 'utf8').digest('hex');
  const created = await apiRequest(`/api/contest/contests/${encodeURIComponent(contest.id)}/submissions`, {
    token,
    method: 'POST',
    body: {
      contestId: contest.id,
      problemId: problem.id,
      language: spec.language,
      code: spec.source,
      source: spec.source,
      clientRequestId
    }
  });
  lastFormalSubmitAt = Date.now();
  assertResponse(created, `${spec.name} submit`);
  const first = created.data?.submission;
  if (!first?.id) throw new HarnessError(`${spec.name} submit did not return submission id`, { body: created.data });
  if (first.status !== 'QUEUED') {
    throw new HarnessError(`${spec.name} did not start in QUEUED`, { returned: first });
  }

  const ssePromise = observeSse(stream, first.id);
  const duplicate = await apiRequest(`/api/contest/contests/${encodeURIComponent(contest.id)}/submissions`, {
    token,
    method: 'POST',
    body: {
      contestId: contest.id,
      problemId: problem.id,
      language: spec.language,
      code: spec.source,
      source: spec.source,
      clientRequestId
    }
  });
  assertResponse(duplicate, `${spec.name} idempotency retry`);
  const duplicateSubmission = duplicate.data?.submission;
  const duplicatePass = duplicate.data?.deduplicated === true && duplicateSubmission?.id === first.id;
  if (!duplicatePass) {
    throw new HarnessError(`${spec.name} idempotency retry did not deduplicate`, { first, duplicate: duplicate.data });
  }

  const verdict = await waitForFinished(first.id, token, first.status);
  const sse = await ssePromise;
  const statusTimeline = [...verdict.statuses];
  for (const status of sse.statuses) addUnique(statusTimeline, status);
  const verdictPass = verdict.submission.verdict === spec.expected;
  const machinePass = statusPass(statusTimeline);
  const sseStatusPass = ssePass(sse.statuses, sse.contentType, sse.finished);
  const detailBoundary = assertNoHiddenLeak(verdict.submission, `${spec.name} submission detail`);
  const compiler = EXPECTED_COMPILERS[spec.language];

  if (!verdictPass || !machinePass || !sseStatusPass) {
    throw new HarnessError(`${spec.name} formal acceptance failed`, {
      expected: spec.expected,
      verdict: verdict.submission.verdict,
      statusTimeline,
      sse,
      duplicatePass
    });
  }

  return {
    name: spec.name,
    language: spec.language,
    expected: spec.expected,
    actualVerdict: verdict.submission.verdict,
    submissionId: first.id,
    clientRequestId,
    serverReceivedAt: created.data?.serverReceivedAt || null,
    sourceSha256,
    statusTimeline,
    sse: {
      contentType: sse.contentType,
      statuses: sse.statuses,
      finished: sse.finished,
      eventCount: sse.events.length
    },
    duplicate: {
      pass: duplicatePass,
      sameSubmissionId: duplicateSubmission.id === first.id,
      deduplicated: duplicate.data.deduplicated === true
    },
    stateMachinePass: machinePass,
    ssePass: sseStatusPass,
    verdictPass,
    detailBoundary,
    compilerEvidence: {
      mappedCompilerPath: compiler.compilerPath,
      profileCompiler: compiler.compilerLabel,
      requiredStandard: compiler.standard,
      macroGate: spec.compilerGate ? compiler.macroGate : null,
      macroGateSourceSha256: spec.compilerGate ? sourceSha256 : null,
      compileMessage: verdict.submission.compileMessage || '',
      runtimeMessage: verdict.submission.runtimeMessage || '',
      pathProof: 'profile mapping; child_process argv is not exposed by the public submission API'
    },
    elapsedMs: verdict.elapsedMs
  };
}

async function getScoreboard(token, contestId) {
  const result = await apiRequest(`/api/contest/contests/${encodeURIComponent(contestId)}/scoreboard`, { token });
  assertResponse(result, 'scoreboard');
  assertNoHiddenLeak(result.data, 'scoreboard');
  return result.data?.snapshot;
}

function rowFor(snapshot, userId) {
  return (snapshot?.participants || []).find((row) => row.userId === userId) || null;
}

function cellFor(row, problemId) {
  return row?.cells?.[problemId] || null;
}

async function verifyScoreboard({ token, contest, problem, userId, before }) {
  const startedAt = Date.now();
  let after = null;
  let row = null;
  while (Date.now() - startedAt < SCOREBOARD_TIMEOUT_MS) {
    after = await getScoreboard(token, contest.id);
    row = rowFor(after, userId);
    if (row && cellFor(row, problem.id)?.status === 'AC') break;
    await sleep(2000);
  }
  const beforeRow = rowFor(before, userId);
  const beforeCell = cellFor(beforeRow, problem.id);
  const afterCell = cellFor(row, problem.id);
  const otherSolvedBefore = new Set(Object.entries(beforeRow?.cells || {})
    .filter(([, cell]) => cell?.status === 'AC')
    .map(([problemId]) => problemId));
  const newlySolvedOutsideTarget = Object.entries(row?.cells || {})
    .filter(([problemId, cell]) => cell?.status === 'AC' && !otherSolvedBefore.has(problemId) && problemId !== problem.id)
    .map(([problemId]) => problemId);
  const pass = !!row && afterCell?.status === 'AC' &&
    Number(row.solved) >= Number(beforeRow?.solved || 0) &&
    newlySolvedOutsideTarget.length === 0;
  return {
    pass,
    versionBefore: before?.version ?? null,
    versionAfter: after?.version ?? null,
    userId,
    solvedBefore: beforeRow?.solved ?? null,
    solvedAfter: row?.solved ?? null,
    penaltyBefore: beforeRow?.penalty ?? null,
    penaltyAfter: row?.penalty ?? null,
    targetCellBefore: beforeCell || null,
    targetCellAfter: afterCell || null,
    newlySolvedOutsideTarget,
    note: 'Scoreboard is checked after the AC and failed submissions; CE/RE/WA must not create a solved cell.'
  };
}

function writeEvidence(evidence) {
  const target = outputPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return target;
}

async function preflight() {
  const auth = await login();
  const profileData = await getProfiles();
  const profileCheck = assertFormalProfiles(profileData.byId);
  const target = await resolveTestTarget(auth.token);
  return { auth, profileData, profileCheck, target };
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    process.stdout.write(usage());
    return;
  }

  const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + crypto.randomUUID().slice(0, 8);
  const common = {
    harness: 'c17-cpp17-formal-submit',
    runId,
    baseUrl: BASE_URL,
    contestTitle: CONTEST_TITLE,
    problemTitle: PROBLEM_TITLE,
    executeRequested: args.has('--execute'),
    createdSubmissionCount: 0,
    createdSubmissionIds: [],
    startedAt: new Date().toISOString()
  };

  let context;
  try {
    context = await preflight();
  } catch (error) {
    const evidence = {
      ...common,
      status: 'PREFLIGHT_FAILED',
      blockingFailure: error.message,
      details: error.details || null,
      finishedAt: new Date().toISOString()
    };
    const file = writeEvidence(evidence);
    process.stdout.write(`${JSON.stringify({ ...evidence, evidenceFile: file }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const { auth, profileData, profileCheck, target } = context;
  const preflightEvidence = {
    profiles: profileCheck.evidence,
    publicProfileCount: profileData.profiles.length,
    contest: { id: target.contest.id, title: target.contest.title },
    problem: { id: target.problem.id, title: target.problem.title }
  };

  if (!args.has('--execute')) {
    const evidence = {
      ...common,
      status: 'PREFLIGHT_ONLY',
      blockingFailure: 'No production submissions created. Pass --execute only after both profiles are enabled.',
      ...preflightEvidence,
      finishedAt: new Date().toISOString()
    };
    const file = writeEvidence(evidence);
    process.stdout.write(`${JSON.stringify({ ...evidence, evidenceFile: file }, null, 2)}\n`);
    return;
  }

  if (profileCheck.disabled.length) {
    const evidence = {
      ...common,
      status: 'BLOCKED_SAFE_FORMAL_SUBMIT_DISABLED',
      blockingFailure: `Formal submit remains disabled for: ${profileCheck.disabled.join(', ')}`,
      ...preflightEvidence,
      finishedAt: new Date().toISOString()
    };
    const file = writeEvidence(evidence);
    process.stdout.write(`${JSON.stringify({ ...evidence, evidenceFile: file }, null, 2)}\n`);
    process.exitCode = 2;
    return;
  }

  const scoreboardBefore = await getScoreboard(auth.token, target.contest.id);
  const results = [];
  const failures = [];
  for (const spec of CASES) {
    try {
      const result = await runFormalCase({
        token: auth.token,
        contest: target.contest,
        problem: target.problem,
        spec,
        runId
      });
      results.push(result);
      common.createdSubmissionIds.push(result.submissionId);
      common.createdSubmissionCount += 1;
      process.stdout.write(`[PASS] ${spec.name} ${result.submissionId} ${result.actualVerdict} statuses=${result.statusTimeline.join('>')} sse=${result.sse.statuses.join('>')}\n`);
    } catch (error) {
      failures.push({ case: spec.name, message: error.message, details: error.details || null });
      process.stderr.write(`[FAIL] ${spec.name}: ${error.message}\n`);
      break;
    }
  }

  const scoreboard = failures.length ? null : await verifyScoreboard({
    token: auth.token,
    contest: target.contest,
    problem: target.problem,
    userId: auth.user.id,
    before: scoreboardBefore
  });
  const hiddenTestIsolation = {
    pass: !failures.length,
    checks: [
      'public problem response rejects hidden-test field keys',
      'submission detail rejects hidden-test field keys',
      'scoreboard response rejects hidden-test field keys',
      'SSE payload is status-only for the matching submission'
    ],
    scope: 'HTTP/API boundary; browser network capture and server filesystem audit are outside this Node harness'
  };
  const compilerEvidencePass = ['c17-ac', 'cpp17-ac', 'cpp17-bits-ac'].every((name) => {
    const result = results.find((item) => item.name === name);
    return result?.actualVerdict === 'AC' && result.compilerEvidence?.macroGate;
  });
  const allCasesPass = results.length === CASES.length && failures.length === 0 &&
    results.every((result) => result.verdictPass && result.stateMachinePass && result.ssePass && result.duplicate.pass);
  const evidence = {
    ...common,
    status: allCasesPass && compilerEvidencePass && scoreboard?.pass && hiddenTestIsolation.pass ? 'PASS' : 'FAIL',
    ...preflightEvidence,
    cases: results,
    failures,
    compilerEvidencePass,
    stateMachinePass: allCasesPass,
    ssePass: allCasesPass,
    duplicateSubmissionPass: allCasesPass,
    scoreboard,
    hiddenTestIsolation,
    limitations: [
      'Actual compiler child_process argv is not returned by the public API; compiler path evidence is profile mapping plus the GCC 14.2 compile-time gate in AC sources.',
      'Browser Local stdout equivalence, Nginx/network capture, Node/Judge/Nginx log cleanliness, and sandbox policy require separate browser/SSH evidence.',
      'This harness never enables formal submit and never changes production feature flags.'
    ],
    finishedAt: new Date().toISOString()
  };
  const file = writeEvidence(evidence);
  process.stdout.write(`${JSON.stringify({ ...evidence, evidenceFile: file }, null, 2)}\n`);
  if (evidence.status !== 'PASS') process.exitCode = 1;
}

await main();
