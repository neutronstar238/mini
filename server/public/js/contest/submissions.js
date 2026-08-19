'use strict';
var cid = window.__CONTEST_ID__ || (new URLSearchParams(location.search).get('contest')) || '';
if (!cid) location.href = '/contest/contests';
var state = { page: 1, status: 'all' };
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
async function load() {
  var params = new URLSearchParams({ page: state.page, pageSize: 20, status: state.status });
  var tbody = document.querySelector('#sub-tbody');
  try {
    var d = await api('/api/contest/contests/' + cid + '/submissions?' + params.toString());
    document.getElementById('page-info').textContent = '第 ' + d.page + ' / ' + Math.max(1, Math.ceil(d.total / 20)) + ' 页 · 共 ' + d.total + ' 条';
    if (!d.submissions.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无记录</td></tr>'; return; }
    tbody.innerHTML = d.submissions.map(function (s) {
      var lv = s.localVerification ? '<span class="text-success">通过</span>' : '<span class="text-muted">跳过</span>';
      return '<tr data-id="' + s.id + '"><td class="mono text-muted">' + s.id.slice(0, 8) + '</td>' +
        '<td><a href="/contest/contests/' + cid + '/problems/' + s.problemId + '">' + escapeHtml(s.problemTitle) + '</a></td>' +
        '<td class="mono">' + (s.language === 'cpp' ? 'C++' : 'Python') + '</td>' +
        '<td>' + statusBadge(s.status) + '</td>' +
        '<td class="mono" style="text-align:right">' + fmtMs(s.timeMs) + '</td>' +
        '<td class="mono" style="text-align:right">' + fmtKb(s.memoryKb) + '</td>' +
        '<td>' + lv + '</td>' +
        '<td class="mono text-muted">' + fmtTime(s.createdAt) + '</td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="8" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
document.querySelector('#sub-tbody').addEventListener('click', function (e) {
  var tr = e.target.closest('tr[data-id]');
  if (!tr || tr.classList.contains('detail-row')) return;
  var id = tr.dataset.id;
  var ex = document.querySelector('tr.detail-row'); if (ex) ex.remove();
  api('/api/contest/submissions/' + id).then(function (d) {
    var s = d.submission;
    var row = document.createElement('tr'); row.className = 'detail-row';
    row.innerHTML = '<td colspan="8"><div class="detail-drawer"><div>' + (s.cases || []).map(function (c) {
      return '<span style="margin-right:12px;font-size:12px">' + caseDot(c.status) + ' #' + c.id + ' <span class="mono text-muted">' + (c.status === 'AC' ? 'OK' : c.status) + ' ' + c.time_ms + 'ms</span></span>';
    }).join('') + '</div>' +
      (s.message ? '<pre class="code-block-oj mt-16" style="max-height:180px;overflow:auto">' + escapeHtml(s.message) + '</pre>' : '') +
      '<details class="mt-16"><summary style="color:#337ab7;cursor:pointer">查看代码</summary><pre class="code-block-oj mt-16" style="max-height:300px;overflow:auto">' + escapeHtml(s.code) + '</pre></details></div></td>';
    tr.after(row);
  }).catch(function (err) { toast(err.message, 'err'); });
});
document.getElementById('f-status').addEventListener('change', function (e) { state.status = e.target.value; state.page = 1; load(); });
document.getElementById('prev-page').addEventListener('click', function () { if (state.page > 1) { state.page--; load(); } });
document.getElementById('next-page').addEventListener('click', function () { state.page++; load(); });
sseConnect('/api/contest/events/stream', {
  submission_update: function (d) {
    if (d.contestId && d.contestId !== cid) return;
    var row = document.querySelector('tr[data-id="' + d.id + '"]');
    if (row) { var c = row.children[3]; if (c) c.innerHTML = statusBadge(d.status); }
  },
  queue_status: function (d) { document.getElementById('pending-count').textContent = d.pending == null ? 0 : d.pending; }
});
load();
