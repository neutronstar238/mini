'use strict';
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
var cid = window.__CONTEST_ID__ || (new URLSearchParams(location.search).get('contest')) || '';
if (!cid) {
  // 无比赛上下文：回退到比赛列表
  location.href = '/contest/contests';
}
function letter(i) { return String.fromCharCode(65 + i); }

async function load() {
  var tbody = document.getElementById('problem-tbody');
  try {
    var d = await api('/api/contest/contests/' + cid + '/problems');
    document.title = (document.title ? '' : '') + (d.contest ? '题目 · ' + d.contest.title : '题目');
    var titleEl = document.getElementById('contest-title');
    if (titleEl && d.contest) titleEl.textContent = '· ' + d.contest.title;
    if (!d.problems.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无题目</td></tr>'; return; }
    tbody.innerHTML = d.problems.map(function (p, i) {
      return '<tr><td class="mono text-muted" style="text-align:center">' + letter(i) + ' / ' + escapeHtml(p.id.slice(0, 6)) + '</td>' +
        '<td><a href="/contest/contests/' + cid + '/problems/' + p.id + '">' + escapeHtml(p.title) + '</a></td>' +
        '<td style="text-align:right" class="text-success">' + p.acCount + '</td>' +
        '<td style="text-align:right" class="text-muted">' + p.submitCount + '</td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="4" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}

async function refreshStats() {
  try {
    var p = await api('/api/contest/contests/' + cid + '/submissions?status=PENDING&pageSize=1').catch(function () { return { total: 0 }; });
    document.getElementById('stat-pending').textContent = p.total || 0;
  } catch (_) { /* 忽略 */ }
}
sseConnect('/api/contest/events/stream', {
  queue_status: function (d) { document.getElementById('stat-pending').textContent = d.pending == null ? 0 : d.pending; }
});
refreshStats();
load();
