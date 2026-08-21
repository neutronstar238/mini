'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('audit log trims the oldest event when the table is at capacity', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-oj-audit-test-'));
  const previousDbFile = process.env.DB_FILE;
  let db;

  process.env.DB_FILE = path.join(tempDir, 'audit.db');
  try {
    db = require('../src/store/db');
    const audit = require('../src/services/audit');

    for (let i = 0; i < 2000; i++) {
      db.audit.insert({
        id: `audit-${i}`,
        type: 'seed',
        detail: {},
        at: new Date(i).toISOString()
      });
    }

    const created = audit.log('boundary_probe', {});

    assert.equal(db.audit.all().length, 2000);
    assert.equal(db.audit.byId('audit-0'), null);
    assert.equal(db.audit.byId(created.id).type, 'boundary_probe');
  } finally {
    if (db) db.driver.db.close();
    if (previousDbFile === undefined) delete process.env.DB_FILE;
    else process.env.DB_FILE = previousDbFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
