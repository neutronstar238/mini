'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtDetail(d) {
  return Object.keys(d).map(function (k) { return k + '=' + (typeof d[k] === 'string' ? d[k].slice(0, 24) : d[k]); }).join(' ');
}
function push(line, cls) {
  var box = document.getElementById('audit-stream');
  if (box.querySelector('.text-muted')) box.innerHTML = '';
  var el = document.createElement('div');
  el.className = 'event-line ' + (cls || '');
  el.innerHTML = '<span class="t">' + fmtTime(new Date().toISOString()) + '</span><span>' + line + '</span>';
  box.prepend(el);
  while (box.children.length > 200) box.lastChild.remove();
}
async function load() {
  var box = document.getElementById('audit-stream');
  try {
    var d = await api('/api/admin/audit');
    box.innerHTML = d.events.map(function (e) {
      var bad = ['verify_failed', 'report_reject', 'lease_expired'].includes(e.type) ? 'bad' : (['report', 'approve'].includes(e.type) ? 'ok' : '');
      return '<div class="event-line ' + bad + '"><span class="t">' + fmtTime(e.at) + '</span><b>[' + e.type + ']</b> ' + fmtDetail(e.detail) + '</div>';
    }).join('');
  } catch (err) { box.innerHTML = '<div class="text-muted" style="text-align:center;padding:20px">' + escapeHtml(err.message) + '</div>'; }
}
sseConnect('/api/admin/events/stream', {
  snapshot: function () { load(); },
  task_dispatch: function (d) { push('<b>[下发]</b> ' + d.submission_id.slice(0, 8) + ' → ' + d.worker.slice(0, 8), 'ok'); },
  task_report: function (d) { push('<b>[回传]</b> ' + d.submission_id.slice(0, 8) + ' → ' + d.status, 'ok'); },
  lease_expired: function (d) { push('<b>[租约超时]</b> ' + d.submission_id.slice(0, 8) + ' attempt=' + d.attempt, 'bad'); },
  worker_anomaly: function (d) { push('<b>[异常]</b> ' + d.reason, 'bad'); },
  spotcheck_mismatch: function (d) { push('<b>[抽查不一致]</b> ' + d.submission_id.slice(0, 8) + ' 原=' + d.orig + ' 复=' + d.recheck, 'bad'); }
});
load();
