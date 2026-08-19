/* ============================================================
 * OJCompiler / Exec WASI Web Worker（Module Worker）
 *
 * 角色一：Persistent Compiler Worker（init-compiler + compile）
 *   - clang.wasm / wasm-ld.wasm 的 WebAssembly.Module 常驻本 Worker（只编译一次）
 *   - VFS/Sysroot（解包后的 clang-fs）常驻本 Worker，跨编译复用（含 /bits.pch）
 *   - 每次编译：复用 Module 新建干净 Instance（fresh memory），VFS 沿用
 *   - compile 与 link 在同一 Worker 内顺序完成，/program.o 不出 VFS，无中间文件复制
 *
 * 角色二：Exec Worker（run，每次运行新建本 Worker 保证干净状态）
 *   - 接收主线程缓存的 WebAssembly.Module（或 bytes）+ stdin SharedArrayBuffer
 *   - 精确分段：wasmCompile / instantiate / execution
 *   - executionMs = wasi.start() 前后打点（instance 就绪、stdin 已在 SAB 中就位 →
 *     用户 main() 执行 → 程序退出），stdout/stderr 在 Worker 内缓冲、随结果一次性回传，
 *     计时区间内零 IPC —— executionMs 即纯用户程序运行时间
 * ============================================================ */
import { WASI } from '/js/runno/runno-wasi.js';

/* ---------------- stdin：与 Runno 内嵌 Worker 完全一致的 SAB 协议 ---------------- */
function makeStdinReader(stdinBuffer) {
  return function readStdin(n) {
    Atomics.wait(new Int32Array(stdinBuffer), 0, 0);
    const dv = new DataView(stdinBuffer);
    const len = dv.getInt32(0);
    if (len < 0) { dv.setInt32(0, 0); return null; } // EOF
    const bytes = new Uint8Array(stdinBuffer, 4, len);
    const text = new TextDecoder().decode(bytes.slice(0, n));
    const rest = bytes.slice(n);
    dv.setInt32(0, rest.byteLength);
    new Uint8Array(stdinBuffer, 4).set(rest);
    return text;
  };
}

function post(msg, transfer) {
  postMessage(msg, transfer || []);
}

/* ---------------- 编译参数（与 Runno 内建 clang/clangpp runtime 一致，-ftime-report 供前后端拆分） ---------------- */
function cc1Args(lang, optLevel, pchLevel) {
  // wasm32 target features：matomics 使 Clang 后端能 codegen 原子指令（std::atomic/shared_ptr 引用计数/regex 内部原子依赖）。
  // mutable-globals/sign-ext 为 wasm 常用配套。注意：开启原子后链接需 --shared-memory，见 lldArgs 注释。
  const common = ['-Werror', '-isysroot', '/sys',
    '-ferror-limit', '4', '-fmessage-length', '80', '-fcolor-diagnostics', '-ftime-report'];
  if (lang === 'c') {
    return ['clang', '-cc1'].concat(common, [
      '-triple', 'wasm32-unkown-wasi',
      '-internal-isystem', '/sys/include',
      '-internal-isystem', '/sys/lib/clang/8.0.1/include',
      optLevel, '-emit-obj', '-o', '/program.o', '/program']);
  }
  const args = ['clang', '-cc1'].concat(common, [
    '-emit-obj', '-disable-free',
    '-internal-isystem', '/sys/include/c++/v1',
    '-internal-isystem', '/sys/include',
    '-internal-isystem', '/sys/lib/clang/8.0.1/include',
    optLevel, '-o', '/program.o']);
  if (pchLevel && pchLevel !== 'none') {
    const t = pchTarget(pchLevel);
    args.push('-include-pch', t.pchPath);
  }
  args.push('-x', 'c++', '/program');
  return args;
}

/* PCH 层级：bits 全量 / iostream 常用。产物路径 + 头文件均按层级参数化。 */
function pchTarget(level) {
  return level === 'iostream'
    ? { pchPath: '/iostream.pch', header: '/sys/include/c++/v1/iostream', out: '/iostream.pch' }
    : { pchPath: '/bits.pch', header: '/sys/include/bits/stdc++.h', out: '/bits.pch' };
}
function pchGenArgs(optLevel, level) {
  const t = pchTarget(level);
  // 生成 PCH 时不加 -Werror：iostream 等系统头内 #pragma GCC system_header
  // 在作为 PCH 主文件时会告警，若升级为错误将导致生成失败。
  return ['clang', '-cc1', '-emit-pch', '-disable-free',
    '-isysroot', '/sys',
    '-internal-isystem', '/sys/include/c++/v1',
    '-internal-isystem', '/sys/include',
    '-internal-isystem', '/sys/lib/clang/8.0.1/include',
    '-ferror-limit', '4', '-fmessage-length', '80', '-fcolor-diagnostics',
    optLevel, '-o', t.out, '-x', 'c++-header', t.header];
}

