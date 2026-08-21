'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const profiles = require('../src/language-profiles');

test('modern checkpoint profiles cannot enter the formal submission allowlist', () => {
  const enabled = profiles.enabledOfficialLanguages();
  assert.equal(enabled.includes('java21'), true);
  assert.equal(enabled.includes('c17'), false);
  assert.equal(enabled.includes('cpp17'), false);

  for (const id of ['c17', 'cpp17']) {
    const profile = profiles.sanitizedPublicProfile(id);
    assert.equal(profile.status, 'EXPERIMENTAL');
    assert.equal(profile.submissionEnabled, false);
    assert.equal(profile.localRuntime.enabled, true);
    assert.equal(profile.localRuntime.preview, true);
    assert.equal(profile.localRuntime.status, 'LOCAL_PREVIEW');
    assert.equal(profile.localRuntime.assetHash, '25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c');
    assert.equal(profile.localRuntime.pchPolicy, 'none');
    assert.equal(profile.officialJudge.compiler.includes('-14'), true);
    assert.equal(profile.officialJudge.referenceStatus, 'GCC14_REFERENCE_READY');
  }
});

test('public profile API reflects the effective profile status', () => {
  profiles.setStatus('c17', 'EXPERIMENTAL');
  try {
    const profile = profiles.sanitizedPublicProfile('c17');
    assert.equal(profile.status, 'EXPERIMENTAL');
    assert.equal(profile.localRuntime.status, 'EXPERIMENTAL');
    assert.equal(profile.submissionEnabled, false);
  } finally {
    profiles.setStatus('c17', 'EXPERIMENTAL');
  }
});

test('C++20 and C++23 stay pending and unavailable in checkpoint 1', () => {
  for (const id of ['cpp20', 'cpp23']) {
    const profile = profiles.sanitizedPublicProfile(id);
    assert.equal(profile.status, 'PENDING');
    assert.equal(profile.localRuntime.enabled, false);
    assert.equal(profile.localRuntime.supported, false);
    assert.equal(profile.submissionEnabled, false);
  }
});

test('Java 21 exposes the beta freeze and keeps legal redistribution pending', () => {
  const java = profiles.sanitizedPublicProfile('java21');
  assert.equal(java.status, 'BETA_FROZEN');
  assert.equal(java.submissionEnabled, true);
  assert.equal(java.localRuntime.status, 'BETA_FROZEN');
  assert.equal(java.localRuntime.technicalValidated, true);
  assert.equal(java.localRuntime.engineeringRedistributionReady, true);
  assert.equal(java.localRuntime.legalReviewRequired, true);
  assert.equal(java.localRuntime.redistributable, false);
  assert.equal(java.localRuntime.assetHash, 'eee8298d267c2ba781cc6db4d587e6a8a2a39ff8aac5692f1c3a3d01daee5878');
  assert.equal(java.officialJudge.referenceStatus, 'OpenJDK 21 Stable');
});
