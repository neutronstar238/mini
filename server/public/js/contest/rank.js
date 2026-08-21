'use strict';
/* ICPC 榜单页（Phase 5）：双层表头 + Cache Lease + SSE delta + version gap full sync + fallback polling */
var cid = window.__CONTEST_ID__ || (new URLSearchParams(location.search).get('contest')) || '';
if (!cid) location.href = '/contest/contests';

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function letter(i) { return String.fromCharCode(65 + i); }

var state = {
  snapshot: null,       // 当前展示快照 {version, serverTime, nextSyncAt, contest, problems, participants, colStats}
  connected: false,
  sseActive: false,
  sseFailCount: 0,
  lastSyncAt: 0,
  pollTimer: null,
  pollBackoff: 0
};

/* 渲染双层表头 + 数据行（快照新形态：participants） */
function render(snap) {
  if (!snap) return;
  state.snapshot = snap;
  var head = document.getElementById('rank-head');
  var tbody = document.getElementById('rank-tbody');
  var problems = snap.problems || [];
  var colStats = snap.colStats || {};
  var rows = snap.participants || [];

  var h1 = '<tr>' +
    '<th style="width:60px;text-align:center">Rank</th>' +
    '<th>Team</th>' +
    '<th style="width:70px;text-align:center">Solved</th>' +
    '<th style="width:90px;text-align:center">Penalty</th>';
  var h2 = '<tr class="rank-stats-row">' +
    '<th colspan="4" class="rank-stats-legend">每题统计 <span>通过人数 / 提交人数</span></th>';
  problems.forEach(function (p) {
    var st = colStats[p.id] || {};
    var acPeople = Number(st.acPeople) || 0;
    var submitPeople = Number(st.submitPeople) || 0;
    h1 += '<th style="text-align:center;min-width:70px">' + escapeHtml(p.letter) + '</th>';
    h2 += '<th class="rank-problem-stat" title="通过人数 / 提交人数" aria-label="' +
      escapeHtml(p.letter) + '：通过 ' + acPeople + ' 人，提交 ' + submitPeople + ' 人">' +
      '<span class="rank-stat-ac">' + acPeople + '</span><span class="rank-stat-separator">/</span>' +
      '<span class="rank-stat-submit">' + submitPeople + '</span></th>';
  });
  h1 += '</tr>'; h2 += '</tr>';
  head.innerHTML = h1 + h2;

  var titleEl = document.getElementById('contest-title');
  if (titleEl && snap.contest) titleEl.textContent = '· ' + escapeHtml(snap.contest.title);

  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="' + (4 + problems.length) + '" class="empty">暂无排名</td></tr>'; return; }
  tbody.innerHTML = rows.map(function (r) {
    var cellHtml = problems.map(function (p) {
      var c = r.cells[p.id];
      if (!c || c.status === 'none') return '<td style="text-align:center;color:#d1d5db">.</td>';
      if (c.status === 'AC') return '<td style="text-align:center"><span class="res-badge res-success" style="font-weight:600">' + (c.minutes >= 0 ? c.minutes : 0) + '</span></td>';
      return '<td style="text-align:center"><span style="color:#ef4444">-' + (c.attempts || 0) + '</span></td>';
    }).join('');
    return '<tr><td style="text-align:center" class="mono">' + r.rank + '</td>' +
      '<td>' + escapeHtml(r.username) + (r.nickname && r.nickname !== r.username ? ' <span class="text-muted">(' + escapeHtml(r.nickname) + ')</span>' : '') + '</td>' +
      '<td style="text-align:center" class="text-success">' + r.solved + '</td>' +
      '<td style="text-align:center" class="mono text-muted">' + r.penalty + '</td>' +
      cellHtml + '</tr>';
  }).join('');

  // 保存缓存（后台，不阻塞渲染）
  if (window.ScoreboardCache) ScoreboardCache.save(cid, snap);
  updateStatusBar();
}

/* 状态条：连接状态 / 版本 / Lease */
function updateStatusBar() {
  var bar = document.getElementById('sb-status');
  if (!bar) return;
  var snap = state.snapshot;
  var parts = [];
  parts.push('v' + (snap ? snap.version : '-'));
  if (state.sseActive) parts.push('<span style="color:#5cb85c">● SSE</span>');
  else if (state.connected) parts.push('<span style="color:#5cb85c">● 已连接</span>');
  else parts.push('<span style="color:#f0ad4e">● 轮询中</span>');
  if (snap && snap.nextSyncAt) {
    var fresh = new Date(snap.nextSyncAt).getTime() > Date.now();
    parts.push(fresh ? '<span class="text-success">Lease 有效</span>' : '<span class="text-muted">Lease 已过期</span>');
  }
  if (snap && snap.frozen) parts.push('<span class="text-warning">封榜中</span>');
  bar.innerHTML = parts.join(' &nbsp;·&nbsp; ');
}

/* 稳定排序（前端本地兜底，与后端一致） */
function sortRows(rows) {
  return rows.slice().sort(function (a, b) {
    return (b.solved - a.solved) || (a.penalty - b.penalty) ||
      ((a.lastAcceptedAtMs || 0) - (b.lastAcceptedAtMs || 0)) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
  });
}

