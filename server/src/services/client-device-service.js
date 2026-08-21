'use strict';

const db = require('../store/db');
const hub = require('../sse/hub');
const config = require('../config');

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function createClientDeviceService(deps) {
  const store = deps.db;
  const eventHub = deps.hub;
  const cfg = deps.config;
  const now = deps.now || (() => Date.now());
  let timer = null;

  function withUser(device) {
    const user = store.users.byId(device.userId);
    return Object.assign({}, device, {
      username: user ? user.username : '未知用户',
      nickname: user ? (user.nickname || user.username) : '未知用户'
    });
  }

  function publicDevice(device) {
    const d = withUser(device);
    return {
      id: d.id,
      deviceId: d.deviceId,
      userId: d.userId,
      username: d.username,
      nickname: d.nickname,
      status: d.status,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: d.lastSeenAt,
      browser: d.browser || '-',
      platform: d.platform || '-',
      screen: d.screen || '-',
      language: d.language || '-',
      timezone: d.timezone || '-',
      crossOriginIsolated: !!d.crossOriginIsolated,
      page: d.page || '-',
      ip: d.ip || '-'
    };
  }

  function emit(device) {
    eventHub.emit('admin', 'client_device_update', publicDevice(device));
  }

  function heartbeat(user, payload, network) {
    const deviceId = clean(payload && payload.deviceId, 64);
    if (!/^[a-zA-Z0-9_-]{16,64}$/.test(deviceId)) {
      const err = new Error('设备 ID 无效');
      err.status = 400;
      err.expose = true;
      throw err;
    }

    const id = `${user.id}:${deviceId}`;
    const existing = store.clientDevices.byId(id);
    const at = now();
    const shouldEmit = !existing || existing.status !== 'online'
      || at - new Date(existing.lastEventAt || 0).getTime() >= cfg.CLIENT_DEVICE_EVENT_MIN_INTERVAL;
    const client = payload && payload.client || {};
    const record = {
      id,
      deviceId,
      userId: user.id,
      status: 'online',
      firstSeenAt: existing ? existing.firstSeenAt : new Date(at).toISOString(),
      lastSeenAt: new Date(at).toISOString(),
      lastEventAt: shouldEmit ? new Date(at).toISOString() : (existing && existing.lastEventAt),
      browser: clean(client.browser, 120),
      platform: clean(client.platform, 80),
      screen: clean(client.screen, 40),
      language: clean(client.language, 24),
      timezone: clean(client.timezone, 80),
      crossOriginIsolated: client.crossOriginIsolated === true,
      page: clean(payload && payload.page, 180),
      ip: clean(network && network.ip, 80)
    };
    const saved = existing
      ? store.clientDevices.update(id, record)
      : store.clientDevices.insert(record);
    if (shouldEmit) emit(saved);
    return publicDevice(saved);
  }

  function sweepOffline() {
    const at = now();
    let changed = 0;
    store.clientDevices.find((d) => d.status === 'online').forEach((device) => {
      if (at - new Date(device.lastSeenAt).getTime() <= cfg.CLIENT_DEVICE_OFFLINE_AFTER) return;
      const offline = store.clientDevices.update(device.id, {
        status: 'offline',
        lastEventAt: new Date(at).toISOString()
      });
      emit(offline);
      changed++;
    });
    return changed;
  }

  function list() {
    sweepOffline();
    const devices = store.clientDevices.all()
      .map(publicDevice)
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'online' ? -1 : 1)
        || new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
    return {
      devices,
      total: devices.length,
      online: devices.filter((d) => d.status === 'online').length,
      offline: devices.filter((d) => d.status === 'offline').length,
      serverTime: new Date(now()).toISOString(),
      offlineAfterMs: cfg.CLIENT_DEVICE_OFFLINE_AFTER
    };
  }

  function start() {
    if (timer) return;
    sweepOffline();
    timer = setInterval(sweepOffline, cfg.CLIENT_DEVICE_SWEEP_INTERVAL);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { heartbeat, sweepOffline, list, publicDevice, start, stop };
}

const service = createClientDeviceService({ db, hub, config });
service.createClientDeviceService = createClientDeviceService;
module.exports = service;
