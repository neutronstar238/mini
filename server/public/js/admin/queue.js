'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
async function load() {
  var tbody = document.getElementById('queue-tbody');
  try {
    var d = await api('/api/admin/queue');
    if (!d.submissions.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">队列空闲</td></tr>'; return; }
    tbody.innerHTML = d.submissions.map(function (s) {
      return '<tr><td class="mono text-muted">' + s.id.slice(0, 8) + '</td>' +
        '<td>' + escapeHtml(s.username) + '</td>' +
        '<td>' + escapeHtml(s.problemTitle) + '</td>' +
        '<td class="mono">' + (s.language === 'cpp' ? 'C++' : 'Python') + '</td>' +
        '<td>' + statusBadge(s.status) + '</td>' +
        '<td class="mono">' + (s.attempt || 0) + '</td>' +
        '<td class="mono text-muted">' + (s.workerId ? s.workerId.slice(0, 8) : '-') + '</td>' +
        '<td class="mono text-muted">' + fmtTime(s.createdAt) + '</td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="8" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
sseConnect('/api/admin/events/stream', { task_dispatch: load, task_report: load, lease_expired: load });
load();
setInterval(load, 8000);
