'use strict';
/**
 * compat-tests/java21/run-server.js —— Java 21 Official Judge 测试运行器
 *
 * 用法：
 *   node run-server.js --case 01_a_plus_b
 *   node run-server.js --all
 *
 * 与 OJ 服务端共享 judge-adapter.js 的 compileJava 等价逻辑（直接 spawn javac → java），
 * 确保 compat matrix 与正式评测一致。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname);
const CORPUS = path.join(ROOT, 'corpus');

function readText(p) { return fs.readFileSync(p, 'utf8'); }

function runProc(cmd, args, opts) {
  return new Promise(function (resolve) {
    const child = spawn(cmd, args, Object.assign({ cwd: opts.cwd }, opts.spawnOpts || {}));
    let stdout = '', stderr = '';
    let killed = false, timedOut = false;
    const timer = setTimeout(function () { timedOut = true; killed = true; try { child.kill('SIGKILL'); } catch (_) {} }, opts.timeoutMs || 5000);
    if (child.stdout) child.stdout.on('data', function (d) { stdout += d; });
    if (child.stderr) child.stderr.on('data', function (d) { stderr += d; });
    child.on('error', function (e) { clearTimeout(timer); resolve({ ok: false, error: e.message, stdout: stdout, stderr: stderr }); });
    child.on('close', function (code) {
      clearTimeout(timer);
      resolve({ ok: true, code: code, killed: killed, timedOut: timedOut, stdout: stdout, stderr: stderr });
    });
    if (opts.input != null) { try { child.stdin.end(opts.input); } catch (_) {} } else { try { child.stdin.end(); } catch (_) {} }
  });
}

/** 编译 + 运行单个用例 */
async function runCase(caseDir) {
  const id = path.basename(caseDir);
  const mainSrc = path.join(caseDir, 'Main.java');
  const inputPath = path.join(caseDir, 'input.txt');
  const expectedPath = path.join(caseDir, 'expected.txt');
  const metaPath = path.join(caseDir, 'meta.json');
  if (!fs.existsSync(mainSrc)) return { id: id, status: 'SKIP', reason: 'Main.java 不存在' };
  const meta = fs.existsSync(metaPath) ? JSON.parse(readText(metaPath)) : {};
  const input = fs.existsSync(inputPath) ? readText(inputPath) : '';
  const expected = fs.existsSync(expectedPath) ? readText(expectedPath).trim() : '';
  // javac
  const javacR = await runProc('javac', ['-J-Xms1024M', '-J-Xmx1024M', '-encoding', 'UTF-8', 'Main.java'], {
    cwd: caseDir, timeoutMs: 20000
  });
  if (!javacR.ok || javacR.code !== 0) {
    return {
      id: id, status: meta.expectedVerdict === 'CE' ? 'PASS' : 'FAIL',
      verdict: 'CE', stage: 'compile', stderr: (javacR.stderr || '').slice(0, 500), expected: meta.expectedVerdict || 'AC'
    };
  }
  // java
  const javaR = await runProc('java', ['-Dfile.encoding=UTF-8', '-XX:+UseSerialGC', '-Xss64M', '-Xms32M', '-Xmx192M', '-cp', '.', 'Main'], {
    cwd: caseDir, timeoutMs: 3000, input: input
  });
  if (javaR.timedOut) {
    return {
      id: id, status: meta.expectedVerdict === 'TLE' ? 'PASS' : 'FAIL',
      verdict: 'TLE', expected: meta.expectedVerdict || 'AC'
    };
  }
  if (!javaR.ok || javaR.code !== 0) {
    return {
      id: id, status: meta.expectedVerdict === 'RE' ? 'PASS' : 'FAIL',
      verdict: 'RE', code: javaR.code, stderr: (javaR.stderr || '').slice(0, 500), expected: meta.expectedVerdict || 'AC'
    };
  }
  const actual = javaR.stdout.replace(/\r\n/g, '\n').split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n').replace(/^\s+|\s+$/g, '');
  const pass = actual === expected;
  return {
    id: id,
    status: pass ? 'PASS' : 'FAIL',
    verdict: pass ? 'AC' : 'WA',
    stdoutBytes: javaR.stdout.length,
    stderrBytes: javaR.stderr.length,
    expected: meta.expectedVerdict || 'AC',
    actual: actual.slice(0, 200)
  };
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const caseIdx = args.indexOf('--case');
  const caseName = caseIdx >= 0 ? args[caseIdx + 1] : null;
  if (!fs.existsSync(CORPUS)) {
    console.error('corpus 目录不存在：' + CORPUS);
    process.exit(1);
  }
  let cases = fs.readdirSync(CORPUS).filter(function (d) {
    const full = path.join(CORPUS, d);
    return fs.statSync(full).isDirectory();
  });
  if (caseName) cases = cases.filter(function (d) { return d === caseName; });
  if (!cases.length) { console.log('没有匹配的 case'); return; }
  console.log('开始运行 Java 21 Official Judge 测试（共 ' + cases.length + ' 个用例）...');
  console.log('Java: ' + (process.env.JAVA_BIN || 'java'));
  console.log('---');
  const results = [];
  let passed = 0, failed = 0, skipped = 0;
  for (const c of cases) {
    const r = await runCase(path.join(CORPUS, c));
    results.push(r);
    if (r.status === 'PASS') { passed++; console.log('  ✓ ' + r.id + '  ' + r.verdict + (r.expected && r.expected !== r.verdict ? ' (expected=' + r.expected + ')' : '')); }
    else if (r.status === 'SKIP') { skipped++; console.log('  ⊘ ' + r.id + '  SKIP: ' + r.reason); }
    else { failed++; console.log('  ✗ ' + r.id + '  ' + r.verdict + ' (expected=' + r.expected + ')'); }
  }
  console.log('---');
  console.log('Passed: ' + passed + ' / ' + (passed + failed) + '  Skipped: ' + skipped + '  Failed: ' + failed);
  const outDir = path.join(ROOT, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'server-' + Date.now() + '.json'), JSON.stringify({ results: results, summary: { passed: passed, failed: failed, skipped: skipped } }, null, 2));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(2); });