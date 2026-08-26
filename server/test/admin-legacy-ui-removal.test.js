'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverRoot = path.join(__dirname, '..');

test('admin legacy worker experiment surface stays removed', () => {
  const app = fs.readFileSync(path.join(serverRoot, 'src/app.js'), 'utf8');
  const routes = fs.readFileSync(path.join(serverRoot, 'src/routes/admin-v2.js'), 'utf8');
  const navigation = fs.readFileSync(path.join(serverRoot, 'views/partials/admin-head.ejs'), 'utf8');

  for (const route of ['nodes', 'certs', 'queue']) {
    assert.doesNotMatch(app, new RegExp(`app\\.get\\('/admin/${route}'`));
    assert.doesNotMatch(routes, new RegExp(`router\\.(?:get|post)\\('/${route}`));
    assert.doesNotMatch(navigation, new RegExp(`/admin/${route}`));
    assert.equal(fs.existsSync(path.join(serverRoot, `views/admin/${route}.ejs`)), false);
    assert.equal(fs.existsSync(path.join(serverRoot, `public/js/admin/${route}.js`)), false);
  }

  assert.doesNotMatch(navigation, /遗留实验|旧 Worker 节点|旧注册码|旧任务队列/);
  for (const route of ['overview', 'contests', 'problems', 'submissions', 'devices', 'rejudge', 'audit']) {
    assert.match(navigation, new RegExp(`/admin/${route}`));
  }
});
