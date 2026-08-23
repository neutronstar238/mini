'use strict';
/* ============================================================
 * Web IDE —— 浏览器统一运行环境（新申请书主线）
 * - 「运行代码」：自定义 stdin，浏览器内本地执行（Runno WASI）
 * - 「运行样例」：对公开 Samples 逐项自测（Passed / WA / RE）
 * - 本地结果仅供自测，不接触隐藏测试点；正式评测由服务器执行
 * ============================================================ */
var cid = window.__CONTEST_ID__ || (new URLSearchParams(location.search).get('contest')) || '';
var problemId = window.__PROBLEM_ID__ || location.pathname.split('/').pop();
if (!cid) location.href = '/contest/contests';

var IDE = { samples: [] };

function $(id) { return document.getElementById(id); }

function letter(i) { return String.fromCharCode(65 + i); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function renderMd(text) {
  var html = escapeHtml(text || '');
  html = html.replace(/```([\s\S]*?)```/g, function (_, code) { return '<pre class="code-block-oj">' + code.trim() + '</pre>'; });
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\$(.+?)\$/g, '<i>$1</i>').replace(/\n/g, '<br>');
  return html;
}

/* ================= 题目加载 ================= */
async function loadProblem() {
  try {
    var d = await api('/api/contest/contests/' + cid + '/problems/' + problemId);
    var p = d.problem;
    document.title = p.title + ' · Mini-OJ';
    $('p-title').textContent = p.title;
    var idx = p.order ? (p.order - 1) : -1;
    $('p-letter').textContent = idx >= 0 ? letter(idx) + ' · ' + String(p.id).slice(0, 6) : String(p.id).slice(0, 8);
    $('p-desc').innerHTML = renderMd(p.description);
    (p.samples || []).forEach(function (s, i) {
      $('p-desc').insertAdjacentHTML('beforeend',
        '<div class="md_display_div"><h2>Sample ' + (i + 1) + '</h2>' +
        '<div class="sample_row"><div class="sample_col"><div style="font-size:13px;color:#555;margin-bottom:4px">输入</div><pre class="sampledata">' + escapeHtml(s.input || '') + '</pre></div>' +
        '<div class="sample_col"><div style="font-size:13px;color:#555;margin-bottom:4px">输出</div><pre class="sampledata">' + escapeHtml(s.output || '') + '</pre></div></div></div>');
    });
    IDE.samples = p.samples || [];
    $('p-time').textContent = p.timeLimitMs + ' ms';
    $('p-mem').textContent = p.memoryLimitMb + ' MB';
    $('p-cases').textContent = p.testcaseCount || '-';
    $('p-subcnt').textContent = p.submitCount;
    $('p-acrate').textContent = (p.acRate || 0) + '%';
  } catch (err) {
    toast(err.message, 'err');
    $('p-title').textContent = '加载失败';
  }
}

/* ================= 浏览器运行时（Runno WASI，自托管 + 懒加载） =================
 * runno-loader.js 以 ES Module 引入自托管的 @runno/runtime，就绪后派发 runno-ready 事件。
 * 页面需 COOP/COEP 头（cross-origin isolated）以启用 SharedArrayBuffer。
 */
var RUNNO_VERSION = '0.10.0';
var PUBLIC_API_BASE = '/api/public';
var cachedProfiles = null; // 缓存 /api/public/runtime-profiles，避免每次切换重复请求
var runtimeUiState = {
  runno: 'idle',
  modernStage: 'IDLE',
  pythonText: '',
  javaText: ''
};

function renderSelectedRuntimeStatus() {
  var select = $('ide-lang');
  var label = $('runtime-status');
  if (!select || !label) return;
  var lang = select.value;
  if (lang === 'c' || lang === 'cpp') {
    var legacyName = lang === 'c' ? 'C11' : 'C++11';
    var legacyState = runtimeUiState.runno === 'ready' ? 'Ready'
      : runtimeUiState.runno === 'error' ? '加载失败'
      : '按需加载';
    label.textContent = legacyName + ' Browser Runtime: ' + legacyState + ' (Runno ' + RUNNO_VERSION + ')';
    return;
  }
  if (lang === 'c17' || lang === 'cpp17') {
    var modernName = lang === 'c17' ? 'C17' : 'C++17';
    var modernState = runtimeUiState.modernStage === 'READY' ? 'Ready'
      : runtimeUiState.modernStage === 'ERROR' ? '加载失败'
      : runtimeUiState.modernStage === 'IDLE' ? '按需加载'
      : 'Loading (' + runtimeUiState.modernStage + ')';
    label.textContent = modernName + ' Browser Runtime: ' + modernState + ' (Modern C/C++ Engine v2 · Clang/LLD 19.1.7)';
    return;
  }
  if (lang === 'python') {
    label.textContent = runtimeUiState.pythonText || 'Python 3.12 Runtime: 按需加载';
    return;
  }
  if (lang === 'java') {
    label.textContent = runtimeUiState.javaText || 'Java 21 Runtime: 按需加载 (OpenJDK 21.0.10+7 (Zero))';
    return;
  }
  label.textContent = '';
}

// 等待 ES Module 加载器就绪（window.__RUNNO__ 可用）
function ensureRunno() {
  if (window.__RUNNO__) {
    runtimeUiState.runno = 'ready';
    renderSelectedRuntimeStatus();
    return Promise.resolve();
  }
  return new Promise(function (resolve, reject) {
    var done = false;
    function ok() { if (done) return; done = true; window.removeEventListener('runno-ready', ok); runtimeUiState.runno = 'ready'; renderSelectedRuntimeStatus(); resolve(); }
    function fail(e) { if (done) return; done = true; window.removeEventListener('runno-ready', ok); runtimeUiState.runno = 'error'; renderSelectedRuntimeStatus(); reject(e); }
    window.addEventListener('runno-ready', ok);
    // 兜底：若 module 已加载但事件丢失
    if (window.__RUNNO__) { ok(); return; }
    setTimeout(fail, 15000); // 15s 超时
  });
}

// 语言 → Runno runtime 值
function runnoLang(lang) {
  if (lang === 'cpp') return 'clangpp';
  if (lang === 'c') return 'clang';
  return 'python';
}

// 等待轻量运行管线（ide-runner.js：Artifact Cache + 分段计时）就绪；失败返回 false 走旧管线兜底
function ensureIdeRunner() {
  if (window.__IDE_RUNNER__) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var done = false;
    function ok() { if (done) return; done = true; resolve(true); }
    window.addEventListener('ide-runner-ready', ok);
    if (window.__IDE_RUNNER__) { ok(); return; }
    setTimeout(function () { if (!done) { done = true; resolve(false); } }, 15000);
  });
}

// Modern profile 的默认优化等级由 Language Profile 唯一决定，调用方不可覆盖。
function getOptLevel() {
  var lang = document.getElementById('ide-lang');
  if (lang && (lang.value === 'c17' || lang.value === 'cpp17')) return '-O2';
  var el = document.getElementById('ide-opt');
  var v = el ? el.value : '-O0';
  return (v === '-O1' || v === '-O2') ? v : '-O0';
}
// PCH 开关：勾选 = 自动选择（含 bits/stdc++.h 用 bits.pch，含 iostream 用 iostream.pch，否则关闭）
function getUsePch() {
  var el = document.getElementById('ide-pch');
  return !!(el && el.checked);
}
// 是否启用自动 PCH（传给 runner 的 pchEnabled / pchLevel='auto'）
function pchEnabled() {
  var el = document.getElementById('ide-pch');
  return !!(el && el.checked);
}

