'use strict';

var devices = [];

function escapeDeviceHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function render() {
  var filter = document.getElementById('device-filter').value;
  var query = document.getElementById('device-search').value.trim().toLowerCase();
  var list = devices.filter(function (d) {
    if (filter !== 'all' && d.status !== filter) return false;
    if (!query) return true;
    return [d.username, d.nickname, d.deviceId, d.browser, d.platform]
      .join(' ').toLowerCase().indexOf(query) !== -1;
  });
  var tbody = document.getElementById('device-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无符合条件的客户端设备</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(function (d) {
    var status = d.status === 'online'
      ? '<span class="res-badge res-success">在线</span>'
      : '<span class="res-badge res-default">离线</span>';
    var isolated = d.crossOriginIsolated ? '<span class="text-success">隔离环境正常</span>' : '<span class="text-muted">普通环境</span>';
    return '<tr>' +
      '<td>' + status + '</td>' +
      '<td><b>' + escapeDeviceHtml(d.nickname || d.username) + '</b><div class="text-muted">' + escapeDeviceHtml(d.username) + '</div></td>' +
      '<td class="mono" title="' + escapeDeviceHtml(d.deviceId) + '">' + escapeDeviceHtml(d.deviceId.slice(0, 8)) + '…</td>' +
      '<td>' + escapeDeviceHtml(d.browser) + '<div class="text-muted">' + escapeDeviceHtml(d.platform) + ' · ' + isolated + '</div></td>' +
      '<td>' + escapeDeviceHtml(d.screen) + '</td>' +
      '<td class="mono" style="font-size:12px">' + escapeDeviceHtml(d.page) + '</td>' +
      '<td class="mono">' + escapeDeviceHtml(d.ip) + '</td>' +
      '<td>' + fmtTime(d.lastSeenAt) + '<div class="text-muted">首次 ' + fmtTime(d.firstSeenAt) + '</div></td>' +
      '</tr>';
  }).join('');
}

function updateStats(summary) {
  document.getElementById('device-total').textContent = summary.total;
  document.getElementById('device-online').textContent = summary.online;
  document.getElementById('device-offline').textContent = summary.offline;
}

async function loadDevices() {
  try {
    var data = await api('/api/admin/devices');
    devices = data.devices || [];
    updateStats(data);
    render();
  } catch (err) {
    document.getElementById('device-tbody').innerHTML = '<tr><td colspan="8" class="empty">' + escapeDeviceHtml(err.message) + '</td></tr>';
  }
}

function applyUpdate(device) {
  var index = devices.findIndex(function (d) { return d.id === device.id; });
  if (index === -1) devices.push(device); else devices[index] = device;
  devices.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'online' ? -1 : 1;
    return new Date(b.lastSeenAt) - new Date(a.lastSeenAt);
  });
  updateStats({
    total: devices.length,
    online: devices.filter(function (d) { return d.status === 'online'; }).length,
    offline: devices.filter(function (d) { return d.status === 'offline'; }).length
  });
  render();
}

document.getElementById('device-filter').addEventListener('change', render);
document.getElementById('device-search').addEventListener('input', render);
sseConnect('/api/admin/events/stream', {
  client_device_update: function (device) {
    document.getElementById('device-sse').innerHTML = '<span class="text-success">● SSE 实时连接</span>';
    applyUpdate(device);
  }
});
loadDevices();
setInterval(loadDevices, 60000);
