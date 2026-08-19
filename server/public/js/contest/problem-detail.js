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

// 等待 ES Module 加载器就绪（window.__RUNNO__ 可用）
function ensureRunno() {
  if (window.__RUNNO__) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var done = false;
    function ok() { if (done) return; done = true; window.removeEventListener('runno-ready', ok); $('runtime-status').textContent = '浏览器运行时就绪 (Runno ' + RUNNO_VERSION + ')'; resolve(); }
    function fail(e) { if (done) return; done = true; window.removeEventListener('runno-ready', ok); $('runtime-status').textContent = '运行时加载失败'; reject(e); }
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

// 当前编译模式（本地运行默认 -O0 快速编译；性能估算模式 -O2）
function getOptLevel() {
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
  if (t.pchMs) parts.push('PCH 生成 ' + t.pchMs + 'ms（一次性）');
  parts.push('编译 ' + t.compileMs + 'ms');
  if (t.linkMs) parts.push('链接 ' + t.linkMs + 'ms');
  var extra = [];
  if (t.frontendMs != null) extra.push('前端≈' + t.frontendMs + 'ms');
  if (t.backendMs != null) extra.push('后端≈' + t.backendMs + 'ms');
  return '✓ 编译成功 · ' + parts.join(' · ') + (extra.length ? '（' + extra.join('，') + '）' : '');
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
  console.debug('[ide] ' + tag, {
    hash: t.hash, optLevel: t.optLevel, pch: !!t.pchUsed, cacheHit: !!t.cacheHit,
    'runtime/cache load': t.compilerInitMs ? t.compilerInitMs.vfsLoadMs + '+' + t.compilerInitMs.moduleInitMs : (t.runtimeLoadMs || 0),
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
  await ensureRunno();
  var t0 = performance.now();
  var abort = (opts && opts.abort) || null;
  var abortPromise = abort ? new Promise(function (_, reject) {
    abort._reject = reject;
  }) : null;

  // 优先走 ide-runner 轻量管线（Artifact Cache + 分段计时）；未就绪则回退 Runno headlessRunCode 旧管线
  var useRunner = await ensureIdeRunner();
  var invoke;
  if (useRunner) {
    var runners = {
      code: code, lang: lang, stdin: stdin || '',
      optLevel: getOptLevel(), pchLevel: 'auto', pchEnabled: pchEnabled(),
      killers: abort ? abort._killers : null
    };
    invoke = lang === 'python'
      ? window.__IDE_RUNNER__.runPython(runners)
      : window.__IDE_RUNNER__.runC(runners);
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
    if (result.aborted) return { __aborted: true, stdout: '', stderr: '', exitCode: -1, timeMs: 0, terminated: false, timeout: false };
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
  var isCpp = lang === 'cpp' || lang === 'c';

  var abort = newAbort();
  abortRun = abort;

  $('ide-output-wrap').style.display = '';
  $('ide-output-head').textContent = lang === 'python' ? 'Python 3' : (lang === 'c' ? 'C11' : 'C++11');
  $('ide-time').textContent = '运行中…（编译 ' + (isCpp ? 'C/C++' : 'Python') + '，可能需数秒）';
  $('ide-timing').textContent = '';
  $('ide-output').innerHTML = '<span style="color:#94a3b8">…</span>';
  btn.textContent = '◼ 中断';

  try {
    var r = await runIde(code, lang, stdin, { abort: abort });
    if (ver !== runVersion) return; // 已被新的点击作废，丢弃旧结果
    if (r.__aborted) { $('ide-time').textContent = '已中断'; $('ide-timing').textContent = ''; $('ide-output').innerHTML = '<span class="out-stderr">上一次运行已中断，点击「运行代码」重新开始</span>'; return; }
    // 主指标：运行时间 = 纯 Execution Time（编译耗时仅作次要信息，不计入）
    if (r.executionMs != null) {
      $('ide-time').textContent = '运行时间：' + fmtExecMs(r.executionMs) + ' ms';
    } else if (r.compileFailed) {
      $('ide-time').textContent = '✗ 编译失败';
    } else {
      $('ide-time').textContent = 'Local Runtime: ' + r.timeMs + ' ms（仅供参考）'; // 旧管线兜底
    }
    $('ide-timing').textContent = formatCompileInfo(r);
    var html = escapeHtml(r.stdout || '（无标准输出）');
    if (r.stderr) html += '<span class="out-stderr">\n[stderr]\n' + escapeHtml(r.stderr) + '</span>';
    if (r.exitCode !== 0) html += '\n[exit ' + r.exitCode + ']';
    $('ide-output').innerHTML = html;
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
          '<span class="res-badge res-danger">编译失败</span></div><pre class="output-oj">' + escapeHtml(r.stderr || '编译错误') + '</pre>';
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
        '<b>Sample ' + (i + 1) + '</b> <span class="res-badge ' + cls + '">' + status + '</span>' +
        '<span class="text-muted">运行 ' + timeText + '</span></div>' +
        (status === 'WA' ? '<pre class="output-oj">期望：' + escapeHtml(expect || '(空)') + '\n实际：' + escapeHtml(out || '(空)') + '</pre>' : '')
      );
    }
    if (ver === runVersion) {
      $('ide-samples-result').innerHTML =
        (compileSummary ? '<div class="text-muted" style="font-size:12px;margin-bottom:6px">' + compileSummary + ' · 以下为各样例运行时间</div>' : '') +
        rows.join('');
    }
  } catch (e) {
    if (ver === runVersion) $('ide-samples-result').innerHTML = '<span class="out-stderr">自测失败：' + escapeHtml(String(e.message || e)) + '</span>';
  } finally {
    if (abortRun === abort) abortRun = null;
    btn.textContent = '运行样例';
  }
}

/* ================= 提交（正式评测由服务器执行，此处保留入口） ================= */
document.getElementById('submit-btn').addEventListener('click', async function () {
  var code = $('ide-code').value;
  var language = $('ide-lang').value === 'c' ? 'cpp' : $('ide-lang').value;
  if (!code.trim()) return toast('代码不能为空', 'err');
  var btn = $('submit-btn');
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    var d = await api('/api/contest/contests/' + cid + '/submissions', {
      method: 'POST',
      body: JSON.stringify({ problemId: problemId, language: language, code: code, localVerification: true })
    });
    $('submit-result').style.display = '';
    $('sub-id').textContent = d.submission.id.slice(0, 8);
    $('sub-cases').innerHTML = '';
    trackSubmission(d.submission.id);
    toast('已提交');
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '提交'; }
});

function trackSubmission(id) {
  var statusEl = $('sub-status');
  statusEl.innerHTML = statusBadge('SUBMITTED');
  var stop = false;
  async function poll() {
    if (stop) return;
    try {
      var s = (await api('/api/contest/submissions/' + id)).submission;
      statusEl.innerHTML = statusBadge(s.status);
      $('sub-cases').innerHTML = renderCases(s.cases || []);
      if (['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'SE'].includes(s.status)) { stop = true; if (s.status === 'AC') toast('评测通过！'); return; }
    } catch (_) { /* ignore */ }
    setTimeout(poll, 1500);
  }
  poll();
  sseConnect('/api/contest/events/stream', {
    submission_update: function (d) {
      if (d.id !== id) return;
      statusEl.innerHTML = statusBadge(d.status);
      if (['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'SE'].includes(d.status)) { stop = true; poll(); }
    }
  });
}
function renderCases(cases) {
  if (!cases.length) return '';
  return cases.map(function (c) {
    return '<span style="margin-right:14px;font-size:12px">' + caseDot(c.status) + ' #' + c.id + ' <span class="mono text-muted">' + (c.status === 'AC' ? 'OK' : c.status) + ' ' + c.time_ms + 'ms</span></span>';
  }).join('');
}

$('ide-run').addEventListener('click', onRun);
$('ide-run-samples').addEventListener('click', onRunSamples);

// 语言预热：选中语言即后台初始化对应运行时（常驻编译器 Worker / Python runtime），不等首次点击运行
$('ide-lang').addEventListener('change', function () {
  if (window.__IDE_RUNNER__) window.__IDE_RUNNER__.prewarm(this.value);
});
ensureIdeRunner().then(function (ok) {
  if (ok) window.__IDE_RUNNER__.prewarm($('ide-lang').value);
});

// 后台 speculative compile：编辑器停止输入 1s 后用当前设置预编译，点击 Run 时直接命中缓存
var speculateTimer = null;
$('ide-code').addEventListener('input', function () {
  clearTimeout(speculateTimer);
  speculateTimer = setTimeout(function () {
    if (!window.__IDE_RUNNER__ || !window.__IDE_RUNNER__.speculate) return;
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

loadProblem();