function ideLanguageLabel(lang) {
  if (lang === 'python') return 'Python 3.12';
  if (lang === 'java') return 'Java 21';
  if (lang === 'c') return 'C11';
  if (lang === 'cpp') return 'C++11';
  if (lang === 'c17') return 'C17';
  if (lang === 'cpp17') return 'C++17';
  return lang || 'Unknown';
}

// 运行时间格式化：主指标只显示 Execution Time（<10ms 保留 1 位小数）
function fmtExecMs(ms) {
  if (ms == null) return '-';
  return ms < 10 ? (Math.round(ms * 10) / 10) : String(Math.round(ms));
}

// 编译信息次要行（Compile Time 与 Execution Time 严格分离，编译耗时不计入运行时间）
function formatCompileInfo(r) {
  var t = r && r.timing;
  if (!t) return '';
  if (r.compileFailed) return ''; // 编译失败时输出区已显示错误
  if (t.cacheHit) return '✓ 使用已编译缓存（未重新编译）';
  var parts = [];
  if (t.optimizationLevel) parts.push(t.optimizationLevel);
  if (t.pchMs) parts.push('PCH 生成 ' + t.pchMs + 'ms（一次性）');
  if (t.frontendMs != null || t.backendMs != null) {
    if (t.frontendMs != null) parts.push('解析与检查 ' + t.frontendMs + 'ms');
    if (t.backendMs != null) parts.push('生成机器码 ' + t.backendMs + 'ms');
  } else if (t.compileMs != null || t.compileTime != null) {
    parts.push('编译 ' + (t.compileMs != null ? t.compileMs : t.compileTime) + 'ms');
  }
  if (r.language === 'java' && t.runtimeLoadMs) parts.unshift('Runtime 初始化 ' + t.runtimeLoadMs + 'ms');
  if (t.linkMs) parts.push('链接 ' + t.linkMs + 'ms');
  return parts.length ? '✓ 编译成功 · ' + parts.join(' · ') : '';
}

// 中断器工厂：killers 用于真正杀死进行中的编译/执行 Worker，避免后台残留
function newAbort() {
  var killers = [];
  var abort = function () {
    killers.splice(0).forEach(function (k) { try { k(); } catch (_) { /* ignore */ } });
    if (abort._reject) abort._reject({ __abort: true });
  };
  abort._killers = killers;
  return abort;
}

// 完整 profile 输出到 console（开发/诊断用；页面只突出 Execution Time）
function logProfile(tag, t) {
  if (!t) return;
  var init = t.compilerInitMs;
  var runtimeLoad = init && typeof init === 'object'
    ? ((init.vfsLoadMs || 0) + (init.moduleInitMs || 0))
    : (init != null ? init : (t.runtimeLoadMs || 0));
  console.debug('[ide] ' + tag, {
    hash: t.hash, optLevel: t.optLevel, pch: !!t.pchUsed, cacheHit: !!t.cacheHit,
    'runtime/cache load': runtimeLoad,
    'clang init': t.clangInitMs, 'pch gen': t.pchMs || 0,
    'preprocess/header parse': t.frontendMs, 'compile/codegen': t.backendMs,
    'compile(clang -cc1)': t.compileMs, 'link(wasm-ld)': t.linkMs,
    'wasm compile': t.wasmCompileMs, 'instantiate': t.instantiateMs,
    'execution': t.executionMs, totalMs: t.totalMs
  });
}

/**
 * 在浏览器内运行代码（Runno WASI headless）
 * @param {string} code
 * @param {string} lang c/cpp/python
 * @param {string} stdin
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number, timeMs:number, terminated:boolean, timeout:boolean}>}
 */
var RUN_TIMEOUT_MS = 12000; // 单次浏览器运行前端超时兜底（编译+运行），避免 Runno stdin 竞态导致永久卡住
var abortRun = null;        // 当前运行的中断器（再次点击时调用以中断旧任务）
var runVersion = 0;         // 运行版本令牌：新点击自增，用于丢弃旧任务的过期结果

/**
 * 在浏览器内运行代码（可中断：opts.abort 被调用则立即取消，不等待 Runno 完成）
 * @param {string} code
 * @param {string} lang c/cpp/python
 * @param {string} stdin
 * @param {object} [opts] { abort } 中断函数
 */
async function runIde(code, lang, stdin, opts) {
  var isModernPreview = lang === 'c17' || lang === 'cpp17';
  var t0 = performance.now();
  var abort = (opts && opts.abort) || null;
  var abortPromise = abort ? new Promise(function (_, reject) {
    abort._reject = reject;
  }) : null;

  // 优先走 ide-runner 轻量管线（RuntimeManager 统一分发：python → Persistent Worker；c/cpp → Clang/WASI）
  // 未就绪则回退 Runno headlessRunCode 旧管线
  var useRunner = await ensureIdeRunner();
  if ((isModernPreview || lang === 'java') && !useRunner) {
    throw new Error((lang === 'java' ? 'Java 21' : 'Modern C/C++') + ' Browser Runtime 未就绪');
  }
  if (!useRunner) await ensureRunno();
  var invoke;
  if (useRunner) {
    invoke = window.__IDE_RUNNER__.runCode({
      language: lang, code: code, source: code, stdin: stdin || '',
      optLevel: getOptLevel(), pchLevel: 'auto', pchEnabled: pchEnabled(),
      killers: abort ? abort._killers : null
    });
  } else {
    invoke = window.__RUNNO__.headlessRunCode(runnoLang(lang), code, stdin || '');
  }

  var races = [invoke, abortPromise];
  if (!useRunner) {
    races.push(new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error('浏览器运行超时（可能 stdin 竞态），请重试')); }, RUN_TIMEOUT_MS);
    }));
  }

  var result = await Promise.race(races.filter(Boolean)).catch(function (e) {
    var timeMs0 = Math.round(performance.now() - t0);
    var isAbort = !!(abort && e && e.__abort);
    if (isAbort) return { __aborted: true };
    // PrepareError（编译失败）的详细 stderr 存放在 e.data.stderr
    var detail = '';
    if (e && e.data && e.data.stderr) detail = e.data.stderr;
    else if (e && e.message) detail = e.message;
    return { __err: true, stdout: '', stderr: detail || ('运行失败：' + String(e)), exitCode: -1, timeMs: timeMs0, terminated: false, timeout: false };
  });
  if (result && result.__aborted) return { __aborted: true, stdout: '', stderr: '', exitCode: -1, timeMs: 0, terminated: false, timeout: false };
  if (result && result.__err) return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timeMs: result.timeMs, terminated: false, timeout: result.timeout };
  var timeMs = Math.round(performance.now() - t0);

  // —— ide-runner 管线结果（Execution Time 与 Compile Time 严格分离） ——
  if (result && result.timing) {
    if (result.aborted && !result.timedOut) return { __aborted: true, stdout: '', stderr: '', exitCode: -1, timeMs: 0, terminated: false, timeout: false };
    logProfile('profile', result.timing);
    var rt = {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode,
      timeMs: result.timeMs != null ? result.timeMs : timeMs,
      executionMs: result.executionMs != null ? result.executionMs : null, // 主指标：纯程序运行时间
      compileFailed: !!result.compileFailed,
      terminated: false, timeout: !!result.timedOut,
      timing: result.timing
    };
    if (result.timedOut && !rt.stderr) rt.stderr = '运行超时（浏览器本地 6s 限制）';
    return rt;
  }

  // —— 旧管线 RunResult 判别：complete / crash / terminated / timeout ——
  if (!result || result.resultType === 'terminated') {
    return { stdout: '', stderr: '程序被终止（可能超时）', exitCode: -1, timeMs, terminated: true, timeout: false };
  }
  if (result.resultType === 'timeout') {
    return { stdout: '', stderr: '运行超时（浏览器本地 5s 限制）', exitCode: -1, timeMs, terminated: false, timeout: true };
  }
  if (result.resultType === 'crash') {
    var em = result.error && (result.error.message || result.error.type || JSON.stringify(result.error));
    return { stdout: '', stderr: '运行崩溃：' + em, exitCode: -1, timeMs, terminated: false, timeout: false };
  }
  // complete
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.exitCode,
    timeMs: timeMs,
    terminated: false, timeout: false
  };
}

