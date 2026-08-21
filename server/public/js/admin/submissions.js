'use strict';
/* Admin 提交查询（Phase 5 · 关系库）：分页 + 过滤 + 详情（含源码 + Rejudge） */
var preselectCid = window.__CONTEST_ID__ || '';
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmtTime(iso) { if (!iso) return '-'; var d = new Date(iso); function p(n) { return String(n).padStart(2, '0'); } return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
function verdictBadge(s) {
  var display = (s.status === 'FINISHED' && s.verdict) ? s.verdict : s.status;
  return statusBadge ? statusBadge(display) : escapeHtml(display);
}
function langLabel(l) { if (l === 'c11') return 'C11'; if (l === 'cpp11') return 'C++11'; if (l === 'python3') return 'Python3'; return l || '-'; }

var state = { contestId: preselectCid, page: 1, pageSize: 20, filters: {} };

/* 加载比赛下拉 */
async function loadContests() {
  try {
    var d = await api('/api/admin/contests');
    var sel = document.getElementById('f-contest');
    sel.innerHTML = '<option value="">全部比赛</option>' + (d.contests || []).map(function (c) {
      return '<option value="' + c.id + '"' + (c.id === state.contestId ? ' selected' : '') + '>' + escapeHtml(c.title) + '</option>';
    }).join('');
  } catch (e) { toast(e.message, 'err'); }
}

async function load() {
  var tbody = document.getElementById('sub-tbody');
  var info = document.getElementById('page-info');
  if (!state.contestId) { tbody.innerHTML = '<tr><td colspan="9" class="empty">请先选择比赛</td></tr>'; info.textContent = ''; return; }
  try {
    var qs = new URLSearchParams({ page: state.page, pageSize: state.pageSize });
    Object.keys(state.filters).forEach(function (k) { if (state.filters[k]) qs.set(k, state.filters[k]); });
    var d = await api('/api/admin/contests/' + state.contestId + '/submissions?' + qs.toString());
    var list = d.submissions || [];
    info.textContent = '共 ' + d.total + ' 条 · 第 ' + d.page + ' / ' + Math.max(1, Math.ceil(d.total / state.pageSize)) + ' 页';
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无提交</td></tr>'; return; }
    tbody.innerHTML = list.map(function (s) {
      return '<tr data-id="' + s.id + '">' +
        '<td class="mono text-muted">' + s.id.slice(0, 8) + '</td>' +
        '<td class="mono">' + escapeHtml(s.problemLabel || '-') + '</td>' +
        '<td>' + escapeHtml(s.problemTitle || s.problemId) + '</td>' +
        '<td class="mono text-muted">' + escapeHtml(s.username || s.userId) + '</td>' +
        '<td class="mono">' + langLabel(s.language) + '</td>' +
        '<td>' + verdictBadge(s) + '</td>' +
        '<td class="mono" style="text-align:right">' + (s.executionTimeMs != null ? s.executionTimeMs + ' ms' : '-') + '</td>' +
        '<td class="mono text-muted">' + fmtTime(s.serverReceivedAt) + '</td>' +
        '<td><button class="btn btn-default btn-xs" onclick="showDetail(\'' + s.id + '\')">详情</button></td>' +
        '</tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="9" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}

/* 详情（含源码 / compile / runtime） + Rejudge 按钮 */
window.showDetail = async function (id) {
  var ex = document.querySelector('tr.detail-row'); if (ex) ex.remove();
  var tbody = document.getElementById('sub-tbody');
  var sourceRow = tbody.querySelector('tr[data-id="' + id + '"]');
  try {
    var d = await api('/api/admin/submissions/' + id);
    var s = d.submission;
    var row = document.createElement('tr'); row.className = 'detail-row';
    var html = '<div class="detail-drawer">';
    html += '<div class="flex-between"><div><b>提交：</b><span class="mono">' + s.id + '</span></div>' +
      '<div><b>用户：</b>' + escapeHtml(s.username || s.userId) + '　<b>题目：</b>' + escapeHtml(s.problemTitle || s.problemId) +
      '　<b>语言：</b>' + langLabel(s.language) + '　<b>状态：</b>' + verdictBadge(s) + '</div></div>';
    html += '<div class="mt-8 text-muted" style="font-size:12px">提交 ' + fmtTime(s.serverReceivedAt) + ' · 评测 ' + fmtTime(s.judgeFinishedAt) + '</div>';
    if (s.verdict) html += '<div class="mt-8"><b>Official Verdict：</b>' + escapeHtml(s.verdict) + '</div>';
    if (s.compileMessage) html += '<pre class="code-block-oj mt-16" style="max-height:150px;overflow:auto">' + escapeHtml(s.compileMessage) + '</pre>';
    if (s.runtimeMessage) html += '<pre class="code-block-oj mt-16" style="max-height:150px;overflow:auto">' + escapeHtml(s.runtimeMessage) + '</pre>';
    if (s.sourceCode) html += '<details class="mt-16"><summary style="color:#337ab7;cursor:pointer">查看源码</summary><pre class="code-block-oj mt-16" style="max-height:300px;overflow:auto">' + escapeHtml(s.sourceCode) + '</pre></details>';
    html += '<div class="mt-16"><button class="btn btn-warning btn-sm" id="btn-rejudge-detail" data-id="' + s.id + '">Rejudge 重判</button></div>';
    html += '</div>';
    row.innerHTML = '<td colspan="9">' + html + '</td>';
    if (sourceRow) sourceRow.insertAdjacentElement('afterend', row);
    else tbody.prepend(row);
    document.getElementById('btn-rejudge-detail').addEventListener('click', async function () {
      var rid = this.dataset.id;
      if (!confirm('确认重判提交 ' + rid.slice(0, 8) + '？榜单将随之回滚/更新。')) return;
      try {
        var r = await api('/api/admin/submissions/' + rid + '/rejudge', { method: 'POST' });
        toast('重判已发起：' + (r.status || 'QUEUED'), 'ok');
        setTimeout(load, 3000); // 等评测完成后刷新
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (err) { toast(err.message, 'err'); }
};

document.getElementById('btn-search').addEventListener('click', function () {
  state.contestId = document.getElementById('f-contest').value;
  state.filters = {
    problemId: document.getElementById('f-problem').value.trim(),
    userId: document.getElementById('f-user').value.trim(),
    language: document.getElementById('f-language').value,
    verdict: document.getElementById('f-verdict').value
  };
  state.page = 1;
  load();
});
document.getElementById('btn-reset').addEventListener('click', function () {
  ['f-contest', 'f-problem', 'f-user', 'f-language', 'f-verdict'].forEach(function (id) { document.getElementById(id).value = ''; });
  state.contestId = ''; state.filters = {}; state.page = 1; load();
});
document.getElementById('prev-page').addEventListener('click', function () { if (state.page > 1) { state.page--; load(); } });
document.getElementById('next-page').addEventListener('click', function () { state.page++; load(); });

loadContests().then(load);
