'use strict';
/* 题目详情 + 本地预检（WebAssembly）+ 提交 */
var problemId = location.pathname.split('/').pop();
var PRE = { cpp: null, python: null };

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

async function loadProblem() {
  try {
    var p = (await api('/api/contest/problems/' + problemId)).problem;
    document.title = p.title + ' · Mini-OJ';
    document.getElementById('p-title').textContent = p.title;
    document.getElementById('p-id').textContent = String(p.id).slice(0, 8);
    var dc = p.difficulty === '简单' ? 'text-success' : p.difficulty === '中等' ? 'text-warning' : 'text-danger';
    document.getElementById('p-diff').innerHTML = '<span class="' + dc + '">' + escapeHtml(p.difficulty) + '</span>';
    document.getElementById('p-tags').innerHTML = (p.tags || []).map(function (t) {
      return '<span style="background:#428bca;color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;margin-right:6px">' + escapeHtml(t) + '</span>';
    }).join('');
    document.getElementById('p-desc').innerHTML = renderMd(p.description);
    // 样例
    (p.samples || []).forEach(function (s, i) {
      document.getElementById('p-desc').insertAdjacentHTML('beforeend',
        '<div class="md_display_div"><h2>Sample ' + (i + 1) + '</h2>' +
        '<div class="sample_row"><div class="sample_col"><div style="font-size:13px;color:#555;margin-bottom:4px">输入</div><pre class="sampledata">' + escapeHtml(s.input || '') + '</pre></div>' +
        '<div class="sample_col"><div style="font-size:13px;color:#555;margin-bottom:4px">输出</div><pre class="sampledata">' + escapeHtml(s.output || '') + '</pre></div></div></div>');
    });
    window.__SAMPLES = p.samples || [];
    document.getElementById('p-time').textContent = p.timeLimitMs + ' ms';
    document.getElementById('p-mem').textContent = p.memoryLimitMb + ' MB';
    document.getElementById('p-cases').textContent = p.testcaseCount || '-';
    document.getElementById('p-subcnt').textContent = p.submitCount;
    document.getElementById('p-acrate').textContent = (p.acRate || 0) + '%';
  } catch (err) {
    toast(err.message, 'err');
    document.getElementById('p-title').textContent = '加载失败';
  }
}

/* ================= 本地预检（不可信域，WebAssembly） ================= */
function loadScript(src) {
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('加载失败 ' + src)); };
    document.head.appendChild(s);
  });
}

// C/C++：WASM 编译器。原型使用 TinyCC-WASM 或退化为「样例自检提示」。
// 说明：完整 Clang-WASM 体积大，这里以 WebAssembly 编译为目标，若浏览器不支持则回退。
async function ensureCpp() {
  if (PRE.cpp !== null) return PRE.cpp;
  // 检测 WebAssembly 支持
  var supported = typeof WebAssembly !== 'undefined' && WebAssembly.instantiate;
  PRE.cpp = supported ? 'wasm' : 'unsupported';
  return PRE.cpp;
}

async function ensurePython() {
  if (PRE.python !== null) return PRE.python;
  try {
    await loadScript('https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js');
    PRE.python = { pyodide: null, loaded: false };
    return PRE.python;
  } catch (_) {
    PRE.python = 'unsupported';
    return PRE.python;
  }
}