/* 输出规范化（与服务器评测一致的去尾空白逻辑） */
function normalizeOut(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').split('\n')
    .map(function (l) { return l.replace(/\s+$/, ''); }).join('\n').replace(/^\s+|\s+$/g, '');
}

/* ================= 运行代码（自定义输入，支持再次点击中断并重跑） ================= */
async function onRun() {
  // 再次点击：中断上一个仍在运行的编译/运行任务，立即用当前代码重新开始
  if (abortRun) {
    try { abortRun(); } catch (_) { /* ignore */ }
    abortRun = null;
  }
  runVersion++;
  var ver = runVersion;

  var code = $('ide-code').value;
  if (!code.trim()) { toast('代码不能为空', 'err'); return; }
  var lang = $('ide-lang').value;
  var stdin = $('ide-input').value;
  var btn = $('ide-run');
  var isCpp = lang === 'cpp' || lang === 'c' || lang === 'cpp17' || lang === 'c17';
  var runningDetail = isCpp ? '编译 C/C++，可能需数秒'
    : lang === 'java' ? '准备 Java 21 Runtime，首次需下载约 30 MB 并启动 JVM'
    : '编译 Python，可能需数秒';

  var abort = newAbort();
  abortRun = abort;

  $('ide-output-wrap').style.display = '';
  $('ide-output-head').innerHTML = '<span class="oj-source-tag">LOCAL</span> ' + escapeHtml(ideLanguageLabel(lang));
  $('ide-time').textContent = '运行中…（' + runningDetail + '）';
  $('ide-timing').textContent = '';
  $('ide-output').innerHTML = '<span style="color:#94a3b8">…</span>';
  btn.textContent = '◼ 中断';

  try {
    var r = await runIde(code, lang, stdin, { abort: abort });
    if (ver !== runVersion) return; // 已被新的点击作废，丢弃旧结果
    if (r.__aborted) { $('ide-time').textContent = '已中断'; $('ide-timing').textContent = ''; $('ide-output').innerHTML = '<span class="out-stderr">上一次运行已中断，点击「运行代码」重新开始</span>'; return; }
    // 主指标：运行时间 = 纯 Execution Time（编译耗时仅作次要信息，不计入）
    if (r.executionMs != null) {
      $('ide-time').textContent = '运行时间：' + fmtExecMs(r.executionMs) + ' ms' +
        (lang === 'python' ? '（本地参考，正式 TLE 以服务器为准）' : '');
    } else if (r.compileFailed) {
      $('ide-time').textContent = '✗ 编译失败';
    } else {
      $('ide-time').textContent = 'Local Runtime: ' + r.timeMs + ' ms（仅供参考）'; // 旧管线兜底
    }
    // SystemExit(non-zero)：正式 Judge 视为 abnormal exit，本地不应显示"运行成功"
    if (lang === 'python' && r.reason === 'NON_ZERO_EXIT' && r.exitCode !== 0) {
      $('ide-time').textContent = 'Local Runtime Error · Program exited with code ' + r.exitCode;
      html = '<span class="out-stderr">程序以非零退出码结束（' + r.exitCode + '）。正式 Judge 视为异常退出（RE）。</span>';
      $('ide-output').innerHTML = html;
      $('ide-timing').textContent = 'Python 编译 ' + fmtExecMs((r.timing && r.timing.compileTime) || 0) + ' ms · Runtime 加载 ' +
        fmtExecMs((r.timing && r.timing.runtimeLoadMs) || 0) + ' ms · Code Cache ' + (r.timing && r.timing.cacheHit ? '命中' : '未命中');
      return;
    }
    if (lang === 'python' && r.timing) {
      // Python：展示编译耗时 / Runtime 加载 / Code Cache（均不计入运行时间）
      $('ide-timing').textContent = 'Python 编译 ' + fmtExecMs(r.timing.compileTime || 0) + ' ms · Runtime 加载 ' +
        fmtExecMs(r.timing.runtimeLoadMs || 0) + ' ms · Code Cache ' + (r.timing.cacheHit ? '命中' : '未命中');
    } else {
      $('ide-timing').textContent = formatCompileInfo(r);
    }
    var html = escapeHtml(r.stdout || '（无标准输出）');
    if (r.stderr) html += '<span class="out-stderr">\n[stderr]\n' + escapeHtml(r.stderr) + '</span>';
    if (r.exitCode !== 0) html += '\n[exit ' + r.exitCode + ']';
    $('ide-output').innerHTML = html;
    // 运行时增强：显示编译详情（折叠区）
    if (window.__RUNTIME_UI__ && typeof window.__RUNTIME_UI__.showCompileDetail === 'function') {
      window.__RUNTIME_UI__.showCompileDetail(r);
    }
  } catch (e) {
    if (ver === runVersion) $('ide-output').innerHTML = '<span class="out-stderr">运行失败：' + escapeHtml(String(e.message || e)) + '</span>';
  } finally {
    if (abortRun === abort) abortRun = null;
    btn.textContent = '▶ 运行代码';
  }
}

