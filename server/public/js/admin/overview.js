'use strict';
async function load() {
  try {
    var o = await api('/api/admin/overview');
    var vals = [o.users, o.problems, o.submissions, o.pending, o.judging, o.ac, o.onlineWorkers, o.approvedWorkers];
    document.querySelectorAll('#overview-cards .num').forEach(function (el, i) { el.textContent = vals[i]; });
  } catch (err) { toast(err.message, 'err'); }
}
function pushEvent(line, cls) {
  var box = document.getElementById('event-stream');
  if (box.querySelector('.text-muted')) box.innerHTML = '';
  var el = document.createElement('div');
  el.className = 'event-line ' + (cls || '');
  el.innerHTML = '<span class="t">' + fmtTime(new Date().toISOString()) + '</span><span>' + line + '</span>';
  box.prepend(el);
  while (box.children.length > 60) box.lastChild.remove();
}
function fmtDetail(d) {
  return Object.keys(d).map(function (k) { return k + '=' + (typeof d[k] === 'string' ? d[k].slice(0, 24) : d[k]); }).join(' ');
}
sseConnect('/api/admin/events/stream', {
  snapshot: function (d) {
    (d.events || []).slice().reverse().forEach(function (e) { pushEvent('<b>[' + e.type + ']</b> ' + fmtDetail(e.detail)); });
    load();
  },
  task_dispatch: function (d) { pushEvent('<b>[下发]</b> ' + d.submission_id.slice(0, 8) + ' → ' + d.worker.slice(0, 8), 'ok'); load(); },
  task_report: function (d) { pushEvent('<b>[回传]</b> ' + d.submission_id.slice(0, 8) + ' → ' + d.status, 'ok'); load(); },
  lease_expired: function (d) { pushEvent('<b>[租约超时]</b> ' + d.submission_id.slice(0, 8) + ' attempt=' + d.attempt, 'bad'); load(); },
  worker_anomaly: function (d) { pushEvent('<b>[Worker异常]</b> ' + d.reason + ' (' + d.count + ')', 'bad'); load(); },
  spotcheck_mismatch: function (d) { pushEvent('<b>[抽查不一致]</b> ' + d.submission_id.slice(0, 8) + ' 原=' + d.orig + ' 复=' + d.recheck, 'bad'); load(); }
});
load();
setInterval(load, 15000);
