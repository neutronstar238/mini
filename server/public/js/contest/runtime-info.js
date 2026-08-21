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
      var local = p.localRuntime || {};
      var off = p.officialJudge || {};
      var statusDot = !local.supported ? 'unavailable'
        : (local.status === 'READY' || local.status === 'BETA_FROZEN') ? 'ready'
        : (local.status === 'PENDING' || local.status === 'EXPERIMENTAL' || local.status === 'LOCAL_PREVIEW') ? 'beta' : 'loading';
      var statusLabel = local.supported ? (local.status || 'PENDING') : 'UNAVAILABLE';
      if (statusLabel === 'BETA_FROZEN') statusLabel = 'BETA FROZEN';
      if (local.enabled && statusLabel === 'LOCAL_PREVIEW') statusLabel = 'ENABLED / LOCAL_PREVIEW';

      var localData = {
        'Browser Local': statusLabel,
        'Runtime ID': local.runtimeId,
        'Compiler': local.compiler,
        'Compiler Version': local.compilerVersion,
        'Language Standard': local.standard,
        'Target Triple': local.target,
        'Sysroot': local.sysrootVersion,
        'Runtime Asset Hash': local.assetHash,
        'PCH Policy': local.pchPolicy,
        'Status': statusLabel,
        'Mode': local.preview ? 'LOCAL PREVIEW' : null,
        'Technical Validation': local.technicalValidated ? 'PASS' : null,
        'Engineering Redistribution': local.engineeringRedistributionReady ? 'READY' : null,
        'Legal Redistribution': local.legalReviewRequired ? 'PENDING REVIEW' : null,
        'Redistributable': local.legalReviewRequired ? String(!!local.redistributable) : null
      };
      var offData = {
        'Official Judge': off.referenceStatus,
        'OS': off.os,
        'Compiler': off.compiler,
        'Compiler Version': off.compilerVersion,
        'Language Standard': off.standard,
        'Compile Flags': off.compileFlags,
        'Run Flags': off.runFlags,
        'Time Adjustment': off.timeAdjustment,
        'Memory Adjustment': off.memoryAdjustment,
        'Reference Status': off.referenceStatus,
        'Formal Submit': p.submissionEnabled ? 'ENABLED' : 'DISABLED'
      };

      return '<div class="oj-rtinfo-section">' +
        '<h3>' + escapeHtml(p.displayName) + ' <span class="oj-runtime-dot ' + statusDot + '"></span><span style="font-size:13px;color:#6b7280">' + statusLabel + '</span></h3>' +
        '<div class="sub">Profile ID: <code>' + escapeHtml(p.id) + '</code></div>' +
        '<div class="oj-rtinfo-grid">' +
          '<div class="oj-rtinfo-card local">' + kvCard('Browser Local', localData) + '</div>' +
          '<div class="oj-rtinfo-card official">' + kvCard('Official Judge', offData) + '</div>' +
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