/* ================= 运行样例（公开 Samples 逐项自测，可中断） ================= */
async function onRunSamples() {
  // 中断正在运行的「运行代码」
  if (abortRun) { try { abortRun(); } catch (_) { /* ignore */ } abortRun = null; }
  runVersion++;
  var ver = runVersion;

  var code = $('ide-code').value;
  if (!code.trim()) { toast('代码不能为空', 'err'); return; }
  if (!IDE.samples.length) { toast('该题暂无公开样例', 'warn'); return; }
  var lang = $('ide-lang').value;
  var btn = $('ide-run-samples');

  var abort = newAbort();
  abortRun = abort;
  btn.textContent = '◼ 中断样例';

  $('ide-samples-wrap').style.display = '';
  $('ide-samples-result').innerHTML = '<span class="text-muted">自测中…</span>';
  var rows = [];
  var compileSummary = ''; // Compile Time 汇总（仅首个未命中样例产生一次）
  try {
    for (var i = 0; i < IDE.samples.length; i++) {
      var s = IDE.samples[i];
      var r = await runIde(code, lang, s.input || '', { abort: abort });
      if (ver !== runVersion) return; // 被新点击作废
      if (r.__aborted) { $('ide-samples-result').innerHTML = '<span class="text-muted">已中断</span>'; return; }
      // 编译失败：所有样例结果相同，直接展示 CE 并终止
      if (r.compileFailed) {
        $('ide-samples-result').innerHTML = '<div class="sample-case-row">' + caseDot('CE') +
          '<span class="oj-source-tag">LOCAL</span> <span class="res-badge res-danger">编译失败 (Local CE)</span></div><pre class="output-oj">' + escapeHtml(r.stderr || '编译错误') + '</pre>';
        return;
      }
      if (r.timing && !r.timing.cacheHit && !compileSummary) compileSummary = formatCompileInfo(r);
      var out = normalizeOut(r.stdout);
      var expect = normalizeOut(s.output || '');
      var status;
      if (r.timeout) status = 'TLE';
      else if (r.terminated) status = 'TLE';
      else if (r.exitCode !== 0) status = 'RE';
      else status = out === expect ? 'Passed' : 'WA';
      var cls = status === 'Passed' ? 'res-success' : (status === 'RE' || status === 'WA' ? 'res-danger' : 'res-warning');
      // 行内时间只显示 Execution Time（纯程序运行时间）；超时被 kill 无计时，显示上限
      var timeText = r.timeout ? '>6000 ms' : (r.executionMs != null ? fmtExecMs(r.executionMs) + ' ms' : r.timeMs + ' ms');
      rows.push(
        '<div class="sample-case-row">' + caseDot(status) +
        '<span class="oj-source-tag">LOCAL</span> <b>Sample ' + (i + 1) + '</b> <span class="res-badge ' + cls + '">' + status + '</span>' +
        '<span class="text-muted">运行 ' + timeText + '</span></div>' +
        (status === 'WA' ? '<pre class="output-oj">期望：' + escapeHtml(expect || '(空)') + '\n实际：' + escapeHtml(out || '(空)') + '</pre>' : '')
      );
    }
    if (ver === runVersion) {
      $('ide-samples-result').innerHTML =
        (compileSummary ? '<div class="text-muted" style="font-size:12px;margin-bottom:6px">' + compileSummary + ' · 以下为各样例运行时间</div>' : '') +
        rows.join('') +
        '<div class="oj-sample-warn">样例通过仅表示当前公开样例通过，正式结果以服务器评测为准。</div>';
    }
  } catch (e) {
    if (ver === runVersion) $('ide-samples-result').innerHTML = '<span class="out-stderr">自测失败：' + escapeHtml(String(e.message || e)) + '</span>';
  } finally {
    if (abortRun === abort) abortRun = null;
    btn.textContent = '运行样例';
  }
}

/* ================= 正式提交（服务器 JudgeAdapter 唯一正式判定，POST 才发送 source） =================
 * 语言映射：前端 select 值 c/cpp/python → 正式语言 c11/cpp11/python3（服务端 allowlist）。
 * 幂等：每次点击生成一个 crypto.randomUUID；若请求超时重试，复用同一 clientRequestId。
 * 只上传 source/language/problem/contest/clientRequestId；绝不把 Local PASS / 本地执行时间作为正式依据。
 */
var pendingRequestId = null; // 当前待重试的幂等键

function officialLanguage(frontendLang) {
  if (frontendLang === 'c') return 'c11';
  if (frontendLang === 'cpp') return 'cpp11';
  if (frontendLang === 'java') return 'java21';
  if (frontendLang === 'c17') return 'c17';
  if (frontendLang === 'cpp17') return 'cpp17';
  return 'python3';
}

document.getElementById('submit-btn').addEventListener('click', async function () {
  var code = $('ide-code').value;
  var frontendLang = $('ide-lang').value;
  var language = officialLanguage(frontendLang);
  if (!code.trim()) return toast('代码不能为空', 'err');
  var btn = $('submit-btn');
  btn.disabled = true; btn.textContent = '提交中…';
  // 点击一次生成一个幂等键；timeout 后同一键重试（由前端在失败时保留）
  if (!pendingRequestId) pendingRequestId = crypto.randomUUID();
  var requestId = pendingRequestId;
  try {
    var d = await api('/api/contest/contests/' + cid + '/submissions', {
      method: 'POST',
      body: JSON.stringify({
        contestId: cid,
        problemId: problemId,
        language: language,
        code: code,
        clientRequestId: requestId,
        clientSubmittedAt: new Date().toISOString() // 仅作日志，排名以 server_received_at 为准
      })
    });
    pendingRequestId = null; // 成功即清空
    $('submit-result').style.display = '';
    $('sub-id').textContent = d.submission.id.slice(0, 8);
    $('sub-status').innerHTML = officialBadge(d.submission.status, d.submission.verdict);
    $('sub-cases').innerHTML = '';
    if (d.deduplicated) toast('检测到重复请求，已复用原提交', 'warn');
    else toast('已提交，服务器评测中');
    trackSubmission(d.submission.id);
  } catch (err) {
    // 网络失败：保留 requestId 供重试复用，避免重复建 Submission
    toast(err.message, 'err');
  }
  finally { btn.disabled = false; btn.textContent = '正式提交'; }
});

/** 正式 Verdict 徽标（OFFICIAL） */
function officialBadge(status, verdict) {
  var v = verdict || status || 'QUEUED';
  var cls = 'res-badge res-muted-oj';
  if (v === 'AC') cls = 'res-badge res-success';
  else if (v === 'WA' || v === 'RE') cls = 'res-badge res-danger';
  else if (v === 'TLE' || v === 'MLE') cls = 'res-badge res-warning';
  else if (v === 'CE') cls = 'res-badge res-warning';
  else if (v === 'SYSTEM_ERROR') cls = 'res-badge res-danger';
  return '<span class="oj-source-tag">OFFICIAL</span> ' + '<span class="' + cls + '">' + verdictLabel(v) + '</span>';
}
function verdictLabel(v) {
  return { AC: 'Accepted', WA: 'Wrong Answer', TLE: 'Time Limit Exceeded', MLE: 'Memory Limit Exceeded', RE: 'Runtime Error', CE: 'Compile Error', SYSTEM_ERROR: 'System Error', QUEUED: 'Queued', JUDGING: 'Judging', FINISHED: 'Finished' }[v] || v;
}

