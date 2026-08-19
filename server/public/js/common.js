'use strict';
/** 前端公共工具：API 请求、Toast、状态渲染、SSE 帮助 */

function getToken() {
  return localStorage.getItem('token') || getCookie('token');
}
function getCookie(name) {
  var m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? m[2] : '';
}

async function api(path, opts) {
  opts = opts || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  var token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
  var data = {};
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    var err = new Error(data.error || ('请求失败 ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, type, ms) {
  type = type || 'ok';
  ms = ms || 2600;
  var root = document.getElementById('toast-root');
  if (!root) return alert(msg);
  var el = document.createElement('div');
  el.className = 'toast-oj toast-' + type;
  el.style.animation = 'toast-in .2s ease';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(function () { el.remove(); }, ms);
}

var STATUS_TEXT = {
  SUBMITTED: 'Submitted', PENDING: 'Pending', LEASED: 'Leased',
  COMPILING: 'Compiling', RUNNING: 'Running', VERIFYING: 'Verifying',
  AC: 'Accepted', WA: 'Wrong Answer', TLE: 'Time Limit Exceeded',
  MLE: 'Memory Limit Exceeded', RE: 'Runtime Error', CE: 'Compile Error', SE: 'System Error'
};

/* 仿 CCPCOJ：非终态为运行中（转圈+文本），终态用 Bootstrap 颜色徽章 */
function statusBadge(status) {
  var text = STATUS_TEXT[status] || status;
  var cls;
  if (['SUBMITTED', 'PENDING', 'LEASED', 'COMPILING', 'RUNNING', 'VERIFYING'].includes(status)) {
    return '<span class="res-running">' + text + ' <span class="res-spinner">⟳</span></span>';
  }
  switch (status) {
    case 'AC': cls = 'res-success'; break;
    case 'WA': cls = 'res-danger'; break;
    case 'TLE': cls = 'res-warning'; break;
    case 'MLE': cls = 'res-info'; break;
    case 'RE': cls = 'res-warning'; break;
    case 'CE': cls = 'res-info'; break;
    default: cls = 'res-default';
  }
  return '<span class="res-badge ' + cls + '">' + text + '</span>';
}

function caseDot(status) {
  return '<span class="case-dot case-' + status + '" title="' + (STATUS_TEXT[status] || status) + '"></span>';
}

function fmtTime(iso) {
  if (!iso) return '-';
  var d = new Date(iso);
  function p(n) { return String(n).padStart(2, '0'); }
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function fmtMs(ms) { return ms === undefined || ms === null ? '-' : ms + ' ms'; }
function fmtKb(kb) {
  if (kb === undefined || kb === null) return '-';
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
}

/** 建立 SSE 连接并自动重连 */
function sseConnect(path, handlers) {
  var es = new EventSource(path);
  Object.keys(handlers).forEach(function (event) {
    es.addEventListener(event, function (e) { handlers[event](JSON.parse(e.data)); });
  });
  es.onerror = function () {
    es.close();
    setTimeout(function () { es = sseConnect(path, handlers); }, 4000);
  };
  return es;
}

/** 激活侧边栏导航高亮 */
(function () {
  var p = location.pathname;
  document.querySelectorAll('.sidebar a').forEach(function (a) {
    var href = a.getAttribute('href');
    if (href && href !== '#' && (p === href || p.indexOf(href) === 0)) {
      var li = a.closest('li');
      if (li) li.classList.add('active');
    }
  });
})();
