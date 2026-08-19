'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var editingId = null;
async function load() {
  var tbody = document.getElementById('problem-tbody');
  try {
    var d = await api('/api/admin/problems');
    if (!d.problems.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无题目</td></tr>'; return; }
    tbody.innerHTML = d.problems.map(function (p, i) {
      var dc = p.difficulty === '简单' ? 'text-success' : p.difficulty === '中等' ? 'text-warning' : 'text-danger';
      return '<tr><td class="mono text-muted">' + (1000 + i + 1) + '</td><td>' + escapeHtml(p.title) + '</td>' +
        '<td><span class="' + dc + '">' + escapeHtml(p.difficulty) + '</span></td>' +
        '<td class="mono text-muted">' + p.timeLimitMs + 'ms/' + p.memoryLimitMb + 'MB</td>' +
        '<td class="mono">' + (p.testcases || []).length + '</td>' +
        '<td class="mono text-muted">v' + (p.version || 1) + '</td>' +
        '<td><button class="btn btn-default btn-sm" onclick="edit(\'' + p.id + '\')">编辑</button> <button class="btn btn-danger btn-sm" onclick="del(\'' + p.id + '\',\'' + escapeHtml(p.title).replace(/'/g, "\\'") + '\')">删除</button></td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="7" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
function open(problem) {
  editingId = problem ? problem.id : null;
  document.getElementById('editor-title').textContent = problem ? '编辑：' + problem.title : '新建题目';
  document.getElementById('e-title').value = problem ? problem.title : '';
  document.getElementById('e-diff').value = problem ? problem.difficulty : '简单';
  document.getElementById('e-time').value = problem ? problem.timeLimitMs : 1000;
  document.getElementById('e-mem').value = problem ? problem.memoryLimitMb : 256;
  document.getElementById('e-desc').value = problem ? problem.description : '';
  document.getElementById('e-tags').value = (problem ? problem.tags : []).join(',');
  document.getElementById('e-cases').value = (problem ? problem.testcases : []).map(function (t) { return t.input + ' | ' + t.answer; }).join('\n===\n');
  document.getElementById('problem-editor').style.display = '';
}
window.edit = async function (id) { try { var d = await api('/api/admin/problems/' + id); open(d.problem); } catch (e) { toast(e.message, 'err'); } };
window.del = async function (id, title) { if (!confirm('删除「' + title + '」？')) return; try { await api('/api/admin/problems/' + id, { method: 'DELETE' }); toast('已删除'); load(); } catch (e) { toast(e.message, 'err'); } };
document.getElementById('new-problem-btn').addEventListener('click', function () { open(null); });
document.getElementById('editor-close').addEventListener('click', function () { document.getElementById('problem-editor').style.display = 'none'; });
document.getElementById('e-save').addEventListener('click', async function () {
  var txt = document.getElementById('e-cases').value.trim();
  var testcases = txt ? txt.split('===').map(function (b) { var p = b.trim().split('|'); return { input: (p[0] || '').trim(), answer: (p[1] || '').trim() }; }) : [];
  var body = {
    title: document.getElementById('e-title').value.trim(), difficulty: document.getElementById('e-diff').value,
    timeLimitMs: Number(document.getElementById('e-time').value) || 1000, memoryLimitMb: Number(document.getElementById('e-mem').value) || 256,
    description: document.getElementById('e-desc').value, tags: document.getElementById('e-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean), testcases: testcases
  };
  if (!body.title) return toast('标题必填', 'err');
  try {
    if (editingId) await api('/api/admin/problems/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/problems', { method: 'POST', body: JSON.stringify(body) });
    toast('已保存'); document.getElementById('problem-editor').style.display = 'none'; load();
  } catch (e) { toast(e.message, 'err'); }
});
load();
