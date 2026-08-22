'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('../src/language-profiles');
const modernRuntime = require('../public/js/runtime/cpp-modern-engine-v2/runtime-manifest.json');

test('modern profiles retain internal BETA status and enter the formal submission allowlist', () => {
  const enabled = profiles.enabledOfficialLanguages();
  assert.equal(enabled.includes('java21'), true);
  assert.equal(enabled.includes('c17'), true);
  assert.equal(enabled.includes('cpp17'), true);

  for (const id of ['c17', 'cpp17']) {
    const profile = profiles.sanitizedPublicProfile(id);
    assert.equal(profile.status, 'BETA');
    assert.equal(profile.submissionEnabled, true);
    assert.equal(profile.formalSubmit, true);
    assert.equal(profile.localRuntime.enabled, true);
    assert.equal(profile.localRuntime.preview, false);
    assert.equal(profile.localRuntime.status, 'BETA');
    assert.equal(profile.localRuntime.runtimeId, id + '-gcc14-compat-v2');
    assert.equal(profile.localRuntime.engineRuntimeId, 'cpp-modern-engine-v2');
    assert.equal(profile.localRuntime.assetHash, modernRuntime.runtimeAssetHash);
    assert.equal(profile.localRuntime.pchPolicy, 'none');
    assert.equal(profile.localRuntime.headerGuard, id === 'cpp17' ? 'proven-mismatch-v1' : 'none');
    assert.equal(profile.localRuntime.optimizationLevel, '-O2');
    assert.equal(profile.localRuntime.optimizationMismatch, false);
    assert.equal(profile.localRuntime.compileFlags.includes('-O2'), true);
    assert.equal(profile.officialJudge.compiler.includes('-14'), true);
    assert.equal(profile.officialJudge.referenceStatus, 'GCC14_REFERENCE_READY');
    for (const flag of ['-O2', '-Wall', '-Wextra', '-DONLINE_JUDGE']) {
      assert.equal(profile.officialJudge.compileFlags.includes(flag), true);
    }
  }
  assert.equal(profiles.PROFILES.c17.officialJudge.compileCommand[0], 'gcc-14');
  assert.equal(profiles.PROFILES.c17.officialJudge.compileCommand.includes('-lm'), true);
  assert.equal(profiles.PROFILES.cpp17.officialJudge.compileCommand[0], 'g++-14');
});

test('public profile API reflects the effective profile status', () => {
  profiles.setStatus('c17', 'EXPERIMENTAL');
  try {
    const profile = profiles.sanitizedPublicProfile('c17');
    assert.equal(profile.status, 'EXPERIMENTAL');
    assert.equal(profile.localRuntime.status, 'EXPERIMENTAL');
    assert.equal(profile.submissionEnabled, false);
    assert.equal(profile.formalSubmit, false);
    assert.equal(profiles.isOfficialEnabled('c17'), false);
  } finally {
    profiles.setStatus('c17', 'BETA');
  }
});

test('C++20 and C++23 stay internal pending profiles and are absent from production UI metadata', () => {
  const publicIds = profiles.allSanitizedPublicProfiles().map((profile) => profile.id);
  assert.equal(publicIds.includes('cpp20'), false);
  assert.equal(publicIds.includes('cpp23'), false);
  for (const id of ['cpp20', 'cpp23']) {
    const profile = profiles.PROFILES[id];
    assert.equal(profiles.sanitizedPublicProfile(id), null);
    assert.equal(profile.status, 'PENDING');
    assert.equal(profile.localRuntime.enabled, false);
    assert.equal(profile.localRuntime.supported, false);
    assert.equal(profile.submissionEnabled, false);
    assert.equal(profiles.setStatus(id, 'BETA'), false);
  }
});

test('legacy production runtimes remain final frozen and submit-enabled', () => {
  for (const id of ['c11', 'cpp11', 'python3']) {
    const profile = profiles.sanitizedPublicProfile(id);
    assert.equal(profile.status, 'FINAL_FROZEN');
    assert.equal(profile.localRuntime.status, 'FINAL_FROZEN');
    assert.equal(profile.submissionEnabled, true);
    assert.equal(profile.formalSubmit, true);
  }
});

test('problem page initializes profile API configuration before the first submit gate check', () => {
  const script = fs.readFileSync(path.join(__dirname, '../public/js/contest/problem-detail.js'), 'utf8');
  assert.ok(script.indexOf("var PUBLIC_API_BASE = '/api/public';") < script.indexOf('updateSubmitPreviewGate();'));
  assert.ok(script.indexOf('var cachedProfiles = null;') < script.indexOf('updateSubmitPreviewGate();'));
});

test('runtime info describes the production judge sandbox accurately', () => {
  const view = fs.readFileSync(path.join(__dirname, '../views/contest/runtime-info.ejs'), 'utf8');
  assert.equal(view.includes('Official Judge 无沙箱约束'), false);
  assert.equal(view.includes('Official Judge 在受控 systemd 沙箱中'), true);
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
