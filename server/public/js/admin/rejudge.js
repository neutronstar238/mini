'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function getId() { return document.getElementById('submission-id').value.trim(); }
function show(msg) {
  document.getElementById('result-panel').style.display = '';
  document.getElementById('result-body').textContent = msg;
}
document.getElementById('btn-rejudge').addEventListener('click', async function () {
  var id = getId();
  if (!id) return toast('请输入提交 ID', 'err');
  try {
    var d = await api('/api/admin/rejudge', { method: 'POST', body: JSON.stringify({ submissionId: id }) });
    show('重判已发起，状态 → ' + d.status);
  } catch (err) { show('错误：' + err.message); }
});
document.getElementById('btn-spotcheck').addEventListener('click', async function () {
  var id = getId();
  if (!id) return toast('请输入提交 ID', 'err');
  try {
    var d = await api('/api/admin/spotcheck', { method: 'POST', body: JSON.stringify({ submissionId: id }) });
    show(d.ok ? '抽查已派发至第二 Worker：task=' + d.task.task_id.slice(0, 8) : '抽查失败：' + d.error);
  } catch (err) { show('错误：' + err.message); }
});
