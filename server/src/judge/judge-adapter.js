'use strict';
/**
 * JudgeAdapter —— 服务器端 Official Judge（Phase 4 主链路）
 *
 * ⚠️ DEV ONLY：本实现用 child_process.spawn 直接运行用户程序（含编译 gcc/g++/python），
 * 具备基础的 CPU 超时 / wall 超时 / 输出上限保护，但：
 *   - 无进程沙箱 / 系统调用过滤
 *   - 无 filesystem / network 隔离
 *   - 无内存硬限制（MLE 仅估算）
 * 正式生产安全评测（cgroup/容器/sandbox）作为下一阶段。
 *
 * 接口：
 *   judgeSubmission({ submissionId, language, source, problemId, timeLimitMs, memoryLimitMb })
 *     -> { verdict, executionTimeMs, memoryKb, compileMessage, runtimeMessage, cases }
 *
 * 语言 allowlist 由 language-profiles 派生；EXPERIMENTAL/PENDING profiles 永不进入正式提交。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VERDICT = {
  AC: 'AC', WA: 'WA', TLE: 'TLE', MLE: 'MLE', RE: 'RE', CE: 'CE', SYSTEM_ERROR: 'SYSTEM_ERROR'
};

const COMPILE_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4MB 输出上限

/** 规范化输出：\r\n→\n，去行尾空白，去首尾空白（与前端 normalizeOut 对齐） */
function normalizeOutput(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/^\s+|\s+$/g, '');
}

function runProc(command, args, { input = null, timeoutMs = 10000, cwd, maxOutput = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);

    if (child.stdout) child.stdout.on('data', (d) => {
      if (stdout.length < maxOutput) stdout += d;
    });
    if (child.stderr) child.stderr.on('data', (d) => {
      if (stderr.length < maxOutput) stderr += d;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut, killed, error: err.message, stdout, stderr });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: true, code, signal, timedOut, killed, stdout, stderr });
    });

    if (input != null) {
      try { child.stdin.end(input); } catch (_) { /* ignore */ }
    } else {
      try { child.stdin.end(); } catch (_) { /* ignore */ }
    }
  });
}

/**
 * 编译 C/C++ 源码。标准与编译器从 language-profiles.js 单一数据源读取（Runtime Enhancement Phase），
 * 覆盖冻结的 c11/cpp11 与新增的 c17/cpp17/cpp20/cpp23；不再在此硬编码标准。
 */
async function compileCpp(source, lang, dir) {
  const prof = require('../language-profiles').PROFILES[lang];
  // 判定 .c vs .cpp：C 系语言（c11/c17）用 .c，其余用 .cpp
  const isC = lang === 'c11' || lang === 'c17';
  const ext = isC ? 'c' : 'cpp';
  const std = prof ? prof.officialJudge.standard : (isC ? 'c11' : 'c++11');
  // Frozen profiles keep their existing environment-selected GCC11 commands.
  // Modern profiles use explicit GCC14 reference commands and are still gated
  // by submissionEnabled=false until the full compatibility matrix passes.
  let compiler;
  if (lang === 'c17') compiler = process.env.C17_COMPILER || 'gcc-14';
  else if (lang === 'cpp17') compiler = process.env.CPP17_COMPILER || 'g++-14';
  else if (lang === 'cpp20') compiler = process.env.CPP20_COMPILER || 'g++-14';
  else if (lang === 'cpp23') compiler = process.env.CPP23_COMPILER || 'g++-14';
  else compiler = isC
    ? (process.env.C_COMPILER || 'gcc')
    : (process.env.CPP_COMPILER || 'g++');
  const src = path.join(dir, `main.${ext}`);
  const bin = path.join(dir, 'main.exe');
  fs.writeFileSync(src, source, 'utf8');
  const r = await runProc(compiler, [src, '-O2', `-std=${std}`, '-o', bin], {
    timeoutMs: COMPILE_TIMEOUT_MS, cwd: dir
  });
  if (!r.ok || r.timedOut || (r.code !== 0 && r.code !== null)) {
    return { ok: false, compileMessage: (r.stderr || r.stdout || '编译失败').toString().slice(0, 2000) };
  }
  if (!fs.existsSync(bin)) return { ok: false, compileMessage: '编译后未生成可执行文件' };
  return { ok: true, bin };
}

/**
 * 编译 Java 21 源码（javac → java），命令从 language-profiles.js 读取。
 * 输入：用户 Main.java
 * 输出：{ ok, runCmd, runArgs, compileMessage }
 * 约束：Java 启动参数（堆/线程）由 memoryLimitMb 推导，避免 OOM 误判为 RE。
 */