function trackSubmission(id) {
  var statusEl = $('sub-status');
  statusEl.innerHTML = officialBadge('QUEUED');
  var stop = false;
  var sse = null;
  function finish(s) {
    if (stop) return;
    stop = true;
    statusEl.innerHTML = officialBadge(s.status, s.verdict);
    if (s.verdict === 'AC') toast('评测通过！Official Accepted');
    else if (s.status === 'FINISHED') toast('评测完成：' + verdictLabel(s.verdict || ''));
  }
  async function poll() {
    if (stop) return;
    try {
      var s = (await api('/api/contest/submissions/' + id)).submission;
      if (s.status === 'QUEUED' || s.status === 'JUDGING') statusEl.innerHTML = officialBadge(s.status, s.verdict);
      else finish(s);
    } catch (_) { /* ignore */ }
    if (!stop) setTimeout(poll, 2500); // SSE 断开 fallback：2.5s 轮询
  }
  // SSE 优先
  sse = sseConnect('/api/contest/events/stream', {
    submission_update: function (d) {
      if (d.id !== id) return;
      if (d.status === 'QUEUED' || d.status === 'JUDGING') statusEl.innerHTML = officialBadge(d.status, d.verdict);
      else finish({ status: d.status, verdict: d.verdict });
    }
  });
  poll();
}

/* ================= 本地草稿持久化（刷新保留，按 contestId/problemId/language 分开） =================
 * 只保存 source draft / selected language / custom input，绝不保存密码/Session/隐藏数据。
 */
var DRAFT_PREFIX = 'oj-draft:';
var DRAFT_USER_ID = String(window.__USER_ID__ || 'anonymous');
function draftKey(lang) { return DRAFT_PREFIX + DRAFT_USER_ID + ':' + cid + ':' + problemId + ':' + lang; }

function loadDraft() {
  try {
    var cur = $('ide-lang').value;
    var d = JSON.parse(localStorage.getItem(draftKey(cur)) || 'null');
    if (d && typeof d.source === 'string') $('ide-code').value = d.source;
    if (d && typeof d.input === 'string') $('ide-input').value = d.input;
  } catch (_) { /* 忽略损坏草稿 */ }
}

var draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(function () {
    try {
      var lang = $('ide-lang').value;
      localStorage.setItem(draftKey(lang), JSON.stringify({
        source: $('ide-code').value,
        input: $('ide-input').value,
        savedAt: Date.now()
      }));
    } catch (_) { /* 隐私模式等无 localStorage 时忽略 */ }
  }, 800); // debounce 800ms
}
function updateSubmitPreviewGate() {
  var lang = $('ide-lang').value;
  var profileId = frontendLangToProfileId(lang);
  var modernCanaryDenied = (lang === 'c17' || lang === 'cpp17') && window.__MODERN_FORMAL_SUBMIT_ALLOWED__ === false;
  var btn = $('submit-btn');
  var note = $('submit-preview-note');
  function applyGate(p) {
    if ($('ide-lang').value !== lang) return;
    var enabled = !modernCanaryDenied && !!p && (p.formalSubmit === true || p.submissionEnabled === true);
    if (btn) {
      btn.disabled = !enabled;
      btn.title = enabled ? '' : '当前该语言暂不支持正式提交。';
    }
    if (note) note.style.display = enabled ? 'none' : '';
  }
  // Keep the selector usable while the public profile request is in flight;
  // the server remains the final authority for the formal-submit gate.
  if (btn) btn.disabled = modernCanaryDenied;
  if (note) note.style.display = modernCanaryDenied ? '' : 'none';
  fetchProfiles().then(function (profiles) {
    applyGate(profiles.find(function (p) { return p.id === profileId; }));
  });
}
function updateModernControls() {
  var modern = $('ide-lang').value === 'c17' || $('ide-lang').value === 'cpp17';
  var pch = $('ide-pch');
  var opt = $('ide-opt');
  if (pch) {
    pch.disabled = modern;
    if (modern) pch.checked = false;
    pch.title = modern ? 'Modern C/C++ Profile 固定禁用 PCH' : '';
  }
  if (opt) {
    opt.disabled = modern;
    if (modern) opt.value = '-O2';
  }
}
$('ide-code').addEventListener('input', saveDraft);
$('ide-input').addEventListener('input', saveDraft);
// 语言切换：切走时保存当前语言草稿，再加载新语言草稿（按语言互不覆盖）
$('ide-lang').addEventListener('change', function () {
  try {
    var old = this._lastLang;
    if (old && old !== this.value) localStorage.setItem(draftKey(old), JSON.stringify({ source: $('ide-code').value, input: $('ide-input').value }));
  } catch (_) { /* ignore */ }
  var d = null;
  try { d = JSON.parse(localStorage.getItem(draftKey(this.value)) || 'null'); } catch (_) { /* ignore */ }
  if (d && typeof d.source === 'string') $('ide-code').value = d.source;
  if (d && typeof d.input === 'string') $('ide-input').value = d.input;
  this._lastLang = this.value;
  if (window.__IDE_RUNNER__) window.__IDE_RUNNER__.prewarm(this.value);
  updateSubmitPreviewGate();
  updateModernControls();
  renderSelectedRuntimeStatus();
});
$('ide-lang')._lastLang = $('ide-lang').value;
loadDraft();
updateSubmitPreviewGate();
updateModernControls();
renderSelectedRuntimeStatus();

$('ide-run').addEventListener('click', onRun);
$('ide-run-samples').addEventListener('click', onRunSamples);
ensureIdeRunner().then(function (ok) {
  if (!ok) return;
  var runner = window.__IDE_RUNNER__;
  runner.prewarm($('ide-lang').value);
  // Python Runtime 状态标签（懒加载 Persistent Worker）：Loading → Preparing → Ready
  if (runner.onPythonStatus) {
    runner.onPythonStatus(function (s) {
      var label = $('runtime-status');
      // Python Interrupt 能力（Environment Check）：READY（SAB）或 FALLBACK（terminate）
      var int = (typeof runner.pythonInterruptStatus === 'function') ? runner.pythonInterruptStatus() : null;
      var intLabel = int ? (' · Interrupt ' + (int.capability === 'READY' ? 'READY' : 'FALLBACK')) : '';
      if (s === 'loading') runtimeUiState.pythonText = 'Python Runtime: Loading…';
      else if (s === 'preparing') runtimeUiState.pythonText = 'Python Runtime: Preparing…' + intLabel;
      else if (s === 'ready') runtimeUiState.pythonText = 'Python Runtime: Ready (' + (runner.pythonProfile ? runner.pythonProfile.pythonVersion : '3.12') + ')' + intLabel;
      else if (s === 'error') runtimeUiState.pythonText = 'Python Runtime: 加载失败，请刷新重试' + intLabel;
      else runtimeUiState.pythonText = intLabel;
      if ($('ide-lang').value === 'python') label.textContent = runtimeUiState.pythonText;
    });
  }
  // Phase 6 — Java 21 Runtime 状态标签（懒加载 Persistent Worker）：Loading → Preparing → Ready
  if (runner.onJavaStatus) {
    runner.onJavaStatus(function (s) {
      var label = $('runtime-status');
      var int = (typeof runner.javaInterruptStatus === 'function') ? runner.javaInterruptStatus() : null;
      var intLabel = int ? (' · Interrupt ' + (int.capability === 'READY' ? 'READY' : 'FALLBACK')) : '';
      var prof = runner.javaProfile || {};
      var sourceNote = prof.status === 'DISTRIBUTION_BLOCKED' ? '（SCAFFOLD：self-built pending，详见 docs/java-runtime-license-audit.md）' : '';
      if (s === 'loading') runtimeUiState.javaText = 'Java 21 Runtime: Loading…';
      else if (s === 'preparing') runtimeUiState.javaText = 'Java 21 Runtime: Preparing… ' + intLabel;
      else if (s === 'ready') runtimeUiState.javaText = 'Java 21 Runtime: Ready (' + (prof.javaVersion || 'OpenJDK 21u') + ') ' + sourceNote + intLabel;
      else if (s === 'error') runtimeUiState.javaText = 'Java 21 Runtime: 加载失败，点击「运行代码」重试 ' + intLabel + sourceNote;
      else runtimeUiState.javaText = intLabel;
      if ($('ide-lang').value === 'java') label.textContent = runtimeUiState.javaText;
    });
  }
});

