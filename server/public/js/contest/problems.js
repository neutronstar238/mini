'use strict';
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
async function load() {
  var q = document.getElementById('search').value.trim();
  var difficulty = document.getElementById('difficulty').value;
  var params = new URLSearchParams();
  if (q) params.set('q', q);
  if (difficulty !== 'all') params.set('difficulty', difficulty);
  var tbody = document.getElementById('problem-tbody');
  try {
    var d = await api('/api/contest/problems?' + params.toString());
    if (!d.problems.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无题目</td></tr>'; return; }
    tbody.innerHTML = d.problems.map(function (p, i) {
      var dc = p.difficulty === '简单' ? 'text-success' : p.difficulty === '中等' ? 'text-warning' : 'text-danger';
      return '<tr><td class="mono text-muted" style="text-align:center">' + (1000 + i + 1) + '</td>' +
        '<td><a href="/contest/problems/' + p.id + '">' + escapeHtml(p.title) + '</a></td>' +
        '<td style="text-align:center"><span class="' + dc + '">' + escapeHtml(p.difficulty) + '</span></td>' +
        '<td class="mono" style="font-size:12px">' + (p.tags || []).map(function (t) { return escapeHtml(t); }).join(' · ') + '</td>' +
        '<td style="text-align:right" class="text-success">' + p.acCount + '</td>' +
        '<td style="text-align:right" class="text-muted">' + p.submitCount + '</td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
function debounce(fn, ms) { var t; return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); }; }
document.getElementById('search').addEventListener('input', debounce(load, 250));
document.getElementById('difficulty').addEventListener('change', load);

async function refreshStats() {
  try {
    var p = await api('/api/contest/submissions?status=PENDING&pageSize=1').catch(function () { return { total: 0 }; });
    document.getElementById('stat-pending').textContent = p.total || 0;
  } catch (_) { /* 忽略 */ }
}
sseConnect('/api/contest/events/stream', {
  queue_status: function (d) { document.getElementById('stat-pending').textContent = d.pending == null ? 0 : d.pending; }
});
refreshStats();
load();