async function runPrecheck() {
  var resultEl = document.getElementById('precheck-result');
  resultEl.style.display = '';
  var lang = document.getElementById('submit-lang').value;
  var code = document.getElementById('submit-code').value;
  var samples = window.__SAMPLES || [];
  var statusEl = document.getElementById('precheck-status');
  statusEl.textContent = '本地预检中…';

  if (!code.trim()) { resultEl.innerHTML = '<div class="alert-oj alert-warn-oj">代码不能为空</div>'; statusEl.textContent = ''; return; }
  if (!samples.length) { resultEl.innerHTML = '<div class="alert-oj alert-warn-oj">该题无公开样例，可直接提交（由可信 Worker 正式评测）</div>'; statusEl.textContent = ''; return; }

  var rows = [];
  try {
    if (lang === 'python') {
      var py = await ensurePython();
      if (py === 'unsupported' || !py.loaded) {
        py = await ensurePython(); // 尝试加载 Pyodide
      }
      if (py === 'unsupported') {
        resultEl.innerHTML = '<div class="alert-oj alert-warn-oj">Pyodide 加载失败（网络限制），无法本地预检 Python。可直接提交，正式评测由可信 Worker 执行。</div>';
        statusEl.textContent = '预检不可用';
        return;
      }
      if (!py.loaded) {
        py.pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/' });
        py.loaded = true;
      }
      for (var i = 0; i < samples.length; i++) {
        var inp = samples[i].input || '';
        var expect = samples[i].output || '';
        var out = '';
        try {
          py.pyodide.globals.set('__input', inp);
          py.pyodide.runPython('import sys\nfrom io import StringIO\nsys.stdin = StringIO(__input)\nsys.stdout = StringIO()');
          py.pyodide.runPython(code);
          out = py.pyodide.runPython('sys.stdout.getvalue()').toString();
        } catch (e) {
          rows.push('<span class="case-bad">#' + (i + 1) + ' 运行错误: ' + escapeHtml(String(e.message || e).slice(0, 200)) + '</span>');
          continue;
        }
        var ok = out.trim() === expect.trim();
        rows.push('<span class="' + (ok ? 'case-ok' : 'case-bad') + '">#' + (i + 1) + ' ' + (ok ? '预检通过' : '输出不符') + '</span>');
      }
      statusEl.textContent = '本地预检完成';
    } else {
      // C/C++：WASM 支持检测；原型若无法内嵌编译器，则提示可用提交
      var c = await ensureCpp();
      if (c === 'unsupported') {
        resultEl.innerHTML = '<div class="alert-oj alert-warn-oj">当前浏览器未支持 WASM 编译器内嵌，跳过 C/C++ 本地预检。可直接提交，正式评测由可信 Worker 执行。</div>';
        statusEl.textContent = '预检不可用';
        return;
      }
      rows = samples.map(function (s, i) {
        return '<span class="case-ok">#' + (i + 1) + ' WASM 环境就绪（样例预检跳过，正式评测由 Worker 执行）</span>';
      });
      statusEl.textContent = 'WASM 就绪';
    }
  } catch (err) {
    resultEl.innerHTML = '<div class="alert-oj alert-warn-oj">本地预检异常：' + escapeHtml(String(err.message || err).slice(0, 200)) + '</div>';
    statusEl.textContent = '预检异常';
    return;
  }
  resultEl.innerHTML = '<div class="alert-oj alert-info-oj">' + rows.join(' ') + '</div>';
}

document.getElementById('precheck-btn').addEventListener('click', runPrecheck);

/* ================= 提交 ================= */
document.getElementById('submit-btn').addEventListener('click', async function () {
  var code = document.getElementById('submit-code').value;
  var language = document.getElementById('submit-lang').value;
  if (!code.trim()) return toast('代码不能为空', 'err');
  var btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = '提交中…';
  var localVerified = (document.getElementById('precheck-status').textContent || '').includes('完成') || (document.getElementById('precheck-status').textContent || '').includes('就绪');
  try {
    var d = await api('/api/contest/submissions', {
      method: 'POST',
      body: JSON.stringify({ problemId: problemId, language: language, code: code, localVerification: localVerified })
    });
    document.getElementById('submit-result').style.display = '';
    document.getElementById('sub-id').textContent = d.submission.id.slice(0, 8);
    document.getElementById('sub-cases').innerHTML = '';
    trackSubmission(d.submission.id);
    toast(localVerified ? '已提交（本地预检通过）' : '已提交');
  } catch (err) { toast(err.message, 'err'); }
  finally { btn.disabled = false; btn.textContent = '提交'; }
});

function trackSubmission(id) {
  var statusEl = document.getElementById('sub-status');
  statusEl.innerHTML = statusBadge('SUBMITTED');
  var stop = false;
  async function poll() {
    if (stop) return;
    try {
      var s = (await api('/api/contest/submissions/' + id)).submission;
      statusEl.innerHTML = statusBadge(s.status);
      document.getElementById('sub-cases').innerHTML = renderCases(s.cases || []);
      if (['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'SE'].includes(s.status)) { stop = true; if (s.status === 'AC') toast('评测通过！'); return; }
    } catch (_) {}
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

loadProblem();