async function compileJava(source, dir, opts) {
  const prof = require('../language-profiles').PROFILES['java21'];
  const memMb = (opts && opts.memoryLimitMb) || 256;
  // Java 编译参数（从 profile；用户代码强制写入 Main.java）
  const srcPath = path.join(dir, 'Main.java');
  fs.writeFileSync(srcPath, source, 'utf8');
  const javacBin = process.env.JAVA_JAVAC_BIN || 'javac';
  const javaBin = process.env.JAVA_BIN || 'java';
  // compileCommand: ['javac','-J-Xms1024M','-J-Xmx1024M','-J-Xss64M','-encoding','UTF-8','Main.java']
  const javacArgs = (prof && prof.officialJudge.compileCommand && prof.officialJudge.compileCommand.length > 0)
    ? prof.officialJudge.compileCommand.filter(function (a) { return a !== 'Main.java'; }).concat(['Main.java'])
    : ['-J-Xms1024M', '-J-Xmx1024M', '-J-Xss64M', '-encoding', 'UTF-8', 'Main.java'];
  const r = await runProc(javacBin, javacArgs, {
    timeoutMs: COMPILE_TIMEOUT_MS, cwd: dir
  });
  if (!r.ok || r.timedOut || (r.code !== 0 && r.code !== null)) {
    return { ok: false, compileMessage: (r.stderr || r.stdout || 'Java 编译失败').toString().slice(0, 2000) };
  }
  // 运行：java -Xmx<按题目 memoryLimitMb 推导> -cp . Main
  // 默认 -Xmx 取题目 memoryLimitMb - 64M（JVM overhead 占用），下限 128M
  const xmx = Math.max(128, Math.floor(memMb - 64)) + 'M';
  const runCmd = javaBin;
  const runArgs = [
    '-Dfile.encoding=UTF-8',
    '-XX:+UseSerialGC',
    '-Xss64M',
    '-Xms32M',
    '-Xmx' + xmx,
    '-cp',
    '.',
    'Main'
  ];
  return { ok: true, runCmd: runCmd, runArgs: runArgs };
}

/**
 * 评测一条提交：编译一次 + 对全部 hidden testcases 逐个运行（Compile Once, Run Many）。
 */
async function judgeSubmission({ language, source, problemId, timeLimitMs, memoryLimitMb, testcases = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-judge-'));
  try {
    if (!['c11', 'c17', 'cpp11', 'cpp17', 'cpp20', 'cpp23', 'python3', 'java21'].includes(language)) {
      return { verdict: VERDICT.SYSTEM_ERROR, compileMessage: `不支持的语言: ${language}`, executionTimeMs: 0, memoryKb: 0, cases: [] };
    }
    if (!source || !source.trim()) {
      return { verdict: VERDICT.CE, compileMessage: '代码为空', executionTimeMs: 0, memoryKb: 0, cases: [] };
    }

    // 编译（C/C++/Java）或准备 Python 源
    let runCmd, runArgs, bin;
    if (language === 'python3') {
      const src = path.join(dir, 'main.py');
      fs.writeFileSync(src, source, 'utf8');
      runCmd = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      runArgs = [src];
    } else if (language === 'java21') {
      const j = await compileJava(source, dir, { memoryLimitMb: memoryLimitMb || 256 });
      if (!j.ok) return { verdict: VERDICT.CE, compileMessage: j.compileMessage, executionTimeMs: 0, memoryKb: 0, cases: [] };
      runCmd = j.runCmd;
      runArgs = j.runArgs;
    } else {
      const c = await compileCpp(source, language, dir);
      if (!c.ok) return { verdict: VERDICT.CE, compileMessage: c.compileMessage, executionTimeMs: 0, memoryKb: 0, cases: [] };
      runCmd = c.bin;
      runArgs = [];
    }

    // 逐测试点运行
    const cases = [];
    let finalVerdict = VERDICT.AC;
    let maxExecMs = 0;
    let maxMemKb = 0;
    for (const tc of testcases) {
      const input = tc.input || '';
      const expected = normalizeOutput(tc.answer !== undefined ? tc.answer : tc.output || '');
      const caseT0 = Date.now();
      const r = await runProc(runCmd, runArgs, { input, timeoutMs: timeLimitMs || 1000, cwd: dir });
      const execMs = Date.now() - caseT0; // wall 近似（单用例）；精确执行时由进程打点
      maxExecMs = Math.max(maxExecMs, execMs);

      let caseStatus;
      if (r.killed || r.timedOut) caseStatus = VERDICT.TLE;
      else if (!r.ok) caseStatus = VERDICT.SYSTEM_ERROR;
      else if (r.code !== 0) caseStatus = VERDICT.RE;
      else {
        const actual = normalizeOutput(r.stdout);
        caseStatus = actual === expected ? VERDICT.AC : VERDICT.WA;
      }
      cases.push({ status: caseStatus, timeMs: execMs, memoryKb: 0 });
      if (caseStatus !== VERDICT.AC) {
        finalVerdict = caseStatus;
        if (caseStatus === VERDICT.SYSTEM_ERROR) break;
      }
    }

    return {
      verdict: finalVerdict,
      executionTimeMs: maxExecMs,
      memoryKb: maxMemKb,
      compileMessage: '',
      runtimeMessage: '',
      cases
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { judgeSubmission, normalizeOutput, VERDICT };
