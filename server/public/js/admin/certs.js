'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
async function load() {
  var tbody = document.getElementById('code-tbody');
  try {
    var d = await api('/api/admin/certs');
    tbody.innerHTML = d.codes.length ? d.codes.map(function (c) {
      return '<tr><td class="mono" style="color:#d9534f">' + escapeHtml(c.code) + '</td>' +
        '<td>' + (c.used ? '<span class="text-muted">已使用</span>' : '<span class="text-success">可用</span>') + '</td>' +
        '<td class="mono text-muted">' + (c.usedBy ? c.usedBy.slice(0, 13) + '…' : '-') + '</td>' +
        '<td class="mono text-muted">' + fmtTime(c.createdAt) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">暂无注册码</td></tr>';
  } catch (err) { tbody.innerHTML = '<tr><td colspan="4" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
document.getElementById('new-code-btn').addEventListener('click', async function () {
  try {
    var d = await api('/api/admin/certs', { method: 'POST' });
    toast('注册码已生成：' + d.code.code, 'ok', 5000); load();
  } catch (err) { toast(err.message, 'err'); }
});
load();
