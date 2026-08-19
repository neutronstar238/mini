'use strict';
/**
 * 测试数据生成服务（基于 g++ 编译运行 gen/solution）
 * 契约（与题目编写要求对齐）：
 *  - gen.cpp：编译后运行，在当前工作目录直接生成 test01.in … testNN.in
 *             （参考写法用 freopen("test%02d.in","w",stdout)，组数固定，通常 10 组）
 *  - solution.cpp：编译后，对每个 .in 经 stdin 读入、stdout 输出答案
 *  本服务对每个 .in 运行一次 solution，得到对应 .out，组装成 testcases[{input,answer}]。
 *
 * 规模约束（参考评分标准）：
 *  - 小规模 .in ≤ 100 KB
 *  - 大规模 .in ≤ 2 MB，且大规模组数 ≤ 3
 *
 * 服务器缺少 g++（或编译/运行失败）时返回明确错误，管理端可回退到手动输入 in/out。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SMALL_MAX_BYTES = 100 * 1024; // 100 KB
const LARGE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_LARGE_GROUPS = 3;
const GEN_TIMEOUT_MS = 15000;
const SOL_TIMEOUT_MS = 15000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // solution 输出上限保护

/** 工作目录管理器：确保临时目录存在 */
let workDir = null;
function ensureWorkDir() {
  if (!workDir) workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-oj-testdata-'));
  return workDir;
}

/** 将代码写入文件并返回路径 */
function writeSource(dir, filename, code) {
  const file = path.join(dir, filename);
  fs.writeFileSync(file, code || '', 'utf8');
  return file;
}

/** 编译一个 cpp 源文件，成功返回可执行文件路径，失败抛错 */
function compile(dir, src, bin, compiler = 'g++') {
  return new Promise((resolve, reject) => {
    const out = path.join(dir, bin);
    const srcPath = path.join(dir, src);
    execFile(compiler, [srcPath, '-O2', '-std=c++17', '-o', out], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || '').toString().split('\n').filter(Boolean).slice(-20).join('\n');
        return reject(new Error(`编译 ${bin} 失败（缺少 g++ 或代码有误）：${msg || err.message}`));
      }
      resolve(out);
    });
  });
}

/** 运行可执行文件，注入可选 argv / stdin / cwd，返回 stdout */
function run(bin, { args = [], input = null, cwd = null, timeout = SOL_TIMEOUT_MS, maxOutput = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { timeout, maxBuffer: maxOutput };
    if (cwd) opts.cwd = cwd;
    const proc = execFile(bin, args, opts, (err, stdout, stderr) => {
      if (err) {
        // 超时 / 输出超限也视为运行失败
        return reject(new Error(`运行 ${path.basename(bin)} 失败：${(stderr || err.message).toString().slice(0, 500)}`));
      }
      resolve(stdout || '');
    });
    if (input != null) proc.stdin.end(input);
  });
}

/** 规范化输出：统一去除行尾空白，保留换行结构（与评测端一致性） */
function normalizeOutput(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '\n');
}

/**
 * 由 genCode + solutionCode 生成测试数据
 * @param {string} genCode
 * @param {string} solutionCode
 * @param {object} opts { groups: 期望组数（参考 gen 通常固定 10；缺省按实际生成） }
 * @returns {Promise<{testcases:Array, groups:number, warnings:string[]}>}
 */
async function generateTestcases(genCode, solutionCode, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-oj-td-'));
  const warnings = [];

  // 1) 编译 gen 与 solution
  let genBin, solBin;
  try {
    writeSource(dir, 'gen.cpp', genCode || '');
    writeSource(dir, 'solution.cpp', solutionCode || '');
    genBin = await compile(dir, 'gen.cpp', 'gen.exe');
    solBin = await compile(dir, 'solution.cpp', 'sol.exe');
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  // 2) 运行 gen 生成 testXX.in（gen 会自行 freopen 在当前目录写出文件）
  try {
    await run(genBin, { args: [], cwd: dir, timeout: GEN_TIMEOUT_MS });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  // 3) 收集生成的 .in 文件（按编号排序）
  const inFiles = fs.readdirSync(dir)
    .filter((f) => /^test\d+\.in$/i.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/(\d+)/)[1]);
      const nb = Number(b.match(/(\d+)/)[1]);
      return na - nb;
    });
  if (!inFiles.length) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('gen.cpp 运行后未生成任何 test*.in 文件');
  }

  // 期望组数：默认以实际生成为准；若要求特定组数且不符则警告
  if (opts.groups && inFiles.length !== opts.groups) {
    warnings.push(`期望 ${opts.groups} 组，gen 实际生成 ${inFiles.length} 组`);
  }

  // 4) 规模校验
  const largeSizes = [];
  for (const f of inFiles) {
    const stat = fs.statSync(path.join(dir, f));
    if (stat.size > LARGE_MAX_BYTES) {
      warnings.push(`${f} 超过 2MB 上限（${stat.size} 字节）`);
    } else if (stat.size > SMALL_MAX_BYTES) {
      largeSizes.push(f);
    }
  }
  if (largeSizes.length > MAX_LARGE_GROUPS) {
    warnings.push(`大规模组数 ${largeSizes.length} 超过限制（≤${MAX_LARGE_GROUPS}）`);
  }

  // 5) 对每组运行 solution 生成 .out，组装 testcases
  const testcases = [];
  for (let i = 0; i < inFiles.length; i++) {
    const inPath = path.join(dir, inFiles[i]);
    const input = fs.readFileSync(inPath, 'utf8');
    const outPath = path.join(dir, inFiles[i].replace(/\.in$/i, '.out'));
    if (!fs.existsSync(outPath)) {
      // solution 未生成 .out —— 通过 stdin 运行标程取 stdout
      const answer = await run(solBin, { args: [], input, timeout: SOL_TIMEOUT_MS });
      testcases.push({ id: i + 1, input, answer: normalizeOutput(answer) });
    } else {
      const answer = fs.readFileSync(outPath, 'utf8');
      testcases.push({ id: i + 1, input, answer: normalizeOutput(answer) });
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  return { testcases, groups: testcases.length, warnings };
}

/** 供管理端探活：检查服务器是否具备 g++ 编译能力 */
function probeCompiler() {
  return new Promise((resolve) => {
    execFile('g++', ['--version'], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

module.exports = { generateTestcases, probeCompiler, normalizeOutput };