function lldArgs(lang) {
  const args = ['wasm-ld', '--no-threads', '--export-dynamic', '-z', 'stack-size=1048576',
    '-L/sys/lib/wasm32-wasi', '/sys/lib/wasm32-wasi/crt1.o', '/program.o', '-lc',
    // compiler-rt builtins：提供 __lttf2/__eqtf2/__addtf3 等 fp128 soft-float 与原子/软浮点辅助。
    // 不链接此库会导致 std::sort 报 undefined __lttf2。
    '-L/sys/lib/clang/8.0.1/lib/wasi', '-lclang_rt.builtins-wasm32'];
  if (lang !== 'c') args.push('-lc++', '-lc++abi');
  args.push('-o', '/program.wasm');
  return args;
  if (lang !== 'c') args.push('-lc++', '-lc++abi');
  args.push('-o', '/program.wasm');
  return args;
}

/* ---------------- 在 VFS 上执行一次 WASI 命令（clang/lld，实例新建、Module 复用） ---------------- */
async function runCommand(module, args, vfs) {
  let stdout = '';
  let stderr = '';
  const wasi = new WASI({
    fs: vfs, args: args, env: {},
    stdout: function (s) { stdout += s; },
    stderr: function (s) { stderr += s; }
  });
  const tI0 = performance.now();
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const instantiateMs = performance.now() - tI0;
  const tR0 = performance.now();
  const result = wasi.start({ instance: instance, module: module });
  const runMs = performance.now() - tR0;
  return { exitCode: result.exitCode, fs: result.fs, stdout: stdout, stderr: stderr, instantiateMs: instantiateMs, runMs: runMs };
}

/* ---------------- -ftime-report 解析 ----------------
 * 报表结构：Miscellaneous Ungrouped Timers 下以命名行给出组耗时，如
 *   "0.0840 ( 60.9%)  0.0840 ( 60.9%)  0.0840 ( 59.2%)  Code Generation Time"
 * 后端 = LLVM IR Generation Time + Code Generation Time 两行 Wall Time；
 * 前端（preprocess/header parse + sema）= compileMs - 后端（推导值）。
 */
function parseFtimeReport(stderr, compileMs) {
  const rowRe = /^\s*((?:[\d.]+\s*\(\s*[\d.]+%\)\s*)+)(LLVM IR Generation Time|Code Generation Time)\s*$/;
  const timeRe = /([\d.]+)\s*\(/g; // 紧跟 '(' 的数字是时间列（括号内是百分比）
  let backend = 0;
  let found = false;
  const lines = stderr.split('\n');
  for (const line of lines) {
    const m = line.match(rowRe);
    if (!m) continue;
    timeRe.lastIndex = 0;
    let nums = [], nm;
    while ((nm = timeRe.exec(m[1]))) nums.push(parseFloat(nm[1]));
    if (!nums.length) continue;
    found = true;
    backend += nums[nums.length - 1] * 1000; // 最后一列 = Wall Time（秒 → ms）
  }
  if (!found) return null;
  const backendMs = Math.round(backend);
  return { frontendMs: Math.max(0, Math.round(compileMs - backend)), backendMs: backendMs };
}

/* 去掉 stderr 里的 -ftime-report 报表块（防止污染用户可见的编译错误输出） */
function stripFtimeReport(stderr) {
  const i = stderr.search(/^={5,}/m);
  return i >= 0 ? stderr.slice(0, i) : stderr;
}

/* ---------------- Compiler Worker 状态（常驻） ---------------- */
const compiler = {
  vfs: null,
  clangModule: null,
  lldModule: null,
  pchReady: {} // "optLevel|pchLevel" -> bool（对应 pchPath 已在 vfs 中）
};

async function initCompiler(msg) {
  const t0 = performance.now();
  compiler.vfs = msg.fs;
  const [c, l] = await Promise.all([
    fetch(msg.clangUrl).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return WebAssembly.compile(b); }),
    fetch(msg.lldUrl).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return WebAssembly.compile(b); })
  ]);
  compiler.clangModule = c;
  compiler.lldModule = l;
  const totalMs = Math.round(performance.now() - t0);
  post({ type: 'inited', moduleInitMs: totalMs });
}

