'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('admin device page is wired to heartbeat API and SSE updates', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const contest = fs.readFileSync(path.join(__dirname, '../src/routes/contest.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../src/routes/admin-v2.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../views/admin/devices.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/admin/devices.js'), 'utf8');
  const heartbeat = fs.readFileSync(path.join(__dirname, '../public/js/contest/device-heartbeat.js'), 'utf8');

  assert.match(app, /app\.get\('\/admin\/devices'/);
  assert.match(contest, /router\.post\('\/devices\/heartbeat'/);
  assert.match(admin, /router\.get\('\/devices'/);
  assert.match(admin, /'X-Internal-Token': token/);
  assert.match(admin, /'X-Internal-Ts': ts/);
  assert.match(view, /id="device-tbody"/);
  assert.match(script, /client_device_update/);
  assert.match(heartbeat, /\/api\/contest\/devices\/heartbeat/);
});
