'use strict';
/**
 * JudgeAdapter —— 服务器端 Official Judge（Phase 4 主链路）
 *
 * 每个编译器/用户程序都必须经 judge/sandbox.js 启动：生产使用
 * systemd transient unit 提供 cgroup、私有网络、只读系统文件、syscall
 * 过滤和非特权用户隔离。没有可用 sandbox 时 fail closed，不回退到裸
 * child_process.spawn。仅显式 JUDGE_SANDBOX_MODE=direct-test 的本地测试
 * 可使用测试适配器。
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
const {
  getSandboxStatus,
  prepareWorkDir,
  runSandboxed
} = require('./sandbox');

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

function runProc(command, args, {
  input = null,
  timeoutMs = 10000,
  cwd,
  maxOutput = MAX_OUTPUT_BYTES,
  memoryLimitMb,
  maxProcesses
} = {}) {
  return runSandboxed(command, args, {
    input,
    timeoutMs,
    cwd,
    maxOutput,
    memoryLimitMb,
    maxProcesses
  });
}

function resolveCommandPath(command) {
  if (path.isAbsolute(command)) return command;
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* try next PATH entry */ }
  }
  return command;
}

/**
 * 编译 C/C++ 源码。标准与编译器从 language-profiles.js 单一数据源读取（Runtime Enhancement Phase），
 * 覆盖冻结的 c11/cpp11 与新增的 c17/cpp17/cpp20/cpp23；不再在此硬编码标准。
 */
