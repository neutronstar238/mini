import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  launchChrome,
  loginAndOpenProblem,
  startLocalContestServer
} from '../../compat-tests/java21/e2e/harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'compat-tests', 'modern-cpp', 'results', 'modern-cpp-optimization.json');
const HOST = process.env.GCC14_REFERENCE_HOST || '';
if (!HOST) throw new Error('Set GCC14_REFERENCE_HOST to your GCC 14 reference server');
const REPETITIONS = Number(process.env.MODERN_CPP_AB_REPETITIONS || 2);

function text(path) { return readFileSync(join(ROOT, path), 'utf8'); }
function trimmed(value) { return String(value == null ? '' : value).trim().replace(/\r\n/g, '\n'); }
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}
function median(values) { return percentile(values, 0.5); }

const cases = [
  {id: 'c17-stdio', language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17',
    source: 'compat-tests/c17/positive/01_stdio_scan_printf/main.c', input: 'compat-tests/c17/positive/01_stdio_scan_printf/input.txt', expected: 'compat-tests/c17/positive/01_stdio_scan_printf/expected.txt'},
  {id: 'c17-math', language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17',
    source: 'compat-tests/c17/positive/07_math_rounding/main.c', input: 'compat-tests/c17/positive/07_math_rounding/input.txt', expected: 'compat-tests/c17/positive/07_math_rounding/expected.txt'},
  {id: 'c17-bfs', language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17',
    source: 'compat-tests/c17/acm-corpus/06_bfs/main.c', input: 'compat-tests/c17/acm-corpus/06_bfs/input.txt', expected: 'compat-tests/c17/acm-corpus/06_bfs/expected.txt'},
  {id: 'c17-dijkstra', language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17',
    source: 'compat-tests/c17/acm-corpus/08_dijkstra/main.c', input: 'compat-tests/c17/acm-corpus/08_dijkstra/input.txt', expected: 'compat-tests/c17/acm-corpus/08_dijkstra/expected.txt'},
  {id: 'cpp17-structured-bindings', language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17',
    source: 'compat-tests/cpp17/features/feature-01-structured-bindings.cpp', input: 'compat-tests/cpp17/inputs/feature-01-structured-bindings.in', expected: 'compat-tests/cpp17/expected/feature-01-structured-bindings.out'},
  {id: 'cpp17-optional', language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17',
    source: 'compat-tests/cpp17/features/feature-04-optional.cpp', input: 'compat-tests/cpp17/inputs/feature-04-optional.in', expected: 'compat-tests/cpp17/expected/feature-04-optional.out'},
  {id: 'cpp17-vector', language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17',
    source: 'compat-tests/cpp17/features/feature-14-vector.cpp', input: 'compat-tests/cpp17/inputs/feature-14-vector.in', expected: 'compat-tests/cpp17/expected/feature-14-vector.out'},
  {id: 'cpp17-algorithm', language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17',
    source: 'compat-tests/cpp17/features/feature-22-algorithm.cpp', input: 'compat-tests/cpp17/inputs/feature-22-algorithm.in', expected: 'compat-tests/cpp17/expected/feature-22-algorithm.out'}
].map(item => ({...item, sourceText: text(item.source), stdin: text(item.input), expectedText: text(item.expected)}));

function gccReference(item) {
  const compiler = item.language === 'c17' ? 'gcc-14' : 'g++-14';
  const standard = item.language === 'c17' ? 'c17' : 'c++17';
  const extension = item.language === 'c17' ? 'c' : 'cpp';
  const source64 = Buffer.from(item.sourceText).toString('base64');
  const input64 = Buffer.from(item.stdin).toString('base64');
  const math = item.language === 'c17' ? ' -lm' : '';
  const script = `set -eu\nd=$(mktemp -d)\ntrap 'rm -rf "$d"' EXIT\nprintf %s '${source64}' | base64 -d > "$d/main.${extension}"\nprintf %s '${input64}' | base64 -d > "$d/input"\n${compiler} -std=${standard} -O2 -Wall -Wextra -DONLINE_JUDGE "$d/main.${extension}"${math} -o "$d/main" 2>"$d/compile.err"\n"$d/main" < "$d/input"\n`;
  const started = Date.now();
  let run;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    run = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, 'bash', '-s'], {
      input: script, encoding: 'utf8', timeout: 30000, windowsHide: true
    });
    if (run.status === 0 || !/timed out/i.test(String(run.stderr || ''))) break;
  }
  return {status: run.status === 0 ? 'PASS' : 'FAIL', exitCode: run.status, stdout: run.stdout || '', stderr: run.stderr || '', wallMs: Date.now() - started};
}

