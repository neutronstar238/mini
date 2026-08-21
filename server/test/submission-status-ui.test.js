'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('submission card renders and updates one official status badge', () => {
  const view = fs.readFileSync(path.join(__dirname, '../views/contest/problem-detail.ejs'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/contest/problem-detail.js'), 'utf8');
  const tracker = script.slice(script.indexOf('function trackSubmission'), script.indexOf('/* ================= 本地草稿'));

  assert.equal((view.match(/id="sub-status"/g) || []).length, 1);
  assert.equal(view.includes('id="sub-verdict"'), false);
  assert.equal(script.includes("$('sub-verdict')"), false);
  assert.equal(tracker.includes('statusBadge('), false);
  assert.match(tracker, /officialBadge\('QUEUED'\)/);
  assert.match(tracker, /officialBadge\(s\.status, s\.verdict\)/);
  assert.match(tracker, /officialBadge\(d\.status, d\.verdict\)/);
});
