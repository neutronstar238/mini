'use strict';
/* 榜单页：bootstrap 全量快照 + SSE scoreboard_delta 增量更新 + fallback polling */
var mode = 'practice';
var cached = null;   // 内存缓存（MVP 简化；生产用 CacheRepository→IndexedDB）
var nextSyncAt = 0;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
window.setMode = function (m) {
  mode = m;
  document.getElementById('mode-practice').classList[m === 'practice' ? 'add' : 'remove']('btn-primary');
  document.getElementById('mode-practice').classList[m === 'practice' ? 'remove' : 'add']('btn-default');
  document.getElementById('mode-formal').classList[m === 'formal' ? 'add' : 'remove']('btn-primary');
  document.getElementById('mode-formal').classList[m === 'formal' ? 'remove' : 'add']('btn-default');
  load();
};

function render(rows) {
  var tbody = document.getElementById('rank-tbody');
  if (!rows || !rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">暂无排名</td></tr>'; return; }
  tbody.innerHTML = rows.map(function (r, i) {
    return '<tr><td style="text-align:center" class="mono">' + (i + 1) + '</td>' +
      '<td>' + escapeHtml(r.username) + (r.nickname && r.nickname !== r.username ? ' <span class="text-muted">(' + escapeHtml(r.nickname) + ')</span>' : '') + '</td>' +
      '<td style="text-align:right" class="text-success">' + r.solvedCount + '</td>' +
      '<td style="text-align:right" class="mono text-muted">' + r.penaltyMs + '</td></tr>';
  }).join('');
}

/* 首次加载：bootstrap 全量快照（含 cache lease） */
async function load() {
  try {
    var d = await api('/api/contest/sync/bootstrap');
    nextSyncAt = d.nextSyncAt;
    cached = d.scoreboardSnapshot;
    render(cached.rows);
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* SSE：scoreboard_delta 增量合并 + 重新排序 */
sseConnect('/api/contest/events', {
  scoreboard_delta: function (d) {
    if (!d.changes) return; // 首次推送可能是 full snapshot
    // 更新本地缓存中的变化用户
    d.changes.forEach(function (ch) {
      var found = cached.rows.find(function (r) { return r.userId === ch.userId; });
      if (found) { found.solvedCount = ch.solvedCount; found.penaltyMs = ch.penaltyMs; }
      else if (ch.userId) cached.rows.push(ch);
    });
    // 本地重排序（避免每次请求服务器）
    cached.rows.sort(function (a, b) { return b.solvedCount - a.solvedCount || a.penaltyMs - b.penaltyMs; });
    render(cached.rows);
  }
});

/* Cache Lease：nextSyncAt 之前禁止重新请求；到期后 fallback polling */
async function syncIfDue() {
  if (Date.now() < nextSyncAt) return; // 缓存租约内：仅重渲染
  try {
    var d = await api('/api/contest/sync?scoreboardVersion=' + (cached ? cached.version : 0));
    nextSyncAt = d.nextSyncAt || (Date.now() + 10000);
    if (d.full && d.scoreboardSnapshot) {
      cached = d.scoreboardSnapshot;
      render(cached.rows);
    } else if (d.submissionDelta && cached) {
      cached.version = d.scoreboardVersion;
      render(cached.rows);
    }
  } catch (err) {
    if (err.status === 429) nextSyncAt = Date.now() + 5000; // 被限流则稍后重试
  }
}
setInterval(syncIfDue, 5000);

load();
