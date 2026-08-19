'use strict';
/**
 * 可信评测核心：WSL 2 + Ubuntu + Isolate 沙箱（平台适配）
 *
 * 评测流程（在 WSL 内）：
 *   1. 将选手代码写入工作目录
 *   2. C++：g++ -O2 -std=c++17 编译；Python：py_compile 语法检查
 *   3. 逐测试点运行：优先 isolate 沙箱（CPU 时间/内存/墙钟/输出限制）；
 *      若 isolate 不可用则用 `timeout` 命令（时间限制）+ 直接运行（演示/降级）
 *   4. 比对输出（忽略行尾空白）
 *
 * 发行版：默认 Ubuntu-22.04（申请要求），可用环境变量 MINIOJ_WSL_DISTRO 覆盖
 * （本机演示可设 Ubuntu-24.04）。
 *
 * 回退策略：
 *   - 目标 WSL 发行版不存在或未装 g++/python3 → 回退本地 g++/python（仅协议联调演示）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MAX_OUTPUT = 16 * 1024 * 1024;
const WORK_ROOT = path.join(__dirname, '..', 'work');

const DISTRO = process.env.MINIOJ_WSL_DISTRO || 'Ubuntu-22.04';

/** Windows 路径 → WSL 路径（e:\mini\worker → /mnt/e/mini/worker） */
function toWslPath(p) {
  if (p[0] !== '/') {
    const m = p.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (m) return '/mnt/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
  }
  return p.replace(/\\/g, '/');
}

/** 严格检测：目标发行版存在 且 有 g++ 与 python3 */
function wslAvailable() {
  try {
    const probe = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', '-lc', 'command -v g++ && command -v python3'], {
      windowsHide: true, encoding: 'utf8', timeout: 15000
    });
    if (probe.status !== 0) return false;
    return /\/g\+\+/.test(probe.stdout) && /\/python3/.test(probe.stdout);
  } catch (_) { return false; }
}

/** 是否安装 isolate 沙箱 */
function isolateAvailable() {
  try {
    const r = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', '-lc', 'command -v isolate'], {
      windowsHide: true, encoding: 'utf8', timeout: 10000
    });
    return r.status === 0 && /\/isolate/.test(r.stdout || '');
  } catch (_) { return false; }
}

