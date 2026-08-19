'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var editingId = null;
var STATUS_LABEL = { ongoing: '进行中', upcoming: '未开始', ended: '已结束' };

function fmtStart(ms) {
  if (!ms) return '-';
  var d = new Date(ms);
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function toLocalInput(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function load() {
  var tbody = document.getElementById('contest-tbody');
  try {
    var d = await api('/api/admin/contests');
    if (!d.contests.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无比赛，点右上角发布</td></tr>'; return; }
    tbody.innerHTML = d.contests.map(function (c, i) {
      return '<tr><td class="mono text-muted">' + (c.id.slice(0, 6)) + '</td>' +
        '<td><a href="/admin/problems?contest=' + c.id + '">' + escapeHtml(c.title) + '</a> ' +
        '<span class="text-muted" style="font-size:12px">' + escapeHtml(c.description || '') + '</span></td>' +
        '<td class="mono">' + (c.problemIds || []).length + '</td>' +
        '<td class="mono text-muted">' + fmtStart(c.startTimeMs) + '</td>' +
        '<td><span class="res-badge ' + (c.status === 'ongoing' ? 'res-success' : c.status === 'upcoming' ? 'res-warning' : 'res-default') + '">' + STATUS_LABEL[c.status] + '</span></td>' +
        '<td><button class="btn btn-default btn-sm" onclick="edit(\'' + c.id + '\')">编辑</button> <button class="btn btn-primary btn-sm" onclick="gotoProblems(\'' + c.id + '\')">出题</button> <button class="btn btn-danger btn-sm" onclick="del(\'' + c.id + '\',\'' + escapeHtml(c.title).replace(/'/g, "\\'") + '\')">删除</button></td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
window.gotoProblems = function (id) { location.href = '/admin/problems?contest=' + id; };
function open(c) {
  editingId = c ? c.id : null;
  document.getElementById('editor-title').textContent = c ? '编辑：' + c.title : '发布比赛';
  document.getElementById('c-title').value = c ? c.title : '';
  document.getElementById('c-start').value = c ? toLocalInput(c.startTimeMs) : '';
  document.getElementById('c-desc').value = c ? (c.description || '') : '';
  document.getElementById('contest-editor').style.display = '';
}
window.edit = async function (id) { try { var d = await api('/api/admin/contests/' + id); open(d.contest); } catch (e) { toast(e.message, 'err'); } };
window.del = async function (id, title) { if (!confirm('删除比赛「' + title + '」？该比赛下题目与提交将一并删除。')) return; try { await api('/api/admin/contests/' + id, { method: 'DELETE' }); toast('已删除'); load(); } catch (e) { toast(e.message, 'err'); } };
document.getElementById('new-contest-btn').addEventListener('click', function () { open(null); });
document.getElementById('editor-close').addEventListener('click', function () { document.getElementById('contest-editor').style.display = 'none'; });
document.getElementById('c-save').addEventListener('click', async function () {
  var title = document.getElementById('c-title').value.trim();
  var startVal = document.getElementById('c-start').value;
  if (!title) return toast('标题必填', 'err');
  if (!startVal) return toast('请设置开始时间', 'err');
  var startTimeMs = new Date(startVal).getTime();
  var body = { title: title, description: document.getElementById('c-desc').value.trim(), startTimeMs: startTimeMs };
  try {
    if (editingId) await api('/api/admin/contests/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/contests', { method: 'POST', body: JSON.stringify(body) });
    toast('已保存'); document.getElementById('contest-editor').style.display = 'none'; load();
  } catch (e) { toast(e.message, 'err'); }
});
load();
