'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientDeviceService } = require('../src/services/client-device-service');

function collection(seed) {
  const rows = new Map((seed || []).map((row) => [row.id, Object.assign({}, row)]));
  return {
    byId: (id) => rows.get(id) || null,
    all: () => Array.from(rows.values()),
    find: (fn) => Array.from(rows.values()).filter(fn),
    insert: (row) => { rows.set(row.id, Object.assign({}, row)); return rows.get(row.id); },
    update: (id, patch) => {
      const next = Object.assign({}, rows.get(id), patch, { id });
      rows.set(id, next);
      return next;
    }
  };
}

test('browser device heartbeat persists state and emits online/offline SSE updates', () => {
  let clock = Date.parse('2026-08-21T02:00:00.000Z');
  const users = collection([{ id: 'user-1', username: 'user1', nickname: '选手一' }]);
  const clientDevices = collection();
  const events = [];
  const service = createClientDeviceService({
    db: { users, clientDevices },
    hub: { emit: (channel, event, data) => events.push({ channel, event, data }) },
    config: {
      CLIENT_DEVICE_OFFLINE_AFTER: 60000,
      CLIENT_DEVICE_SWEEP_INTERVAL: 15000,
      CLIENT_DEVICE_EVENT_MIN_INTERVAL: 30000
    },
    now: () => clock
  });

  const online = service.heartbeat({ id: 'user-1' }, {
    deviceId: '12345678-1234-1234-1234-123456789abc',
    page: '/contest/contests/demo/problems',
    client: { browser: 'Chrome 140', platform: 'Windows', crossOriginIsolated: true }
  }, { ip: '127.0.0.1' });

  assert.equal(online.status, 'online');
  assert.equal(online.username, 'user1');
  assert.equal(online.crossOriginIsolated, true);
  assert.equal(service.list().online, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'client_device_update');

  clock += 61000;
  assert.equal(service.sweepOffline(), 1);
  assert.equal(service.list().offline, 1);
  assert.equal(events.length, 2);
  assert.equal(events[1].data.status, 'offline');
});

test('browser device heartbeat rejects invalid device ids', () => {
  const service = createClientDeviceService({
    db: { users: collection(), clientDevices: collection() },
    hub: { emit: () => {} },
    config: { CLIENT_DEVICE_OFFLINE_AFTER: 60000, CLIENT_DEVICE_EVENT_MIN_INTERVAL: 30000 },
    now: () => Date.now()
  });
  assert.throws(() => service.heartbeat({ id: 'user-1' }, { deviceId: 'short' }, {}), /设备 ID 无效/);
});