// 后台 speculative compile：编辑器停止输入 1s 后用当前设置预编译，点击 Run 时直接命中缓存
var speculateTimer = null;
$('ide-code').addEventListener('input', function () {
  clearTimeout(speculateTimer);
  speculateTimer = setTimeout(function () {
    if (!window.__IDE_RUNNER__ || !window.__IDE_RUNNER__.speculate) return;
    if ($('ide-lang').value === 'c17' || $('ide-lang').value === 'cpp17') return;
    window.__IDE_RUNNER__.speculate({
      code: $('ide-code').value, lang: $('ide-lang').value,
      optLevel: getOptLevel(), pchLevel: 'auto', pchEnabled: pchEnabled()
    });
  }, 1000);
});

// Ctrl/Cmd+Enter 快捷运行
$('ide-code').addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(); }
});

/* ============================================================
 * Runtime Enhancement Phase：UI 渲染
 *  - 语言状态标记（dot + 文本）
 *  - Tooltip：本地 vs 正式环境摘要
 *  - Drawer：运行环境详情（含 Local/Official 双列）
 *  - 编译详情可折叠区
 *  - Runtime Diagnostics
 *  - 错误分类（Runtime Loading Error vs CE vs RE vs TLE）
 * ============================================================ */
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* 拉取 profiles 一次（短缓存） */
function fetchProfiles() {
  if (cachedProfiles) return Promise.resolve(cachedProfiles);
  return fetch(PUBLIC_API_BASE + '/runtime-profiles').then(function (r) { return r.json(); }).then(function (d) {
    cachedProfiles = d && d.profiles ? d.profiles : [];
    return cachedProfiles;
  }).catch(function () { return []; });
}

/* 前端语言选择值 → profile.id 映射（与 server 端一致） */
function frontendLangToProfileId(frontendLang) {
  if (frontendLang === 'c') return 'c11';
  if (frontendLang === 'cpp') return 'cpp11';
  if (frontendLang === 'java') return 'java21';
  if (frontendLang === 'python' || frontendLang === 'python3') return 'python3';
  if (frontendLang === 'c17') return 'c17';
  if (frontendLang === 'cpp17') return 'cpp17';
  return frontendLang;
}

/* 根据 profile 渲染状态文字（dot class + 文本） */
function statusDotAndText(p) {
  if (!p) return { dot: 'unavailable', text: 'UNAVAILABLE' };
  var local = p.localRuntime || {};
  if (!local.supported) return { dot: 'unavailable', text: 'UNAVAILABLE' };
  if (!local.enabled) return { dot: 'unavailable', text: 'UNAVAILABLE' };
  return { dot: 'ready', text: 'SUPPORTED' };
}

/* 渲染语言 Selector 内联状态（option 标签内追加 dot+文本） */
function renderLangSelectorStatus() {
  var sel = $('ide-lang');
  if (!sel) return;
  fetchProfiles().then(function (profiles) {
    var byFrontend = {
      cpp: profiles.find(function (p) { return p.id === 'cpp11'; }),
      c: profiles.find(function (p) { return p.id === 'c11'; }),
      cpp17: profiles.find(function (p) { return p.id === 'cpp17'; }),
      c17: profiles.find(function (p) { return p.id === 'c17'; }),
      python: profiles.find(function (p) { return p.id === 'python3'; }),
      java: profiles.find(function (p) { return p.id === 'java21'; })
    };
    var LABEL = { cpp: 'C++11', c: 'C11', cpp17: 'C++17', c17: 'C17', python: 'Python 3.12', java: 'Java 21' };
    Array.from(sel.options).forEach(function (opt) {
      var p = byFrontend[opt.value];
      if (!p) return;
      var s = statusDotAndText(p);
      opt.textContent = LABEL[opt.value] || opt.value;
      opt.dataset.profileId = p.id;
      opt.dataset.status = s.dot;
      if (opt.value === 'c17' || opt.value === 'cpp17') opt.disabled = !(p.localRuntime && p.localRuntime.enabled);
    });
  });
}

/* 渲染 hover Tooltip（左右两列） */
function renderLangTooltip(frontendLang) {
  var el = $('ide-lang-tooltip');
  if (!el) return;
  var profileId = frontendLangToProfileId(frontendLang);
  fetchProfiles().then(function (profiles) {
    var p = profiles.find(function (x) { return x.id === profileId; });
    if (!p) { el.innerHTML = '<span style="color:#6b7280">未找到 profile 信息</span>'; return; }
    var local = p.localRuntime;
    var off = p.officialJudge;
    var cacheBadge = local.supported && local.enabled ? '浏览器本地运行：支持' : '浏览器本地运行：不支持';
    el.innerHTML =
      '<div class="oj-tt-grid">' +
        '<div class="oj-tt-col">' +
          '<h5>本地浏览器</h5>' +
          '<p><b>' + (local.compiler || '-') + '</b></p>' +
          '<p>' + (local.compilerVersion || '-') + '</p>' +
          '<p>标准：' + (local.standard || '-') + '</p>' +
          '<p>Target：' + (local.target || '-') + '</p>' +
          '<p>Flags：' + ((local.compileFlags || []).join(' ') || '-') + '</p>' +
          '<p>Runtime ID：<span style="font-family:monospace;font-size:11px">' + (local.runtimeId || '-') + '</span></p>' +
          '<p>' + cacheBadge + '</p>' +
        '</div>' +
        '<div class="oj-tt-col">' +
          '<h5>正式评测</h5>' +
          '<p><b>' + (off.compiler || '-') + '</b></p>' +
          '<p>' + (off.compilerVersion || '-') + '</p>' +
          '<p>标准：' + (off.standard || '-') + '</p>' +
          '<p>OS：' + (off.os || '-') + '</p>' +
        '</div>' +
      '</div>' +
      '<div class="oj-tt-foot">本地与正式环境并非同一编译器，最终结果以服务器 Judge 为准。</div>';
  });
}