async function compileCpp(source, lang, dir, opts = {}) {
  const prof = require('../language-profiles').PROFILES[lang];
  // 判定 .c vs .cpp：C 系语言（c11/c17）用 .c，其余用 .cpp
  const isC = lang === 'c11' || lang === 'c17';
  const ext = isC ? 'c' : 'cpp';
  // Frozen profiles keep their existing environment-selected GCC11 commands.
  // Modern profiles use explicit GCC14 reference commands and are still gated
  // by submissionEnabled=false until the full compatibility matrix passes.
  let compiler;
  let compileArgs;
  const modern = lang === 'c17' || lang === 'cpp17';
  if (modern) {
    const command = prof && prof.officialJudge && prof.officialJudge.compileCommand;
    if (!Array.isArray(command) || !command.length) {
      return { ok: false, compileMessage: `缺少 ${lang} Language Profile compileCommand` };
    }
    compiler = resolveCommandPath(command[0]);
    const requiredCompiler = lang === 'c17' ? 'gcc-14' : 'g++-14';
    const requiredCompilerPath = lang === 'c17' ? '/usr/bin/gcc-14' : '/usr/bin/g++-14';
    if (path.basename(compiler) !== requiredCompiler || compiler !== requiredCompilerPath) {
      return {
        ok: false,
        compileMessage: `${lang} 禁止 compiler fallback：expected ${requiredCompilerPath}, got ${compiler}`
      };
    }
  } else compiler = isC
    ? (process.env.C_COMPILER || 'gcc')
    : (process.env.CPP_COMPILER || 'g++');
  const src = path.join(dir, `main.${ext}`);
  const bin = path.join(dir, 'main.exe');
  fs.writeFileSync(src, source, 'utf8');
  let compilerEvidence = null;
  if (modern) {
    compileArgs = prof.officialJudge.compileCommand.slice(1).map((arg) => {
      if (arg === '<src>') return src;
      if (arg === '<out>') return bin;
      return arg;
    });
    const versionProbe = await runProc(compiler, ['--version'], {
      timeoutMs: 5000,
      cwd: dir,
      memoryLimitMb: Math.max(512, Number(opts.memoryLimitMb) || 256)
    });
    compilerEvidence = {
      compilerPath: compiler,
      compilerVersion: versionProbe.ok && !versionProbe.timedOut
        ? String(versionProbe.stdout || versionProbe.stderr || '').split(/\r?\n/, 1)[0]
        : 'VERSION_PROBE_FAILED',
      standard: prof.officialJudge.standard,
      optimization: prof.officialJudge.compileCommand.includes('-O2') ? '-O2' : null
    };
  } else {
    const std = prof ? prof.officialJudge.standard : (isC ? 'c11' : 'c++11');
    compileArgs = [src, '-O2', `-std=${std}`, '-o', bin];
  }
  const r = await runProc(compiler, compileArgs, {
    timeoutMs: COMPILE_TIMEOUT_MS,
    cwd: dir,
    memoryLimitMb: Math.max(512, Number(opts.memoryLimitMb) || 256)
  });
  if (r.sandboxUnavailable) {
    return {
      ok: false,
      sandboxUnavailable: true,
      compileMessage: r.error || 'Judge sandbox unavailable',
      compilerEvidence
    };
  }
  if (!r.ok || r.timedOut || (r.code !== 0 && r.code !== null)) {
    return { ok: false, compileMessage: (r.stderr || r.stdout || '编译失败').toString().slice(0, 2000), compilerEvidence };
  }
  if (!fs.existsSync(bin)) return { ok: false, compileMessage: '编译后未生成可执行文件', compilerEvidence };
  return { ok: true, bin, compilerEvidence };
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
    ? prof.officialJudge.compileCommand.slice(1).filter(function (a) { return a !== 'Main.java'; }).concat(['Main.java'])
    : ['-J-Xms1024M', '-J-Xmx1024M', '-J-Xss64M', '-encoding', 'UTF-8', 'Main.java'];
  const r = await runProc(javacBin, javacArgs, {
    timeoutMs: COMPILE_TIMEOUT_MS,
    cwd: dir,
    // The frozen profile intentionally reserves a 1024M javac heap.  Keep
    // compilation bounded while leaving room for the JVM/native compiler
    // overhead; the submitted program gets its own tighter run limit below.
    memoryLimitMb: Math.max(1280, memMb + 256)
  });
  if (r.sandboxUnavailable) {
    return { ok: false, sandboxUnavailable: true, compileMessage: r.error || 'Judge sandbox unavailable' };
  }
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
  const sandboxStatus = getSandboxStatus();
  if (!sandboxStatus.available) {
    return {
      verdict: VERDICT.SYSTEM_ERROR,
      compileMessage: '',
      runtimeMessage: `Judge sandbox unavailable: ${sandboxStatus.reason}`,
      executionTimeMs: 0,
      memoryKb: 0,
      cases: []
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-judge-'));
  const prepared = prepareWorkDir(dir);
  if (!prepared.ok) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    return {
      verdict: VERDICT.SYSTEM_ERROR,
      compileMessage: '',
      runtimeMessage: `Judge sandbox unavailable: ${prepared.error}`,
      executionTimeMs: 0,
      memoryKb: 0,
      cases: []
    };
  }
  try {
    if (!['c11', 'c17', 'cpp11', 'cpp17', 'python3', 'java21'].includes(language)) {
      return { verdict: VERDICT.SYSTEM_ERROR, compileMessage: `不支持的语言: ${language}`, executionTimeMs: 0, memoryKb: 0, cases: [] };
    }
    if (!source || !source.trim()) {
      return { verdict: VERDICT.CE, compileMessage: '代码为空', executionTimeMs: 0, memoryKb: 0, cases: [] };
    }

    // 编译（C/C++/Java）或准备 Python 源
    let runCmd, runArgs, bin, compilerEvidence = null;
    if (language === 'python3') {
      const src = path.join(dir, 'main.py');
      fs.writeFileSync(src, source, 'utf8');
      runCmd = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
      runArgs = [src];
    } else if (language === 'java21') {
      const j = await compileJava(source, dir, { memoryLimitMb: memoryLimitMb || 256 });
      if (!j.ok) {
        return {
          verdict: j.sandboxUnavailable ? VERDICT.SYSTEM_ERROR : VERDICT.CE,
          compileMessage: j.compileMessage,
          runtimeMessage: j.sandboxUnavailable ? j.compileMessage : '',
          executionTimeMs: 0,
          memoryKb: 0,
          cases: []
        };
      }
      runCmd = j.runCmd;
      runArgs = j.runArgs;
    } else {
      const c = await compileCpp(source, language, dir, { memoryLimitMb: memoryLimitMb || 256 });
      compilerEvidence = c.compilerEvidence || null;
      if (!c.ok) {
        return {
          verdict: c.sandboxUnavailable ? VERDICT.SYSTEM_ERROR : VERDICT.CE,
          compileMessage: c.compileMessage,
          runtimeMessage: c.sandboxUnavailable ? c.compileMessage : '',
          executionTimeMs: 0,
          memoryKb: 0,
          cases: [],
          compilerEvidence
        };
      }
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
      const r = await runProc(runCmd, runArgs, {
        input,
        timeoutMs: timeLimitMs || 1000,
        cwd: dir,
        memoryLimitMb: memoryLimitMb || 256
      });
      const execMs = Date.now() - caseT0; // wall 近似（单用例）；精确执行时由进程打点
      maxExecMs = Math.max(maxExecMs, execMs);

      let caseStatus;
      if (r.sandboxUnavailable) caseStatus = VERDICT.SYSTEM_ERROR;
      else if (r.killed || r.timedOut) caseStatus = VERDICT.TLE;
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
      cases,
      compilerEvidence
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { judgeSubmission, normalizeOutput, VERDICT };