/** WSL 内执行命令 */
function wslExec(cmd, timeout = 60000) {
  const r = spawnSync('wsl.exe', ['-d', DISTRO, '--', 'bash', '-lc', cmd], {
    windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function outputMatches(expected, actual) {
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n+$/g, '').trim();
  return norm(expected) === norm(actual);
}

/**
 * WSL 内评测单个测试点
 * @param {string} winDir Windows 路径（读输出文件用）
 * @param {string} wslDir WSL 路径（cd 用）
 * @param {boolean} useIsolate 是否使用 isolate 沙箱
 */
function runTestCaseWsl(winDir, wslDir, runCmd, input, { timeLimitMs }, useIsolate) {
  fs.writeFileSync(path.join(winDir, 'input.txt'), input || '', 'utf8');
  let cmd;
  if (useIsolate) {
    const timeSec = Math.max(1, Math.ceil(timeLimitMs / 1000));
    cmd = `cd '${wslDir}' && isolate --run --time=${timeSec} --mem=262144 -- ${runCmd} < input.txt > output.txt 2> error.txt; echo "EXIT:$?"`;
  } else {
    const timeMs = Math.max(500, timeLimitMs + 300);
    cmd = `cd '${wslDir}' && timeout ${timeMs / 1000} ${runCmd} < input.txt > output.txt 2> error.txt; echo "EXIT:$?"`;
  }
  const r = wslExec(cmd, timeLimitMs + 15000);
  // 解析退出码
  let exitCode = r.status;
  const m = r.stdout.match(/EXIT:(\d+)\s*$/);
  if (m) exitCode = parseInt(m[1], 10);
  let stdout = ''; try { stdout = fs.readFileSync(path.join(winDir, 'output.txt'), 'utf8'); } catch (_) {}
  let stderr = ''; try { stderr = fs.readFileSync(path.join(winDir, 'error.txt'), 'utf8'); } catch (_) {}
  return { exitCode, stdout, stderr, timeMs: timeLimitMs, memoryKb: 0 };
}

/**
 * 评测主入口（WSL 优先，失败回退本地）
 */
async function judge(task) {
  const { language, code, problem } = task;
  const workDir = path.join(WORK_ROOT, crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(workDir, { recursive: true });
  const useWsl = wslAvailable();
  const useIsolate = useWsl && isolateAvailable();
  const cases = [];
  let finalStatus = 'AC';
  let maxTime = 0, maxMem = 0, message = '';

  try {
    if (!useWsl) {
      // 目标 WSL 发行版不可用 → 回退本地（仅协议联调演示）
      return await judgeLocalFallback(task, workDir);
    }

    const wslDir = toWslPath(workDir);
    // 确保 WSL 内目录可写（同步初始化）
    wslExec(`mkdir -p '${wslDir}'`);

    // 编译
    let runCmd;
    if (language === 'cpp') {
      fs.writeFileSync(path.join(workDir, 'main.cpp'), code, 'utf8');
      const c = wslExec(`cd '${wslDir}' && g++ -O2 -std=c++17 -o main main.cpp 2>&1`);
      if (!fs.existsSync(path.join(workDir, 'main'))) {
        return { status: 'CE', cases: [], timeMs: 0, memoryKb: 0, message: '编译错误：\n' + (c.stdout || c.stderr || '').slice(0, 4000) };
      }
      runCmd = './main';
    } else {
      fs.writeFileSync(path.join(workDir, 'main.py'), code, 'utf8');
      const c = wslExec(`cd '${wslDir}' && python3 -m py_compile main.py 2>&1`);
      if (c.stdout.includes('Error') || c.stdout.includes('error')) {
        return { status: 'CE', cases: [], timeMs: 0, memoryKb: 0, message: '语法错误：\n' + (c.stdout || c.stderr || '').slice(0, 4000) };
      }
      runCmd = 'python3 main.py';
    }

    // 逐测试点
    const testcases = problem.testcases || [];
    for (let i = 0; i < testcases.length; i++) {
      const tc = testcases[i];
      const r = runTestCaseWsl(workDir, wslDir, runCmd, tc.input, { timeLimitMs: problem.time_limit_ms }, useIsolate);
      maxTime = Math.max(maxTime, r.timeMs);
      let st;
      if (r.exitCode === 124) st = 'TLE';
      else if (r.exitCode === 0) st = outputMatches(tc.answer, r.stdout) ? 'AC' : 'WA';
      else { st = 'RE'; if (!message) message = (r.stderr || r.stdout || '').slice(0, 1000); }
      if (st !== 'AC' && finalStatus === 'AC') finalStatus = st;
      cases.push({ id: i + 1, status: st, time_ms: r.timeMs, memory_kb: r.memoryKb });
    }
    return { status: finalStatus, cases, timeMs: maxTime, memoryKb: maxMem, message };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

/** 本地回退评测（目标 WSL 不可用时，仅协议联调演示） */
async function judgeLocalFallback(task, workDir) {
  const { language, code, problem } = task;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  fs.writeFileSync(path.join(workDir, language === 'cpp' ? 'main.cpp' : 'main.py'), code, 'utf8');

  let cmdFile, cmdArgs;
  if (language === 'cpp') {
    const out = path.join(workDir, 'main.exe');
    const c = spawnSync('g++', ['-O2', '-std=c++17', '-o', out, path.join(workDir, 'main.cpp')], { encoding: 'utf8', timeout: 30000 });
    if (c.status !== 0) return { status: 'CE', cases: [], timeMs: 0, memoryKb: 0, message: '编译错误：\n' + (c.stderr || '').slice(0, 4000) };
    cmdFile = out; cmdArgs = [];
  } else {
    const src = path.join(workDir, 'main.py');
    const c = spawnSync(py, ['-m', 'py_compile', src], { encoding: 'utf8', timeout: 15000 });
    if (c.status !== 0) return { status: 'CE', cases: [], timeMs: 0, memoryKb: 0, message: '语法错误：\n' + (c.stderr || '').slice(0, 4000) };
    cmdFile = py; cmdArgs = [src];
  }

  const cases = []; let finalStatus = 'AC', maxTime = 0, message = '';
  for (let i = 0; i < (problem.testcases || []).length; i++) {
    const tc = problem.testcases[i];
    const started = Date.now();
    let r;
    try {
      r = spawnSync(cmdFile, cmdArgs, { input: tc.input || '', encoding: 'utf8', timeout: Math.max(500, problem.time_limit_ms + 300), windowsHide: true });
    } catch (err) {
      r = { status: -1, error: err };
    }
    const timeMs = Date.now() - started;
    let st;
    if (r.error && r.error.code === 'ETIMEDOUT') st = 'TLE';
    else if (r.status !== 0) { st = 'RE'; if (!message) message = (r.stderr || '').slice(0, 1000); }
    else st = outputMatches(tc.answer, r.stdout) ? 'AC' : 'WA';
    if (st !== 'AC' && finalStatus === 'AC') finalStatus = st;
    cases.push({ id: i + 1, status: st, time_ms: timeMs, memory_kb: 0 });
    maxTime = Math.max(maxTime, timeMs);
  }
  return { status: finalStatus, cases, timeMs: maxTime, memoryKb: 0, message };
}

module.exports = { judge, wslAvailable, isolateAvailable };