/* 渲染右侧 Drawer 完整内容 */
function renderRuntimeDrawer() {
  var body = $('runtime-drawer-body');
  if (!body) return;
  var frontendLang = $('ide-lang').value;
  var profileId = frontendLangToProfileId(frontendLang);
  fetchProfiles().then(function (profiles) {
    var p = profiles.find(function (x) { return x.id === profileId; });
    if (!p) { body.innerHTML = '<div class="oj-drawer-empty">未找到 profile 信息</div>'; return; }
    var local = p.localRuntime;
    var off = p.officialJudge;
    function kv(k, v) {
      if (v == null || v === '') return '';
      return '<div class="k">' + k + '</div><div class="v">' + v + '</div>';
    }
    var localBody = [
      kv('Runtime ID', local.runtimeId || '-'),
      kv('Compiler', local.compiler || '-'),
      kv('Compiler Version', local.compilerVersion || '-'),
      kv('Language Standard', local.standard || '-'),
      kv('Target Triple', local.target || '-'),
      kv('Compile Flags', (local.compileFlags || []).join(' ') || '-'),
      kv('Optimization', local.optimizationLevel || '-'),
      kv('Optimization Mismatch', local.optimizationMismatch ? 'true' : 'false'),
      kv('PCH Policy', local.pchPolicy || 'none'),
      kv('Header Guard', local.headerGuard || 'none'),
      kv('Browser Local', local.supported && local.enabled ? '支持' : '不支持')
    ].join('');
    var offBody = [
      kv('OS', off.os || '-'),
      kv('Compiler', off.compiler || '-'),
      kv('Compiler Version', off.compilerVersion || '-'),
      kv('Language Standard', off.standard || '-'),
      kv('Compile Flags', (off.compileFlags || []).join(' ') || '-'),
      kv('Run Flags', (off.runFlags || []).join(' ') || '-'),
      kv('Time Adjustment', off.timeAdjustment),
      kv('Memory Adjustment', off.memoryAdjustment),
      kv('Formal Submit', p.submissionEnabled ? '可用' : '不可用')
    ].join('');
    body.innerHTML =
      '<div class="oj-drawer-section">' +
        '<h4>Browser Local Runtime</h4>' +
        (local.supported ? '<div class="oj-drawer-kv">' + localBody + '</div>' : '<div class="oj-drawer-empty">本地浏览器运行时暂不可用</div>') +
      '</div>' +
      '<div class="oj-drawer-section">' +
        '<h4>Official Judge</h4>' +
        (off.supported ? '<div class="oj-drawer-kv">' + offBody + '</div>' : '<div class="oj-drawer-empty">正式评测暂未配置</div>') +
      '</div>' +
      '<div class="oj-drawer-section">' +
        '<h4>Runtime Diagnostics</h4>' +
        '<div id="drawer-diag">' + renderDiagnosticsList() + '</div>' +
        '<button class="oj-diag-copy" id="drawer-diag-copy" type="button">复制诊断信息</button>' +
      '</div>';
    var copyBtn = $('drawer-diag-copy');
    if (copyBtn) copyBtn.addEventListener('click', copyDiagnostics);
  });
}

/* 错误分类：根据 runCode 返回的 stage 决定显示哪个徽标 */
function classifyError(r) {
  if (!r) return null;
  if (r.compileFailed) {
    if (r.stage === 'python-init') return 'runtime-load';
    if (r.stage === 'java-init') return 'runtime-load';  // Phase 6 — Java 21 Runtime 加载失败
    if (r.stage === 'runtime-load') return 'runtime-load';
    if (r.stage === 'gcc11-header') return 'compile';
    return 'compile';
  }
  if (r.timedOut) return 'local-timeout';
  if (r.aborted) return 'local-timeout';
  return null;
}
function errorBadgeHtml(cls, label) {
  return '<span class="oj-error-class ' + cls + '">' + label + '</span>';
}

/* 渲染每次 Local Run 的编译详情（折叠区内容） */
function renderCompileDetail(r) {
  if (!r || !r.timing) return '';
  var t = r.timing;
  var lines = [];
  lines.push('<div class="row"><span class="k">language</span><span class="v">' + (r.language || '-') + '</span></div>');
  lines.push('<div class="row"><span class="k">runtimeId</span><span class="v">' + (r.runtimeId || '-') + '</span></div>');
  if (t.hash) lines.push('<div class="row"><span class="k">sourceHash</span><span class="v">' + t.hash + '</span></div>');
  if (t.optimizationLevel) lines.push('<div class="row"><span class="k">optimization</span><span class="v">' + t.optimizationLevel + '</span></div>');
  lines.push('<div class="row"><span class="k">cacheHit</span><span class="v">' + (r.cacheHit ? 'YES' : 'NO') + '</span></div>');
  if (t.compileMs != null) lines.push('<div class="row"><span class="k">compile</span><span class="v">' + t.compileMs + ' ms</span></div>');
  if (t.linkMs != null) lines.push('<div class="row"><span class="k">link</span><span class="v">' + t.linkMs + ' ms</span></div>');
  if (t.wasmCompileMs != null) lines.push('<div class="row"><span class="k">wasm compile</span><span class="v">' + t.wasmCompileMs + ' ms</span></div>');
  if (t.instantiateMs != null) lines.push('<div class="row"><span class="k">instantiate</span><span class="v">' + t.instantiateMs + ' ms</span></div>');
  if (r.executionMs != null) lines.push('<div class="row"><span class="k">execution</span><span class="v">' + r.executionMs + ' ms</span></div>');
  if (t.artifactBytes) lines.push('<div class="row"><span class="k">artifact</span><span class="v">' + fmtBytes(t.artifactBytes) + '</span></div>');
  var stdoutBytes = r.stdout ? new Blob([r.stdout]).size : 0;
  var stderrBytes = r.stderr ? new Blob([r.stderr]).size : 0;
  lines.push('<div class="row"><span class="k">stdout bytes</span><span class="v">' + stdoutBytes + '</span></div>');
  lines.push('<div class="row"><span class="k">stderr bytes</span><span class="v">' + stderrBytes + '</span></div>');
  return lines.join('');
}

/* Runtime Diagnostics 检测项 */
function renderDiagnosticsList() {
  var items = [
    { name: 'WebAssembly', ok: typeof WebAssembly !== 'undefined' },
    { name: 'Web Worker', ok: typeof Worker !== 'undefined' },
    { name: 'SharedArrayBuffer', ok: typeof SharedArrayBuffer !== 'undefined' },
    { name: 'crossOriginIsolated', ok: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false },
    { name: 'Atomics.store', ok: typeof Atomics !== 'undefined' && typeof Atomics.store === 'function' },
    { name: 'Cache Storage', ok: typeof caches !== 'undefined' },
    { name: 'IndexedDB', ok: typeof indexedDB !== 'undefined' },
    { name: 'ReadableStream (进度)', ok: typeof ReadableStream !== 'undefined' },
    { name: 'Browser', ok: true, value: (navigator.userAgent || '').slice(0, 60) + (navigator.userAgent && navigator.userAgent.length > 60 ? '…' : '') }
  ];
  return '<ul class="oj-diag-list">' + items.map(function (it) {
    var cls = it.ok ? 'ok' : 'err';
    var v = it.ok ? '✓' : '✗';
    return '<li><span>' + it.name + (it.value ? '：' + it.value : '') + '</span><span class="' + cls + '">' + v + '</span></li>';
  }).join('') + '</ul>';
}