async function browserRun(page, item, optLevel, repetition) {
  const source = `${item.sourceText}\n/* phase8-ab:${optLevel}:${repetition} */\n`;
  return page.evaluate(async args => {
    const result = await globalThis.__IDE_RUNNER__.runCode(args);
    return result;
  }, {language: item.language, profileId: item.profileId, standard: item.standard,
    source, stdin: item.stdin, optLevel});
}

async function main() {
  const report = {
    schemaVersion: 'modern-cpp-optimization-ab-v1', generatedAt: new Date().toISOString(),
    threshold: {compatibilityPercent: 100, medianRatioMax: 1.5, p95CompileLinkMsMax: 5000},
    referenceHost: HOST, repetitions: REPETITIONS, cases: [], ubExcludedFromRates: true
  };
  const gccVersion = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST,
    "gcc-14 --version | head -1; g++-14 --version | head -1"], {encoding: 'utf8', timeout: 15000, windowsHide: true});
  report.referenceVersion = trimmed(gccVersion.stdout).split('\n');
  let app; let chrome;
  try {
    app = await startLocalContestServer({startTimeoutMs: 30000});
    chrome = await launchChrome();
    await loginAndOpenProblem(chrome.page, app.baseUrl);
    await chrome.page.waitForFunction(() => globalThis.__IDE_RUNNER__?.runCode, null, {timeout: 30000});
    for (const item of cases) {
      const reference = gccReference(item);
      const record = {id: item.id, language: item.language, expected: trimmed(item.expectedText), gcc14: {
        ...reference, stdout: trimmed(reference.stdout), matchesExpected: trimmed(reference.stdout) === trimmed(item.expectedText)
      }, browser: {'-O0': [], '-O2': []}};
      for (const optLevel of ['-O0', '-O2']) {
        for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
          const result = await browserRun(chrome.page, item, optLevel, repetition);
          record.browser[optLevel].push({compileStatus: result.compileStatus, runStatus: result.runStatus,
            stdout: trimmed(result.stdout), stderr: result.stderr || '', compileMs: result.compileTime || result.compileMs || 0,
            linkMs: result.linkTime || result.linkMs || 0, executionMs: result.executionTime || result.executionMs || 0,
            artifactBytes: result.artifactBytes || null, cacheHit: !!result.cacheHit,
            matchesExpected: result.compileStatus === 'PASS' && result.runStatus === 'PASS'
              && trimmed(result.stdout) === trimmed(item.expectedText)});
        }
      }
      report.cases.push(record);
    }
  } finally {
    try { await chrome?.context?.close(); } catch (_) {}
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await app?.stop(); } catch (_) {}
  }
  const metrics = {};
  for (const optLevel of ['-O0', '-O2']) {
    const rows = report.cases.flatMap(item => item.browser[optLevel]);
    const times = rows.map(row => Number(row.compileMs || 0) + Number(row.linkMs || 0));
    metrics[optLevel] = {runs: rows.length, compatible: rows.filter(row => row.matchesExpected).length,
      compatibilityPercent: rows.length ? rows.filter(row => row.matchesExpected).length * 100 / rows.length : 0,
      medianCompileLinkMs: median(times), p95CompileLinkMs: percentile(times, 0.95),
      medianArtifactBytes: median(rows.map(row => row.artifactBytes).filter(Number.isFinite))};
  }
  const ratio = metrics['-O0'].medianCompileLinkMs > 0
    ? metrics['-O2'].medianCompileLinkMs / metrics['-O0'].medianCompileLinkMs : Infinity;
  const gccOk = report.cases.every(item => item.gcc14.status === 'PASS' && item.gcc14.matchesExpected);
  const selectO2 = gccOk && metrics['-O2'].compatibilityPercent === 100 && ratio <= 1.5
    && metrics['-O2'].p95CompileLinkMs <= 5000;
  report.summary = {gcc14AllExpected: gccOk, metrics, o2MedianRatio: ratio,
    optimizationPolicy: selectO2 ? '-O2' : '-O0', optimizationMismatch: !selectO2,
    status: gccOk && metrics['-O0'].compatibilityPercent === 100 && metrics['-O2'].compatibilityPercent === 100 ? 'PASS' : 'FAIL'};
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  console.log(`modern-cpp optimization: ${report.summary.status}; policy=${report.summary.optimizationPolicy}`);
  console.log(`output: ${OUT}`);
  if (report.summary.status !== 'PASS') process.exitCode = 1;
}

await main();
