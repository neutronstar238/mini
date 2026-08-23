#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const V1_DIR = path.join(REPO_ROOT, 'server', 'public', 'js', 'runtime', 'cpp-modern-engine-v1');
const V2_DIR = path.join(REPO_ROOT, 'server', 'public', 'js', 'runtime', 'cpp-modern-engine-v2');
const V1_MANIFEST = path.join(V1_DIR, 'runtime-manifest.json');
const V2_MANIFEST = path.join(V2_DIR, 'runtime-manifest.json');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'build-modern-runtime-v2-overlay.mjs');
const DEFAULT_OUTPUT = path.join(REPO_ROOT, 'compat-tests', 'modern-cpp', 'results', 'modern-runtime-v2-evidence.json');
const LARGE_BINARY_THRESHOLD_BYTES = 1024 * 1024;

const EXPECTED = Object.freeze({
  runtimeId: 'cpp-modern-engine-v2',
  inheritedRuntimeId: 'cpp-modern-engine-v1',
  target: 'wasm32-unknown-wasi',
  sharedFiles: ['clang.wasm', 'wasm-ld.wasm', 'clang.js', 'wasm-ld.js', 'sysroot.tar', 'loader.mjs']
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeRelative(file) {
  return file.split(path.sep).join('/');
}

function relativeToRoot(file) {
  return normalizeRelative(path.relative(REPO_ROOT, file));
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        const body = fs.readFileSync(fullPath);
        files.push({file: normalizeRelative(path.relative(root, fullPath)), bytes: body.byteLength, sha256: sha256(body)});
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inventory(items) {
  return items.map((item) => ({
    file: item.file,
    url: item.url,
    bytes: item.bytes,
    sha256: item.sha256
  })).sort((left, right) => left.file.localeCompare(right.file));
}

function runGeneratorCheck() {
  const result = spawnSync(process.execPath, [GENERATOR, '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  return {
    command: 'node scripts/build-modern-runtime-v2-overlay.mjs --check',
    exitCode: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    passed: result.status === 0 && /overlay: PASS/.test(String(result.stdout || '')),
    error: result.error ? String(result.error) : null
  };
}

function main() {
  const output = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_OUTPUT;
  const checks = {};
  const issues = [];
  const check = (id, condition, details = {}) => {
    const status = condition ? 'PASS' : 'FAIL';
    const {message, ...evidence} = details;
    checks[id] = {status, ...evidence};
    if (!condition) issues.push({id, message: message || id, details: evidence});
    return condition;
  };

  let report;
  try {
    const v1 = readJson(V1_MANIFEST);
    const v2Raw = fs.readFileSync(V2_MANIFEST);
    const v2 = JSON.parse(v2Raw.toString('utf8'));
    const v2Files = walkFiles(V2_DIR);
    const v2ByFile = new Map(v2Files.map((item) => [item.file, item]));
    const v1Assets = Array.isArray(v1.assets) ? v1.assets : [];
    const v2Assets = Array.isArray(v2.assets) ? v2.assets : [];
    const v2Inventory = Array.isArray(v2.assetInventory) ? v2.assetInventory : [];
    const canonicalRuntimeAssetHash = sha256(Buffer.from(JSON.stringify(canonical(v2.runtimeIdentity))));
    const rawManifestSha256 = sha256(v2Raw);
    const generatorCheck = runGeneratorCheck();

    check('manifestIdentity', v2.runtimeId === EXPECTED.runtimeId &&
      v2.engineRuntimeId === EXPECTED.runtimeId &&
      v2.inheritedBinaryRuntimeId === EXPECTED.inheritedRuntimeId &&
      v2.target === EXPECTED.target &&
      v2.runtimeHashAlgorithm === 'canonical-runtime-identity-v1', {
      message: 'v2 manifest identity/target contract differs',
      runtimeId: v2.runtimeId,
      engineRuntimeId: v2.engineRuntimeId,
      inheritedBinaryRuntimeId: v2.inheritedBinaryRuntimeId,
      target: v2.target,
      runtimeHashAlgorithm: v2.runtimeHashAlgorithm
    });

    check('canonicalRuntimeAssetHash', canonicalRuntimeAssetHash === v2.runtimeAssetHash, {
      message: 'runtimeAssetHash does not match canonical runtime identity',
      algorithm: v2.runtimeHashAlgorithm,
      calculated: canonicalRuntimeAssetHash,
      declared: v2.runtimeAssetHash
    });

    check('externalRawManifestSha256', v2Raw.byteLength > 0 &&
      /^[a-f0-9]{64}$/.test(rawManifestSha256) && rawManifestSha256 !== canonicalRuntimeAssetHash, {
      message: 'external raw manifest SHA/bytes drifted or collapsed into canonical hash',
      bytes: v2Raw.byteLength,
      sha256: rawManifestSha256,
      distinctFromCanonicalHash: rawManifestSha256 !== canonicalRuntimeAssetHash
    });

    const expectedInventory = inventory(v2Assets);
    check('assetInventoryMatchesAssets', sameJson(inventory(v2Inventory), expectedInventory) &&
      v2Inventory.length === 11, {
      message: 'v2 assetInventory does not exactly describe the eleven overlay assets',
      inventoryCount: v2Inventory.length,
      assetsCount: v2Assets.length
    });

    const sharedAssets = v2Assets.filter((asset) => typeof asset.file === 'string' && asset.file.startsWith('shared/'));
    const sharedNames = sharedAssets.map((asset) => asset.file.slice('shared/'.length));
    check('v1SharedAssetSet', v1Assets.length === EXPECTED.sharedFiles.length &&
      sameJson(v1Assets.map((asset) => asset.file).sort(), EXPECTED.sharedFiles.slice().sort()) &&
      sharedAssets.length === EXPECTED.sharedFiles.length &&
      sameJson(sharedNames.slice().sort(), EXPECTED.sharedFiles.slice().sort()), {
      message: 'v1/v2 shared asset set is not the frozen six-asset set',
      v1Count: v1Assets.length,
      v2SharedCount: sharedAssets.length,
      v1Files: v1Assets.map((asset) => asset.file).sort(),
      v2Files: sharedNames.sort(),
      expectedFiles: EXPECTED.sharedFiles
    });

    const sharedEvidence = EXPECTED.sharedFiles.map((file) => {
      const v1Asset = v1Assets.find((asset) => asset.file === file);
      const v2Asset = v2Assets.find((asset) => asset.file === 'shared/' + file);
      const actualPath = path.join(V1_DIR, ...file.split('/'));
      const actualBytes = fs.existsSync(actualPath) ? fs.readFileSync(actualPath) : null;
      const actual = actualBytes ? {bytes: actualBytes.byteLength, sha256: sha256(actualBytes)} : null;
      const expectedUrl = v1Asset?.path || '/runtime/cpp-modern-engine-v1/' + file;
      const matches = !!v1Asset && !!v2Asset && !!actual &&
        v1Asset.bytes === actual.bytes &&
        v1Asset.sha256 === actual.sha256 &&
        v2Asset.url === expectedUrl &&
        v2Asset.inheritedFrom === EXPECTED.inheritedRuntimeId &&
        v2Asset.bytes === actual.bytes &&
        v2Asset.sha256 === actual.sha256;
      check('shared.' + file, matches, {
        message: 'v2 shared asset does not match v1 URL/bytes/SHA-256',
        v1: v1Asset ? {file: v1Asset.file, url: expectedUrl, bytes: v1Asset.bytes, sha256: v1Asset.sha256} : null,
        v2: v2Asset ? {file: v2Asset.file, url: v2Asset.url, bytes: v2Asset.bytes, sha256: v2Asset.sha256, inheritedFrom: v2Asset.inheritedFrom} : null,
        actual
      });
      return {
        file,
        url: expectedUrl,
        bytes: actual?.bytes ?? null,
        sha256: actual?.sha256 ?? null,
        v1Declared: v1Asset ? {bytes: v1Asset.bytes, sha256: v1Asset.sha256} : null,
        v2Declared: v2Asset ? {bytes: v2Asset.bytes, sha256: v2Asset.sha256} : null,
        inheritedFrom: v2Asset?.inheritedFrom || null,
        status: matches ? 'PASS' : 'FAIL'
      };
    });

    const shimCodeSpecs = [
      {
        id: 'shim',
        assetFile: 'bits/stdc++.h',
        localPath: path.join(V2_DIR, 'bits', 'stdc++.h'),
        expected: {
          url: '/runtime/cpp-modern-engine-v2/bits/stdc++.h',
          kind: 'header-shim',
          role: 'gcc14-compatible-standard-header-aggregate',
          mountPath: '/sys/include/c++/v1/bits/stdc++.h'
        }
      },
      {
        id: 'pbdsAssocContainer',
        assetFile: 'ext/pb_ds/assoc_container.hpp',
        localPath: path.join(V2_DIR, 'ext', 'pb_ds', 'assoc_container.hpp'),
        expected: {
          url: '/runtime/cpp-modern-engine-v2/ext/pb_ds/assoc_container.hpp',
          kind: 'header-shim',
          role: 'gnu-pbds-assoc-container-compatibility',
          mountPath: '/sys/include/c++/v1/ext/pb_ds/assoc_container.hpp'
        }
      },
      {
        id: 'pbdsTreePolicy',
        assetFile: 'ext/pb_ds/tree_policy.hpp',
        localPath: path.join(V2_DIR, 'ext', 'pb_ds', 'tree_policy.hpp'),
        expected: {
          url: '/runtime/cpp-modern-engine-v2/ext/pb_ds/tree_policy.hpp',
          kind: 'header-shim',
          role: 'gnu-pbds-tree-policy-compatibility',
          mountPath: '/sys/include/c++/v1/ext/pb_ds/tree_policy.hpp'
        }
      },
      {
        id: 'controller',
        assetFile: 'code/controller.mjs',
        localPath: path.join(REPO_ROOT, 'server', 'public', 'js', 'contest', 'ide-wasi-worker-modern.js'),
        expected: {
          url: '/js/contest/ide-wasi-worker-modern.js',
          kind: 'metadata',
          role: 'control-code'
        }
      },
      {
        id: 'executor',
        assetFile: 'code/executor.mjs',
        localPath: path.join(REPO_ROOT, 'server', 'public', 'js', 'contest', 'ide-wasi-execution-worker-modern.js'),
        expected: {
          url: '/js/contest/ide-wasi-execution-worker-modern.js',
          kind: 'metadata',
          role: 'execution-code'
        }
      }
    ];

    const shimCodeEvidence = shimCodeSpecs.map((spec) => {
      const asset = v2Assets.find((item) => item.file === spec.assetFile);
      const body = fs.existsSync(spec.localPath) ? fs.readFileSync(spec.localPath) : null;
      const actual = body ? {bytes: body.byteLength, sha256: sha256(body)} : null;
      const fieldsMatch = !!asset && Object.entries(spec.expected).every(([key, value]) => asset[key] === value);
      const matches = fieldsMatch && !!actual && asset.bytes === actual.bytes && asset.sha256 === actual.sha256;
      check('overlay.' + spec.id, matches, {
        message: spec.id + ' asset metadata or local bytes/SHA-256 do not match',
        asset: asset || null,
        actual,
        expected: spec.expected,
        localPath: relativeToRoot(spec.localPath)
      });
      return {
        id: spec.id,
        file: spec.assetFile,
        localPath: relativeToRoot(spec.localPath),
        url: asset?.url || null,
        bytes: actual?.bytes ?? null,
        sha256: actual?.sha256 ?? null,
        declaredBytes: asset?.bytes ?? null,
        declaredSha256: asset?.sha256 ?? null,
        status: matches ? 'PASS' : 'FAIL'
      };
    });

    const physicalAssetFiles = v2Files.filter((item) => item.file !== 'runtime-manifest.json' && item.file !== 'asset-index.json');
    const largeBinaryFiles = physicalAssetFiles.filter((item) => item.bytes >= LARGE_BINARY_THRESHOLD_BYTES);
    const copiedSharedFiles = physicalAssetFiles.filter((item) => item.file.startsWith('shared/'));
    const copiedDeclaredSharedFiles = sharedAssets
      .filter((asset) => v2ByFile.has(asset.file))
      .map((asset) => asset.file);
    const noCopiedLargeBinaries = largeBinaryFiles.length === 0 &&
      copiedSharedFiles.length === 0 &&
      copiedDeclaredSharedFiles.length === 0;

    check('noCopiedLargeBinaries', noCopiedLargeBinaries, {
      message: 'v2 overlay physically copies a large binary or shared asset',
      thresholdBytes: LARGE_BINARY_THRESHOLD_BYTES,
      physicalFiles: v2Files,
      largeBinaryFiles,
      copiedSharedFiles,
      copiedDeclaredSharedFiles
    });

    check('overlayGeneratorCheck', generatorCheck.passed, {
      message: 'overlay generator --check failed',
      ...generatorCheck
    });

    const requiredEngineeringFiles = [
      path.join(V1_DIR, 'LICENSE'),
      path.join(V1_DIR, 'THIRD_PARTY_LICENSE_MATRIX.md'),
      path.join(V1_DIR, 'THIRD_PARTY_NOTICES.md'),
      path.join(REPO_ROOT, 'scripts', 'build-modern-runtime-v2-overlay.mjs'),
      path.join(REPO_ROOT, 'scripts', 'verify-modern-runtime-evidence.mjs'),
      path.join(REPO_ROOT, 'scripts', 'verify-modern-runtime-v2-overlay.mjs')
    ];
    const engineeringFiles = requiredEngineeringFiles.map((file) => ({
      file: relativeToRoot(file),
      exists: fs.existsSync(file),
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0
    }));
    const knownBinaryFiles = ['clang.wasm', 'wasm-ld.wasm', 'sysroot.tar'];
    const declaredBinaryFiles = (v1.assetInventory || [])
      .map((asset) => asset.file)
      .filter((file) => /\.(?:wasm|tar)$/.test(file))
      .sort();
    const sourcePinsPresent = v2.runtimeIdentity?.peeledSourcePins?.llvm === 'cd708029e0b2869e80abe31ddb175f7c35361f90'
      && /^[a-f0-9]{40}$/.test(v2.runtimeIdentity?.peeledSourcePins?.emscripten || '')
      && /^[a-f0-9]{40}$/.test(v2.runtimeIdentity?.peeledSourcePins?.wasiLibc || '');
    const engineeringArtifactsPass = engineeringFiles.every((file) => file.exists && file.bytes > 0)
      && sourcePinsPresent
      && /cross-build/.test(v1.compilerStrategy || '')
      && v1.reproducibleBuild === 'PASS'
      && sameJson(declaredBinaryFiles, knownBinaryFiles.slice().sort())
      && noCopiedLargeBinaries;
    check('redistributionEngineeringArtifacts', engineeringArtifactsPass, {
      message: 'licenses/notices/build scripts/source pins or known-binary inventory are incomplete',
      selfBuiltCompilerAndLinker: /cross-build/.test(v1.compilerStrategy || ''),
      sourcePinsPresent,
      v1ReproducibleBuild: v1.reproducibleBuild,
      engineeringFiles,
      declaredBinaryFiles,
      knownBinaryFiles: knownBinaryFiles.slice().sort(),
      unknownBinaryFiles: declaredBinaryFiles.filter((file) => !knownBinaryFiles.includes(file)),
      v2NoCopiedLargeBinaries: noCopiedLargeBinaries
    });

    const redistribution = v2.redistribution || {};
    const redistributionPass = redistribution.technicalValidated === true &&
      redistribution.engineeringRedistributionReady === true &&
      redistribution.legalReviewRequired === true &&
      redistribution.redistributable === false && engineeringArtifactsPass;
    check('redistributionFields', redistributionPass, {
      message: 'v2 redistribution fields do not match the fixed engineering/legal boundary',
      manifest: redistribution,
      expected: {
        technicalValidated: true,
        engineeringRedistributionReady: true,
        legalReviewRequired: true,
        redistributable: false
      }
    });

    check('reproducibleBuildField', v2.reproducibleBuild === 'PASS', {
      message: 'v2 reproducibleBuild field is not PASS',
      value: v2.reproducibleBuild
    });

    report = {
      schemaVersion: 'modern-runtime-v2-overlay-evidence-v1',
      evidenceId: 'MODERN_CPP_PHASE8_RUNTIME_V2_OVERLAY_EVIDENCE',
      generatedAt: new Date().toISOString(),
      runtimeId: v2.runtimeId || EXPECTED.runtimeId,
      manifest: {
        path: relativeToRoot(V2_MANIFEST),
        bytes: v2Raw.byteLength,
        externalRawSha256: rawManifestSha256,
        declaredCanonicalRuntimeAssetHash: v2.runtimeAssetHash || null,
        calculatedCanonicalRuntimeAssetHash: canonicalRuntimeAssetHash,
        hashAlgorithm: v2.runtimeHashAlgorithm || null,
        canonicalInput: 'JSON.stringify(canonical(runtimeIdentity))',
        rawHashIsExternal: true
      },
      sharedV1Assets: sharedEvidence,
      shimAndCodeAssets: shimCodeEvidence,
      physicalOverlay: {
        root: relativeToRoot(V2_DIR),
        files: v2Files,
        physicalAssetFiles,
        copiedLargeBinaryCheck: {
          thresholdBytes: LARGE_BINARY_THRESHOLD_BYTES,
          largeBinaryFiles,
          copiedSharedFiles,
          copiedDeclaredSharedFiles,
          noCopiedLargeBinaries
        }
      },
      generatorCheck,
      redistribution: {
        technicalValidated: redistribution.technicalValidated === true,
        engineeringRedistributionReady: redistribution.engineeringRedistributionReady === true,
        legalReviewRequired: redistribution.legalReviewRequired === true,
        redistributable: redistribution.redistributable === true,
        ENGINEERING_REDISTRIBUTION_READY: redistribution.engineeringRedistributionReady === true,
        LEGAL_REVIEW_REQUIRED: redistribution.legalReviewRequired === true,
        REDISTRIBUTABLE: redistribution.redistributable === true,
        decision: redistribution.redistributable === false ? 'DISTRIBUTION_BLOCKED' : 'REVIEW_REQUIRED',
        engineeringArtifacts: {
          status: engineeringArtifactsPass ? 'PASS' : 'FAIL',
          files: engineeringFiles,
          sourcePinsPresent,
          selfBuiltCompilerAndLinker: /cross-build/.test(v1.compilerStrategy || ''),
          unknownBinaryFiles: declaredBinaryFiles.filter((file) => !knownBinaryFiles.includes(file))
        }
      },
      checks,
      evidenceConsistency: issues.length === 0 ? 'PASS' : 'FAIL',
      issues
    };
  } catch (error) {
    issues.push({id: 'fatal', message: String(error?.stack || error)});
    report = {
      schemaVersion: 'modern-runtime-v2-overlay-evidence-v1',
      evidenceId: 'MODERN_CPP_PHASE8_RUNTIME_V2_OVERLAY_EVIDENCE',
      generatedAt: new Date().toISOString(),
      evidenceConsistency: 'FAIL',
      checks,
      issues
    };
  }

  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log('modern-runtime-v2-overlay-evidence: ' + report.evidenceConsistency);
  console.log('output: ' + output);
  for (const issue of report.issues || []) console.error(issue.id + ': ' + issue.message);
  if (report.evidenceConsistency !== 'PASS') process.exitCode = 1;
}

main();
