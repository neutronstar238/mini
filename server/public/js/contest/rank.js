'use strict';
/* ICPC 榜单页：双层表头（Rank/Team/Solved/Penalty + 每题列头字母与 ac·submit），SSE 增量更新 */
var cid = window.__CONTEST_ID__ || (new URLSearchParams(location.search).get('contest')) || '';
if (!cid) location.href = '/contest/contests';

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function letter(i) { return String.fromCharCode(65 + i); }

var cached = null; // { version, problems:[], rows:[], colStats:{} }
var nextSyncAt = 0;

/* 渲染双层表头 + 数据行 */
function render(snap) {
  cached = snap;
  var head = document.getElementById('rank-head');
  var tbody = document.getElementById('rank-tbody');
  var problems = snap.problems || [];
  var colStats = snap.colStats || {};

  // 表头第一层：Rank/Team/Solved/Penalty + 每题字母
  var h1 = '<tr>' +
    '<th style="width:60px;text-align:center">Rank</th>' +
    '<th>Team</th>' +
    '<th style="width:70px;text-align:center">Solved</th>' +
    '<th style="width:90px;text-align:center">Penalty</th>';
  var h2 = '<tr>' +
    '<th></th><th></th><th></th><th></th>';
  problems.forEach(function (p, i) {
    var st = colStats[p.id] || {};
    h1 += '<th style="text-align:center;min-width:70px" data-letter="' + p.letter + '">' + p.letter + '</th>';
    h2 += '<th style="text-align:center;font-weight:500;color:#6b7280" title="通过人数 / 提交人数">' +
      '<span class="text-success">' + (st.acPeople || 0) + '</span> / ' + (st.submitPeople || 0) + '</th>';
  });
  h1 += '</tr>'; h2 += '</tr>';
  head.innerHTML = h1 + h2;

  var titleEl = document.getElementById('contest-title');
  if (titleEl && snap.contest) titleEl.textContent = '· ' + snap.contest.title;

  var rows = snap.rows || [];
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="' + (4 + problems.length) + '" class="empty">暂无排名</td></tr>'; return; }
  tbody.innerHTML = rows.map(function (r, idx) {
    var cellHtml = problems.map(function (p) {
      var c = r.cells[p.id];
      if (!c || c.status === 'none') return '<td style="text-align:center;color:#d1d5db">.</td>';
      if (c.status === 'AC') {
        return '<td style="text-align:center"><span class="res-badge res-success" style="font-weight:600">' + (c.minutes >= 0 ? c.minutes : 0) + '</span></td>';
      }
      // 未通过：显示 -错误次数
      return '<td style="text-align:center"><span style="color:#ef4444">-' + (c.attempts || 0) + '</span></td>';
    }).join('');
    return '<tr><td style="text-align:center" class="mono">' + r.rank + '</td>' +
      '<td>' + escapeHtml(r.username) + (r.nickname && r.nickname !== r.username ? ' <span class="text-muted">(' + escapeHtml(r.nickname) + ')</span>' : '') + '</td>' +
      '<td style="text-align:center" class="text-success">' + r.solved + '</td>' +
      '<td style="text-align:center" class="mono text-muted">' + r.penalty + '</td>' +
      cellHtml + '</tr>';
  }).join('');
}

async function load() {
  try {
    var d = await api('/api/contest/contests/' + cid + '/rank');
    render(d.snapshot);
    nextSyncAt = (d.snapshot && d.snapshot.version) ? Date.now() : Date.now();
  } catch (err) { toast(err.message, 'err'); }
}

/* SSE：scoreboard_delta 增量合并（数据带 contestId 匹配本比赛才处理） */
sseConnect('/api/contest/events', {
  scoreboard_delta: function (d) {
    if (!cached || !d.changes) return;
    var mine = d.changes.filter(function (ch) { return ch.contestId === cid; });
    if (!mine.length) return;
    mine.forEach(function (ch) {
      var row = ch.row;
      var found = cached.rows.find(function (r) { return r.userId === row.userId; });
      if (found) Object.assign(found, row);
      else cached.rows.push(row);
      // 同步更新列统计（拉取最新全局统计）
    });
    cached.rows.sort(function (a, b) { return b.solved - a.solved || a.penalty - b.penalty; });
    cached.rows.forEach(function (r, i) { r.rank = i + 1; });
    render(cached);
  }
});

load();
