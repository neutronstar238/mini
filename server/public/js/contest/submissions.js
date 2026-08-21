'use strict';
/** 我的提交（Phase 4 关系库主链路：QUEUED/JUDGING/FINISHED + verdict） */
var cid = window.__CONTEST_ID__ || (new URLSearchParams(location.search).get('contest')) || '';
if (!cid) location.href = '/contest/contests';
var state = { page: 1, status: 'all' };
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function langLabel(l) {
  if (l === 'c11') return 'C11';
  if (l === 'cpp11') return 'C++11';
  if (l === 'python3') return 'Python3';
  return l;
}
function statusLabel(s) {
  if (s === 'QUEUED') return 'Queued';
  if (s === 'JUDGING') return 'Judging';
  if (s === 'FINISHED') return 'Finished';
  if (s === 'SYSTEM_ERROR') return 'System Error';
  return s;
}
function verdictLabel(v) {
  return v || '';
}

async function load() {
  var tbody = document.querySelector('#sub-tbody');
  var pageInfo = document.getElementById('page-info');
  try {
    // Phase 4：调 /submissions/me（关系库），列表里展示最新 50 条（不返回 source）
    var d = await api('/api/contest/contests/' + cid + '/submissions/me');
    var list = d.submissions || [];
    // 状态过滤
    var filtered = state.status === 'all' ? list : list.filter(function (s) {
      if (state.status === 'QUEUED' || state.status === 'JUDGING' || state.status === 'FINISHED') return s.status === state.status;
      // 终态过滤（按 verdict）
      return s.status === 'FINISHED' && s.verdict === state.status;
    });
    // 分页（前端简单分页；接口返回最多 50 条）
    var pageSize = 20;
    var totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (state.page > totalPages) state.page = totalPages;
    var start = (state.page - 1) * pageSize;
    var pageRows = filtered.slice(start, start + pageSize);

    pageInfo.textContent = '第 ' + state.page + ' / ' + totalPages + ' 页 · 共 ' + filtered.length + ' 条';
    if (!pageRows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无记录</td></tr>'; return; }

    tbody.innerHTML = pageRows.map(function (s) {
      var display = (s.status === 'FINISHED' && s.verdict) ? s.verdict : s.status;
      var verdictText = (s.status === 'FINISHED' && s.verdict) ? verdictLabel(s.verdict) : statusLabel(s.status);
      var isRunning = (s.status === 'QUEUED' || s.status === 'JUDGING');
      return '<tr data-id="' + s.submissionId + '">' +
        '<td class="mono text-muted">' + s.submissionId.slice(0, 8) + '</td>' +
        '<td><a href="/contest/contests/' + cid + '/problems/' + s.problemId + '">' + escapeHtml(s.problemTitle || s.problemId) + '</a></td>' +
        '<td class="mono">' + escapeHtml(langLabel(s.language)) + '</td>' +
        '<td>' + (isRunning ? '<span class="res-running">' + verdictText + ' <span class="res-spinner">⟳</span></span>' : statusBadge(display)) + '</td>' +
        '<td class="mono" style="text-align:right">' + (s.executionTime != null ? s.executionTime + ' ms' : '-') + '</td>' +
        '<td class="mono" style="text-align:right">' + (s.memory != null ? (s.memory >= 1024 ? (s.memory/1024).toFixed(1) + ' MB' : s.memory + ' KB') : '-') + '</td>' +
        '<td class="mono text-muted">' + (s.serverReceivedAt ? fmtTime(s.serverReceivedAt) : '-') + '</td>' +
        '</tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="7" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}

// 点击行查看详情（读关系库 detail API）
document.querySelector('#sub-tbody').addEventListener('click', function (e) {
  var tr = e.target.closest('tr[data-id]');
  if (!tr || tr.classList.contains('detail-row')) return;
  var id = tr.dataset.id;
  var ex = document.querySelector('tr.detail-row'); if (ex) ex.remove();
  api('/api/contest/submissions/' + id).then(function (d) {
    var s = d.submission;
    var row = document.createElement('tr'); row.className = 'detail-row';
    var detail = '<div class="detail-drawer">';
    detail += '<div><b>语言：</b>' + escapeHtml(langLabel(s.language)) + '　<b>状态：</b>' + statusLabel(s.status) + (s.verdict ? ('　<b>Verdict：</b>' + s.verdict) : '') + '</div>';
    if (s.compileMessage) detail += '<pre class="code-block-oj mt-16" style="max-height:180px;overflow:auto">' + escapeHtml(s.compileMessage) + '</pre>';
    if (s.runtimeMessage) detail += '<pre class="code-block-oj mt-16" style="max-height:180px;overflow:auto">' + escapeHtml(s.runtimeMessage) + '</pre>';
    if (s.sourceCode) detail += '<details class="mt-16"><summary style="color:#337ab7;cursor:pointer">查看代码</summary><pre class="code-block-oj mt-16" style="max-height:300px;overflow:auto">' + escapeHtml(s.sourceCode) + '</pre></details>';
    detail += '</div>';
    row.innerHTML = '<td colspan="7">' + detail + '</td>';
    tr.after(row);
  }).catch(function (err) { toast(err.message, 'err'); });
});

// 状态过滤变化
document.getElementById('f-status').addEventListener('change', function (e) { state.status = e.target.value; state.page = 1; load(); });
document.getElementById('prev-page').addEventListener('click', function () { if (state.page > 1) { state.page--; load(); } });
document.getElementById('next-page').addEventListener('click', function () { state.page++; load(); });

// SSE：监听个人 submission_update（含 status+verdict）
sseConnect('/api/contest/events/stream', {
  submission_update: function (d) {
    // d 至少含 id + status（可能含 verdict）；刷新整页列表（关系库权威）
    if (d.contestId && d.contestId !== cid) return;
    var row = document.querySelector('tr[data-id="' + d.id + '"]');
    if (row) {
      // 就地更新状态单元格
      var display = (d.status === 'FINISHED' && d.verdict) ? d.verdict : d.status;
      var text = (d.status === 'FINISHED' && d.verdict) ? d.verdict : statusLabel(d.status);
      var cell = row.children[3];
      if (cell) {
        var isRunning = (d.status === 'QUEUED' || d.status === 'JUDGING');
        cell.innerHTML = isRunning
          ? '<span class="res-running">' + text + ' <span class="res-spinner">⟳</span></span>'
          : statusBadge(display);
      }
    } else {
      // 新提交：重新加载列表
      load();
    }
  }
});
load();