async function doCompile(msg) {
  const timing = {
    clangInitMs: 0, pchMs: 0, compileMs: 0, linkMs: 0,
    frontendMs: null, backendMs: null, pchUsed: false
  };
  const lang = msg.lang === 'c' ? 'c' : 'cpp';
  const vfs = compiler.vfs;
  // 清理上一次的中间产物，避免误读
  delete vfs['/program.o'];
  delete vfs['/program.wasm'];
  vfs['/program'] = {
    path: 'program', content: msg.code, mode: 'string',
    timestamps: { access: new Date(), modification: new Date(), change: new Date() }
  };

  // PCH：会话级生成一次（产物留在常驻 VFS）。pchLevel: none|iostream|bits
  const pchLevel = (msg.pchLevel && msg.pchLevel !== 'none') ? msg.pchLevel : (lang === 'cpp' && msg.usePch ? 'bits' : 'none');
  const pchKey = msg.optLevel + '|' + pchLevel;
  if (lang === 'cpp' && pchLevel !== 'none' && !compiler.pchReady[pchKey]) {
    const tTarget = pchTarget(pchLevel);
    const p0 = performance.now();
    const pr = await runCommand(compiler.clangModule, pchGenArgs(msg.optLevel, pchLevel), vfs);
    compiler.vfs = pr.fs;
    timing.pchMs = Math.round(performance.now() - p0);
    console.debug('[ide-wasi-worker] PCH 生成', {
      level: pchLevel, pchPath: tTarget.pchPath, exitCode: pr.exitCode,
      exists: !!compiler.vfs[tTarget.pchPath], stderr: (pr.stderr || '').slice(0, 300)
    });
    if (pr.exitCode === 0 && compiler.vfs[tTarget.pchPath]) {
      compiler.pchReady[pchKey] = true;
    } else {
      post({ type: 'pch-failed', stderr: (pr.stderr || '').slice(0, 500) });
    }
  }
  const wantPch = lang === 'cpp' && pchLevel !== 'none' && !!compiler.pchReady[pchKey];
  timing.pchUsed = wantPch;
  timing.pchLevel = pchLevel;

  // 编译（clang -cc1，Module 复用 + 干净实例）
  const c = await runCommand(compiler.clangModule, cc1Args(lang, msg.optLevel, wantPch ? pchLevel : null), compiler.vfs);
  compiler.vfs = c.fs;
  timing.clangInitMs = Math.round(c.instantiateMs);
  timing.compileMs = Math.round(c.runMs);
  const report = parseFtimeReport(c.stderr, c.runMs);
  if (report) { timing.frontendMs = report.frontendMs; timing.backendMs = report.backendMs; }
  const cleanStderr = stripFtimeReport(c.stderr);
  if (c.exitCode !== 0) {
    post({ type: 'compile-result', ok: false, stage: 'compile', stderr: cleanStderr, stdout: c.stdout, exitCode: c.exitCode, timing: timing });
    return;
  }

  // 链接（wasm-ld，同一 VFS，/program.o 不出 Worker）
  const l = await runCommand(compiler.lldModule, lldArgs(lang), compiler.vfs);
  compiler.vfs = l.fs;
  timing.linkMs = Math.round(l.runMs);
  const out = compiler.vfs['/program.wasm'];
  if (l.exitCode !== 0 || !out || !out.content) {
    post({ type: 'compile-result', ok: false, stage: 'link', stderr: stripFtimeReport(l.stderr) || '链接失败', stdout: '', exitCode: l.exitCode, timing: timing });
    return;
  }
  const bytes = out.content instanceof Uint8Array ? out.content : new TextEncoder().encode(out.content);
  post({ type: 'compile-result', ok: true, bytes: bytes, timing: timing }, [bytes.buffer]);
}

/* ---------------- Exec：干净实例运行已编译 artifact ---------------- */
async function doRun(msg) {
  const timing = { wasmCompileMs: 0, instantiateMs: 0, executionMs: 0 };
  let stdout = '';
  let stderr = '';
  try {
    let module = msg.module || null;
    if (!module) {
      const tC0 = performance.now();
      module = await WebAssembly.compile(msg.bytes);
      timing.wasmCompileMs = Math.round((performance.now() - tC0) * 10) / 10;
    }
    const wasi = new WASI({
      fs: msg.fs || {}, args: msg.args || [], env: msg.env || {},
      stdin: makeStdinReader(msg.stdinBuffer),
      stdout: function (s) { stdout += s; },
      stderr: function (s) { stderr += s; }
    });
    const tI0 = performance.now();
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    timing.instantiateMs = Math.round((performance.now() - tI0) * 10) / 10;

    // —— Execution Time 精确边界：instance 就绪、stdin 已在 SAB 就位，_start() 起止即用户程序运行 ——
    const tE0 = performance.now();
    const result = wasi.start({ instance: instance, module: module });
    timing.executionMs = Math.round((performance.now() - tE0) * 100) / 100;

    post({ type: 'run-result', ok: true, exitCode: result.exitCode, stdout: stdout, stderr: stderr, timing: timing });
  } catch (e) {
    post({
      type: 'run-result', ok: false, exitCode: -1, stdout: stdout, stderr: stderr,
      error: { message: String(e && e.message || e), name: String(e && e.constructor && e.constructor.name || 'Error') },
      timing: timing
    });
  }
}

onmessage = function (e) {
  const msg = e.data;
  if (msg.type === 'init-compiler') {
    initCompiler(msg).catch(function (err) { post({ type: 'init-failed', error: String(err && err.message || err) }); });
  } else if (msg.type === 'compile') {
    doCompile(msg).catch(function (err) { post({ type: 'compile-result', ok: false, stage: 'crash', stderr: '编译器异常：' + String(err && err.message || err), timing: {} }); });
  } else if (msg.type === 'run') {
    doRun(msg);
  }
};
