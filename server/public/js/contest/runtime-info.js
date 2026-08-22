'use strict';
/* ============================================================
 * runtime-info.js —— 独立 Runtime Info / FAQ 页逻辑
 *  - 从 /api/public/runtime-profiles 与 /api/public/faq 拉取
 *  - 不硬编码；与 language-profiles.js 同源
 * ============================================================ */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function kvCard(title, data) {
  var rows = [];
  Object.keys(data).forEach(function (k) {
    var v = data[k];
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return;
    rows.push('<div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(Array.isArray(v) ? v.join(' ') : v) + '</div>');
  });
  return '<h5>' + escapeHtml(title) + '</h5><div class="oj-drawer-kv">' + rows.join('') + '</div>';
}

function browserSupportLabel(profile) {
  var local = profile.localRuntime || {};
  return local.supported && local.enabled ? '支持' : '不支持';
}

function officialCompilerLabel(profile) {
  var labels = {
    c11: 'GCC 11',
    cpp11: 'G++ 11',
    c17: 'GCC 14',
    cpp17: 'G++ 14',
    python3: 'CPython 3.12',
    java21: 'OpenJDK 21'
  };
  return labels[profile.id] || (profile.officialJudge || {}).compiler || '未配置';
}

function renderRuntimeInfo() {
  var container = document.getElementById('runtime-info-list');
  if (!container) return;
  fetch('/api/public/runtime-profiles').then(function (r) { return r.json(); }).then(function (d) {
    var profiles = (d && d.profiles) || [];
    if (!profiles.length) {
      container.innerHTML = '<div class="text-muted">暂无 profile 数据</div>';
      return;
    }
    container.innerHTML = profiles.map(function (p) {
      return '<div class="oj-rtinfo-section">' +
        '<h3>' + escapeHtml(p.displayName) + '</h3>' +
        '<div class="oj-rtinfo-grid">' +
          '<div class="oj-rtinfo-card local">' + kvCard('Browser Local', { '浏览器本地运行': browserSupportLabel(p) }) + '</div>' +
          '<div class="oj-rtinfo-card official">' + kvCard('Official Judge', { '正式评测': officialCompilerLabel(p) }) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(function (e) {
    container.innerHTML = '<div class="text-muted">加载失败：' + escapeHtml(e && e.message || e) + '</div>';
  });
}

function renderFaq() {
  var container = document.getElementById('faq-list');
  if (!container) return;
  fetch('/api/public/faq').then(function (r) { return r.json(); }).then(function (d) {
    var items = (d && d.faq) || [];
    if (!items.length) {
      container.innerHTML = '<div class="text-muted">暂无 FAQ</div>';
      return;
    }
    container.innerHTML = items.map(function (it) {
      return '<details class="oj-compile-detail" style="margin-bottom:8px">' +
        '<summary><b>' + escapeHtml(it.category || '') + '</b> · ' + escapeHtml(it.question) + '</summary>' +
        '<div class="oj-compile-detail-body">' + escapeHtml(it.answer) + '</div>' +
      '</details>';
    }).join('');
  }).catch(function (e) {
    container.innerHTML = '<div class="text-muted">加载失败：' + escapeHtml(e && e.message || e) + '</div>';
  });
}

document.addEventListener('DOMContentLoaded', function () {
  if (document.getElementById('runtime-info-list')) renderRuntimeInfo();
  if (document.getElementById('faq-list')) renderFaq();
});