/** 应用 delta（version 连续） */
function applyDelta(d) {
  var rows = state.snapshot.participants;
  d.changes.forEach(function (ch) {
    var found = rows.find(function (r) { return r.userId === ch.userId; });
    if (found) {
      found.solved = ch.solved;
      found.penalty = ch.penalty;
      if (ch.problems) found.cells = ch.problems;
    } else {
      // 新选手出现：拉一次 full snapshot 补全
      return fullSync();
    }
  });
  rows = sortRows(rows);
  rows.forEach(function (r, i) { r.rank = i + 1; });
  state.snapshot.participants = rows;
  state.snapshot.version = d.version;
  render(state.snapshot);
}

/** 从服务器拉取 Full Snapshot（rate limit 429 时回退轮询） */
async function fullSync() {
  try {
    var d = await api('/api/contest/contests/' + cid + '/scoreboard');
    render(d.snapshot);
    return d.snapshot;
  } catch (err) {
    if (err.status === 429) {
      var retry = Math.min(15, Math.max(3, Math.round((state.pollBackoff + 1) * 2)));
      setStatusLine('Scoreboard 请求过于频繁，' + retry + 's 后重试');
      schedulePoll(retry * 1000);
    } else {
      setStatusLine('加载失败：' + err.message);
    }
    return null;
  }
}

function setStatusLine(msg) {
  var bar = document.getElementById('sb-status');
  if (bar) bar.innerHTML = escapeHtml(msg);
}

/* SSE：每比赛 channel + version gap 处理 */
function startSse() {
  if (state.sseActive) return;
  var lastVer = state.snapshot ? state.snapshot.version : 0;
  var url = '/api/contest/contests/' + cid + '/events?lastVersion=' + lastVer;
  var es;
  try {
    es = new EventSource(url);
  } catch (e) { schedulePoll(5000); return; }
  state.sseActive = true;

  es.addEventListener('scoreboard-delta', function (e) {
    var d = JSON.parse(e.data);
    if (!state.snapshot) { fullSync(); return; }
    var cur = state.snapshot.version || 0;
    if (d.version === cur + 1) {
      applyDelta(d);            // 连续 → 应用
    } else if (d.version > cur + 1) {
      // version gap → full sync（保证不长期错误榜单）
      fullSync();
    }
    state.sseFailCount = 0;
  });

  es.addEventListener('scoreboard_sync', function (e) {
    var d = JSON.parse(e.data);
    if (d.type === 'NEED_FULL_SYNC') fullSync();
  });

  // 版本一致说明缓存内容仍是最新；用服务器元信息续期 Lease，无需重复查询榜单。
  es.addEventListener('scoreboard_snapshot', function (e) {
    var d = JSON.parse(e.data);
    if (!state.snapshot || state.snapshot.version !== d.version) {
      fullSync();
      return;
    }
    state.snapshot.serverTime = d.serverTime || state.snapshot.serverTime;
    state.snapshot.nextSyncAt = d.nextSyncAt || state.snapshot.nextSyncAt;
    if (window.ScoreboardCache) ScoreboardCache.save(cid, state.snapshot);
    updateStatusBar();
  });

  es.onopen = function () { state.connected = true; state.sseFailCount = 0; updateStatusBar(); };
  es.onerror = function () {
    state.sseActive = false;
    state.connected = false;
    state.sseFailCount++;
    es.close();
    if (state.sseFailCount >= 3) {
      // 连续断开 → fallback polling
      schedulePoll();
    } else {
      setTimeout(startSse, 4000); // 重连
    }
    updateStatusBar();
  };
}

/* Fallback Polling：10~13s + random 0~3s jitter */
function schedulePoll(delayMs) {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  if (state.sseActive && state.sseFailCount < 3) return; // SSE 正常则无需 poll
  var base = 10000;
  var jitter = Math.floor(Math.random() * 3000);
  var d = delayMs || (base + jitter);
  state.pollTimer = setTimeout(async function () {
    try {
      var d2 = await api('/api/contest/contests/' + cid + '/scoreboard/version');
      if (state.snapshot && d2.version !== state.snapshot.version) {
        await fullSync();
      } else if (!state.snapshot) {
        await fullSync();
      }
    } catch (e) { /* 静默，下轮再试 */ }
    schedulePoll();
  }, d);
}

/** 首次加载：Cache Lease 命中则先显示缓存，再 SSE */
async function init() {
  var cacheFresh = false;
  if (window.ScoreboardCache) {
    var cached = await ScoreboardCache.load(cid);
    if (cached && cached.snapshot) {
      render(cached.snapshot); // 立即显示（Lease 有效则无白屏）
      cacheFresh = cached.fresh;
      updateStatusBar();
    }
  }
  // 过期缓存可先展示，但必须立即向服务器确认；失败时再由 SSE / polling 兜底。
  if (!state.snapshot || !cacheFresh) await fullSync();
  startSse();
  // 后台若 Cache Lease 有效，SSE 会接管；否则 poll 兜底
  if (!state.snapshot) schedulePoll();
}

init();
