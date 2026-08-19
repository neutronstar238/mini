'use strict';
/* 比赛列表页：加载全部比赛，未开始不可进入 */
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

var STATUS_LABEL = { ongoing: '进行中', upcoming: '未开始', ended: '已结束' };

function fmtStart(ms) {
  if (!ms) return '-';
  var d = new Date(ms);
  function p(n) { return String(n).padStart(2, '0'); }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function load() {
  var grid = document.getElementById('contest-grid');
  try {
    var d = await api('/api/contest/contests');
    if (!d.contests.length) { grid.innerHTML = '<div class="text-muted" style="text-align:center;padding:40px 0">暂无已发布的比赛</div>'; return; }
    grid.innerHTML = d.contests.map(function (c) {
      var disabled = c.status === 'upcoming';
      return '<div class="contest-card' + (disabled ? ' disabled' : '') + '" data-id="' + c.id + '">' +
        '<div class="cc-title"><span>' + escapeHtml(c.title) + '</span>' +
        '<span class="cc-badge ' + c.status + '">' + STATUS_LABEL[c.status] + '</span></div>' +
        '<div class="cc-desc">' + (c.description ? escapeHtml(c.description) : '') + '</div>' +
        '<div class="cc-meta"><span>题目 ' + c.problemCount + ' 道</span>' +
        '<span>' + (c.status === 'upcoming' ? '开始于 ' + fmtStart(c.startTimeMs) : '已开始 ' + fmtStart(c.startTimeMs)) + '</span></div>' +
        (disabled ? '<div style="font-size:12px;color:#b45309">点击进入显示「比赛还未开始」</div>' : '') +
        '</div>';
    }).join('');
  } catch (err) { grid.innerHTML = '<div class="text-muted" style="text-align:center;padding:40px 0">' + escapeHtml(err.message) + '</div>'; }
}

document.getElementById('contest-grid').addEventListener('click', function (e) {
  var card = e.target.closest('.contest-card');
  if (!card) return;
  location.href = '/contest/contests/' + card.dataset.id + '/problems';
});

load();
