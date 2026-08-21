import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const image = process.env.BROWSERJDK_BUILD_IMAGE || 'browserjdk-oj-build:emsdk-5.0.2';

function runDocker(mainClass) {
  const command = [
    'rm -rf /tmp/phase7-core && mkdir -p /tmp/phase7-core &&',
    'javac --release 21 -encoding UTF-8 -d /tmp/phase7-core',
    '/src/browserjdk-oj/src/java/org/minioj/browserjdk/CompileServer.java',
    '/src/compat-tests/java21/cache/CompileServerCacheHarness.java',
    '/src/compat-tests/java21/isolation/CompileServerIsolationHarness.java',
    '&& java -cp /tmp/phase7-core ' + mainClass
  ].join(' ');
  return spawnSync('docker', ['run', '--rm', '--mount', `type=bind,src=${root},dst=/src`,
    image, 'bash', '-lc', command], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    timeout: 120000});
}

function jsonLines(text) {
  return text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => {
    try { return JSON.parse(line); } catch (_) { return {parseError: line}; }
  });
}

function runJavaCase(name, className) {
  const result = runDocker(className);
  const records = jsonLines(result.stdout || '');
  const passed = result.status === 0 && !records.some(value => value.parseError);
  if (result.status !== 0) {
    console.error(`[${name}] docker exit=${result.status ?? 'null'}\n${result.stderr || result.error || ''}`);
  }
  return {name, status: passed ? 'PASS' : 'FAIL', records,
    stderr: result.stderr || '', exitCode: result.status};
}

function runTimeoutCase() {
  const script = path.join(here, 'timeout', 'run-timeout-recovery.mjs');
  const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024, timeout: 240000});
  const records = jsonLines(result.stdout || '');
  const blocked = records.find(value => value.status === 'BLOCKED');
  const passed = result.status === 0 && records.some(value => value.status === 'PASS');
  if (result.status !== 0 && !blocked) {
    console.error(`[timeout] exit=${result.status ?? 'null'}\n${result.stderr || result.error || ''}`);
  }
  return {name: 'timeout', status: blocked ? 'BLOCKED' : (passed ? 'PASS' : 'FAIL'),
    records, stderr: result.stderr || '', exitCode: result.status};
}

function runBrowserCacheCase() {
  const script = path.join(here, 'cache', 'run-browser-cache.mjs');
  const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024, timeout: 240000});
  const records = jsonLines(result.stdout || '');
  const blocked = records.find(value => value.status === 'BLOCKED');
  const passed = result.status === 0 && records.some(value => value.status === 'PASS');
  if (result.status !== 0 && !blocked) {
    console.error(`[browser-cache] exit=${result.status ?? 'null'}\n${result.stderr || result.error || ''}`);
  }
  return {name: 'browser-cache', status: blocked ? 'BLOCKED' : (passed ? 'PASS' : 'FAIL'),
    records, stderr: result.stderr || '', exitCode: result.status};
}

function runBrowserIsolationCase() {
  const script = path.join(here, 'isolation', 'run-browser-isolation.mjs');
  const result = spawnSync(process.execPath, [script], {cwd: root, encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024, timeout: 240000});
  const records = jsonLines(result.stdout || '');
  const blocked = records.find(value => value.status === 'BLOCKED');
  const passed = result.status === 0 && records.some(value => value.status === 'PASS');
  if (result.status !== 0 && !blocked) {
    console.error(`[browser-isolation] exit=${result.status ?? 'null'}\n${result.stderr || result.error || ''}`);
  }
  return {name: 'browser-isolation', status: blocked ? 'BLOCKED' : (passed ? 'PASS' : 'FAIL'),
    records, stderr: result.stderr || '', exitCode: result.status};
}

function main() {
  for (const required of [
    path.join(root, 'browserjdk-oj', 'src', 'java', 'org', 'minioj', 'browserjdk', 'CompileServer.java'),
    path.join(root, 'compat-tests', 'java21', 'cache', 'CompileServerCacheHarness.java'),
    path.join(root, 'compat-tests', 'java21', 'isolation', 'CompileServerIsolationHarness.java')
  ]) {
    if (!existsSync(required)) throw new Error('missing core test asset: ' + required);
  }
  const report = {
    checkpoint: 'JAVA_PHASE7_CHECKPOINT_2_CORE',
    runtimeId: 'java21-browserjdk-compat-v2',
    cache: runJavaCase('cache', 'org.minioj.browserjdk.CompileServerCacheHarness'),
    isolation: runJavaCase('isolation', 'org.minioj.browserjdk.CompileServerIsolationHarness'),
    browserCache: runBrowserCacheCase(),
    browserIsolation: runBrowserIsolationCase(),
    timeout: runTimeoutCase()
  };
  report.pass = [report.cache, report.isolation, report.browserCache, report.browserIsolation]
    .every(item => item.status === 'PASS')
    && report.timeout.status === 'PASS';
  const resultDir = path.join(here, 'results');
  mkdirSync(resultDir, {recursive: true});
  writeFileSync(path.join(resultDir, 'phase7-core-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main();
