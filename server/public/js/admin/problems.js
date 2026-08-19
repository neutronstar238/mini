'use strict';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var editingId = null;
var contests = [];
var curContest = (new URLSearchParams(location.search).get('contest')) || '';

function letter(i) { return String.fromCharCode(65 + i); }

async function loadContests(selectElId) {
  var d = await api('/api/admin/contests');
  contests = d.contests;
  var fill = function (selId, keep) {
    var sel = document.getElementById(selId);
    sel.innerHTML = '<option value="">选择比赛</option>' + contests.map(function (c) {
      return '<option value="' + c.id + '"' + (keep === c.id ? ' selected' : '') + '>' + escapeHtml(c.title) + '</option>';
    }).join('');
  };
  fill('f-contest', curContest);
  fill('e-contest', curContest);
  // 若 URL 指定了比赛，同步下拉框
  if (curContest) document.getElementById('f-contest').value = curContest;
}

async function checkCompiler() {
  try {
    var d = await api('/api/admin/compiler');
    document.getElementById('compiler-tip').textContent = d.gxx ? '检测到服务器 g++：可自动生成测试数据。' : '未检测到服务器 g++：自动生成将失败，请改用下方手动输入测试数据。';
  } catch (_) { /* 忽略 */ }
}

async function load() {
  var tbody = document.getElementById('problem-tbody');
  var cid = document.getElementById('f-contest').value;
  try {
    var d = await api('/api/admin/problems');
    var list = cid ? d.problems.filter(function (p) { return p.contestId === cid; }) : d.problems;
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无题目</td></tr>'; return; }
    tbody.innerHTML = list.map(function (p, i) {
      return '<tr><td class="mono text-muted">' + p.id.slice(0, 6) + '</td><td>' + escapeHtml(p.title) + '</td>' +
        '<td class="mono text-muted">' + letter(i) + '</td>' +
        '<td class="mono text-muted">' + p.timeLimitMs + 'ms/' + p.memoryLimitMb + 'MB</td>' +
        '<td class="mono">' + (p.testcases || []).length + '</td>' +
        '<td class="mono text-muted">v' + (p.version || 1) + '</td>' +
        '<td><button class="btn btn-default btn-sm" onclick="edit(\'' + p.id + '\')">编辑</button> <button class="btn btn-danger btn-sm" onclick="del(\'' + p.id + '\',\'' + escapeHtml(p.title).replace(/'/g, "\\'") + '\')">删除</button></td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="7" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}

function parseCases(txt) {
  return txt ? txt.split('===').map(function (b) { var p = b.trim().split('|'); return { input: (p[0] || '').trim(), answer: (p[1] || '').trim() }; }) : [];
}

function open(problem) {
  editingId = problem ? problem.id : null;
  document.getElementById('editor-title').textContent = problem ? '编辑：' + problem.title : '新建题目';
  document.getElementById('e-title').value = problem ? problem.title : '';
  document.getElementById('e-contest').value = problem ? problem.contestId : (document.getElementById('f-contest').value || '');
  document.getElementById('e-time').value = problem ? problem.timeLimitMs : 1000;
  document.getElementById('e-mem').value = problem ? problem.memoryLimitMb : 256;
  document.getElementById('e-desc').value = problem ? problem.description : '';
  document.getElementById('e-gen').value = problem ? (problem.genCode || '') : '';
  document.getElementById('e-sol').value = problem ? (problem.solutionCode || '') : '';
  document.getElementById('e-cases').value = (problem ? problem.testcases : []).map(function (t) { return t.input + ' | ' + t.answer; }).join('\n===\n');
  document.getElementById('e-autogen').checked = true;
  document.getElementById('problem-editor').style.display = '';
}
window.edit = async function (id) { try { var d = await api('/api/admin/problems/' + id); open(d.problem); } catch (e) { toast(e.message, 'err'); } };
window.del = async function (id, title) { if (!confirm('删除「' + title + '」？')) return; try { await api('/api/admin/problems/' + id, { method: 'DELETE' }); toast('已删除'); load(); } catch (e) { toast(e.message, 'err'); } };
document.getElementById('new-problem-btn').addEventListener('click', function () { open(null); });
document.getElementById('editor-close').addEventListener('click', function () { document.getElementById('problem-editor').style.display = 'none'; });
document.getElementById('f-contest').addEventListener('change', function () { curContest = this.value; load(); });
document.getElementById('e-save').addEventListener('click', async function () {
  var contestId = document.getElementById('e-contest').value;
  if (!contestId) return toast('请选择所属比赛', 'err');
  var autoGen = document.getElementById('e-autogen').checked;
  var body = {
    title: document.getElementById('e-title').value.trim(), contestId: contestId,
    timeLimitMs: Number(document.getElementById('e-time').value) || 1000, memoryLimitMb: Number(document.getElementById('e-mem').value) || 256,
    description: document.getElementById('e-desc').value,
    genCode: document.getElementById('e-gen').value, solutionCode: document.getElementById('e-sol').value,
    autoGen: autoGen,
    testcases: parseCases(document.getElementById('e-cases').value)
  };
  if (!body.title) return toast('标题必填', 'err');
  if (autoGen && (!body.genCode.trim() || !body.solutionCode.trim())) return toast('已勾选自动生成，请填写 gen.cpp 与 solution.cpp', 'err');
  try {
    if (editingId) await api('/api/admin/problems/' + editingId, { method: 'PUT', body: JSON.stringify(body) });
    else await api('/api/admin/problems', { method: 'POST', body: JSON.stringify(body) });
    toast('已保存'); document.getElementById('problem-editor').style.display = 'none'; load();
  } catch (e) { toast(e.message, 'err'); }
});

loadContests().then(function () { load(); });
checkCompiler();
