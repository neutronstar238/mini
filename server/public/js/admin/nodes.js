'use strict';
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
async function load() {
  var tbody = document.getElementById('node-tbody');
  try {
    var d = await api('/api/admin/nodes');
    if (!d.workers.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无 Worker。请在可信 Windows 机上运行 Worker APP 并使用注册码注册。</td></tr>'; return; }
    tbody.innerHTML = d.workers.map(function (w) {
      var tier = w.tier === 'trusted' ? '<span class="text-info">可信</span>' : '<span class="text-muted">下沉</span>';
      var trust = w.trust_status === 'approved' ? '<span class="text-success">approved</span>'
        : w.trust_status === 'suspended' ? '<span class="text-danger">suspended</span>'
        : '<span class="text-warning">pending</span>';
      var online = w.online ? '<span class="text-success">在线</span>' : '<span class="text-muted">离线</span>';
      var ops = '<button class="btn btn-default btn-xs" onclick="tier(\'' + w.id + '\',\'' + (w.tier === 'trusted' ? 'sink' : 'trusted') + '\')">' + (w.tier === 'trusted' ? '降级' : '认证可信') + '</button> ' +
        (w.trust_status === 'approved' ? '<button class="btn btn-default btn-xs" onclick="approve(\'' + w.id + '\',false)">撤销审批</button>' : '<button class="btn btn-success btn-xs" onclick="approve(\'' + w.id + '\',true)">审批</button>') + ' ' +
        '<button class="btn btn-danger btn-xs" onclick="suspend(\'' + w.id + '\',' + (!w.suspended) + ')">' + (w.suspended ? '恢复' : '挂起') + '</button>';
      return '<tr><td>' + escapeHtml(w.name) + '</td>' +
        '<td class="mono">' + escapeHtml(w.certId || '-') + '</td>' +
        '<td>' + tier + '</td><td>' + trust + '</td>' +
        '<td>' + online + '</td>' +
        '<td class="mono ' + (w.anomalyCount > 0 ? 'text-warning' : '') + '">' + w.anomalyCount + '</td>' +
        '<td class="mono" style="font-size:11px">' + escapeHtml((w.runtime_manifest_hash || '').slice(0, 12)) + '…</td>' +
        '<td>' + ops + '</td></tr>';
    }).join('');
  } catch (err) { tbody.innerHTML = '<tr><td colspan="8" class="empty">' + escapeHtml(err.message) + '</td></tr>'; }
}
window.tier = async function (id, t) { try { await api('/api/admin/nodes/' + id + '/tier', { method: 'POST', body: JSON.stringify({ tier: t }) }); toast('已更新分级'); load(); } catch (e) { toast(e.message, 'err'); } };
window.approve = async function (id, a) { try { await api('/api/admin/nodes/' + id + '/approve', { method: 'POST', body: JSON.stringify({ approved: a }) }); toast(a ? '已审批' : '已撤销审批'); load(); } catch (e) { toast(e.message, 'err'); } };
window.suspend = async function (id, s) { try { await api('/api/admin/nodes/' + id + '/suspend', { method: 'POST', body: JSON.stringify({ suspend: s }) }); toast(s ? '已挂起' : '已恢复'); load(); } catch (e) { toast(e.message, 'err'); } };
sseConnect('/api/admin/events/stream', { worker_anomaly: load, task_report: load });
load();
setInterval(load, 15000);