function diagnosticsSnapshot() {
  // 复制诊断信息（禁复制源码/cookie/token）
  var snap = {
    time: new Date().toISOString(),
    url: location?.href,
    runtimeId: window.__IDE_RUNNER__ && window.__IDE_RUNNER__.runtimeIds ? JSON.stringify(window.__IDE_RUNNER__.runtimeIds) : '',
    webAssembly: typeof WebAssembly !== 'undefined',
    worker: typeof Worker !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: typeof crossOriginIsolated === 'boolean' ? crossOriginIsolated : false,
    atomics: typeof Atomics !== 'undefined',
    cacheStorage: typeof caches !== 'undefined',
    indexedDB: typeof indexedDB !== 'undefined',
    readableStream: typeof ReadableStream !== 'undefined',
    userAgent: navigator.userAgent || ''
    // 不含：源码、cookie、token、session、stdin
  };
  return Object.keys(snap).map(function (k) { return k + ': ' + snap[k]; }).join('\n');
}
function copyDiagnostics() {
  var text = diagnosticsSnapshot();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { toast('诊断信息已复制', 'ok'); }, function () { fallbackCopy(text); });
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('诊断信息已复制', 'ok'); } catch (_) { toast('复制失败，请手动选择', 'err'); }
  document.body.removeChild(ta);
}

/* 渲染 Runtime Loading 进度条 */
function renderProgressBar(snap) {
  var box = $('runtime-progress');
  if (!box) return;
  // 仅当 stage 不是 IDLE 时显示
  if (snap.stage === 'IDLE') {
    box.classList.remove('active');
    return;
  }
  box.classList.add('active');
  var stageMap = {
    CHECK_CACHE: '检查缓存',
    DOWNLOAD_RUNTIME: '正在下载 Runtime',
    DOWNLOAD_SYSROOT: '正在下载 Sysroot',
    DOWNLOAD_STDLIB: '正在下载标准库',
    DOWNLOAD_PCH: '正在下载 PCH',
    INITIALIZE_WASM: '正在初始化 WASM',
    MOUNT_VFS: '正在挂载 VFS',
    WARMUP_COMPILER: '正在预热编译器',
    BOOT_JVM: '正在启动 OpenJDK 21…',
    INITIALIZE_COMPILER: '正在初始化 JavaCompiler…',
    READY: 'Runtime Ready',
    ERROR: '加载失败'
  };
  $('rp-stage').textContent = (stageMap[snap.stage] || snap.stage) + (snap.message ? ' · ' + snap.message : '');
  var fill = $('rp-fill');
  if (snap.indeterminate || snap.percent < 0) {
    fill.classList.add('indeterminate');
    $('rp-pct').textContent = '';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = Math.max(0, Math.min(100, snap.percent)) + '%';
    $('rp-pct').textContent = Math.round(snap.percent) + '%';
  }
  if (snap.totalBytes > 0) {
    $('rp-bytes').textContent = fmtBytes(snap.loadedBytes) + ' / ' + fmtBytes(snap.totalBytes);
  } else {
    $('rp-bytes').textContent = '';
  }
  if (snap.stage === 'ERROR' && snap.error) {
    $('rp-error').style.display = 'flex';
    $('rp-error-msg').textContent = '加载失败：' + snap.error;
    $('rp-retry').dataset.runtimeId = snap.runtimeId;
  } else {
    $('rp-error').style.display = 'none';
  }
  if (snap.stage === 'READY') {
    // 完成后 1.5s 自动隐藏进度条（避免常驻）
    setTimeout(function () { if (box) box.classList.remove('active'); }, 1500);
  }
}

/* Drawer open/close */
function openRuntimeDrawer() {
  $('runtime-drawer-mask').classList.add('active');
  $('runtime-drawer').classList.add('active');
  renderRuntimeDrawer();
}
function closeRuntimeDrawer() {
  $('runtime-drawer-mask').classList.remove('active');
  $('runtime-drawer').classList.remove('active');
}
$('ide-runtime-detail').addEventListener('click', openRuntimeDrawer);
$('runtime-drawer-close').addEventListener('click', closeRuntimeDrawer);
$('runtime-drawer-mask').addEventListener('click', closeRuntimeDrawer);
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeRuntimeDrawer(); });

/* 语言变更：刷新 Selector 状态、Tooltip、Drawer（若打开） */
$('ide-lang').addEventListener('change', function () {
  renderLangSelectorStatus();
  renderLangTooltip(this.value);
  if ($('runtime-drawer').classList.contains('active')) renderRuntimeDrawer();
});

/* 初始化 */
renderLangSelectorStatus();
renderLangTooltip($('ide-lang').value);

/* 订阅现代 Runtime 进度（冻结 Runtime 不上报；保持旧管线） */
function subscribeRuntimeProgress() {
  if (!window.__IDE_RUNNER__ || !window.__IDE_RUNNER__.onRuntimeProgress) return false;
  window.__IDE_RUNNER__.onRuntimeProgress(function (snaps) {
    // 渲染当前语言对应的进度；其他语言的进度不抢占
    var currentLang = $('ide-lang').value;
    var profileId = frontendLangToProfileId(currentLang);
    var snap = snaps.find(function (s) {
      return s.runtimeId === (profileId === 'c11' ? 'c11-gcc11-compat-v3'
        : profileId === 'cpp11' ? 'cpp11-gcc11-compat-v5'
        : profileId === 'python3' ? 'py312-cpython-compat-v1'
        : profileId === 'java21' ? 'java21-browserjdk-compat-v2'
        : (profileId === 'c17' || profileId === 'cpp17') ? 'cpp-modern-engine-v2'
        : '');
    });
    if (snap) renderProgressBar(snap);
    if (snap && snap.runtimeId === 'cpp-modern-engine-v2') {
      runtimeUiState.modernStage = snap.stage || 'IDLE';
      if (currentLang === 'c17' || currentLang === 'cpp17') renderSelectedRuntimeStatus();
    }
  });
  return true;
}
if (!subscribeRuntimeProgress()) {
  window.addEventListener('ide-runner-ready', subscribeRuntimeProgress, {once: true});
}

/* Retry 按钮（点击进度条内的"重试"） */
$('rp-retry').addEventListener('click', function () {
  var rid = this.dataset.runtimeId;
  if (!rid || !window.__IDE_RUNNER__) return;
  var retry = rid === 'java21-browserjdk-compat-v2'
    ? window.__IDE_RUNNER__.retryJavaRuntime
    : window.__IDE_RUNNER__.retryModernRuntime;
  if (typeof retry !== 'function') return;
  this.disabled = true;
  Promise.resolve(retry.call(window.__IDE_RUNNER__, rid, {})).finally(function () {
    this.disabled = false;
  }.bind(this));
});

/* 暴露工具函数供 onRun/onRunSamples 使用 */
window.__RUNTIME_UI__ = {
  renderCompileDetail: renderCompileDetail,
  classifyError: classifyError,
  errorBadgeHtml: errorBadgeHtml,
  showCompileDetail: function (r) {
    var det = $('ide-compile-detail');
    var body = $('ide-compile-detail-body');
    if (!det || !body) return;
    var html = renderCompileDetail(r);
    if (!html) { det.style.display = 'none'; return; }
    body.innerHTML = html;
    det.style.display = '';
  }
};

loadProblem();
