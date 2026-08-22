#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const EXPECTED = Object.freeze({
  runtimeId: 'cpp-modern-engine-v1',
  target: 'wasm32-unknown-wasi',
  manifestBytes: 6357,
  manifestSha256: '25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c',
  inventoryCount: 18,
  liveAssetCount: 6,
  reproducibilityFileCount: 20,
  llvmTag: 'llvmorg-19.1.7',
  llvmRequestedCommit: 'f34bba6980332ba9447397fc8bd8a0951b224747',
  llvmPeeledCommit: 'cd708029e0b2869e80abe31ddb175f7c35361f90',
  emscriptenVersion: '5.0.2',
  emscriptenCommit: 'c817c0ca4ba889ee24a185fd954cff7de1bd8afa',
  emscriptenImage: 'emscripten/emsdk:5.0.2',
  emscriptenImageDigest: 'sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d',
  wasiLibcCommit: '574b88da481569b65a237cb80daf9a2d5aeaf82d',
  wasiLibcTag: 'main',
  metadataFiles: ['asset-index.json', 'runtime-manifest.json']
});

const DEFAULTS = Object.freeze({
  published: path.join(REPO_ROOT, 'server', 'public', 'js', 'runtime', 'cpp-modern-engine-v1'),
  reproA: path.join(REPO_ROOT, 'modern-clang-oj', 'repro-a'),
  reproB: path.join(REPO_ROOT, 'modern-clang-oj', 'repro-b'),
  llvmSource: path.join(REPO_ROOT, 'modern-clang-oj', 'src', 'llvm-project'),
  pins: path.join(REPO_ROOT, 'modern-clang-oj', 'PINNED_SOURCES.env'),
  output: path.join(REPO_ROOT, 'compat-tests', 'modern-cpp', 'results', 'modern-runtime-evidence.json')
});

function parseArgs(argv) {
  const options = {...DEFAULTS};
  const names = new Map([
    ['--published', 'published'],
    ['--repro-a', 'reproA'],
    ['--repro-b', 'reproB'],
    ['--llvm-source', 'llvmSource'],
    ['--pins', 'pins'],
    ['--output', 'output']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/verify-modern-runtime-evidence.mjs [options]');
      console.log('  --published DIR   final published v1 runtime directory');
      console.log('  --repro-a DIR     reproducibility build A directory');
      console.log('  --repro-b DIR     reproducibility build B directory');
      console.log('  --llvm-source DIR LLVM git checkout used for tag-object verification');
      console.log('  --pins FILE       PINNED_SOURCES.env file');
      console.log('  --output FILE     machine-readable evidence output');
      process.exit(0);
    }
    const optionName = names.get(arg);
    if (!optionName) throw new Error(`unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    options[optionName] = path.resolve(value);
    index += 1;
  }
  return options;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeRelative(file) {
  return file.split(path.sep).join('/');
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      } else {
        throw new Error(`unsupported non-file entry in runtime directory: ${fullPath}`);
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function snapshot(root) {
  const files = walkFiles(root).map((fullPath) => {
    const bytes = fs.readFileSync(fullPath);
    return {
      file: normalizeRelative(path.relative(root, fullPath)),
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    };
  });
  return {
    files,
    byFile: new Map(files.map((item) => [item.file, item]))
  };
}

function parsePins(file) {
  const pins = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    pins[match[1]] = value;
  }
  return pins;
}

function runGit(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], {encoding: 'utf8', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${detail}`);
  }
  return String(result.stdout || '').trim();
}

function issue(issues, code, message, details = undefined) {
  issues.push(details === undefined ? {code, message} : {code, message, details});
}

function validateSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function sortInventory(items) {
  return items
    .map((item) => ({file: item.file, bytes: item.bytes, sha256: item.sha256}))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function validateRoot(label, root) {
  const issues = [];
  const manifestPath = path.join(root, 'runtime-manifest.json');
  const indexPath = path.join(root, 'asset-index.json');
  if (!fs.existsSync(root)) {
    issue(issues, 'missing-root', `${label} runtime directory does not exist`, root);
    return {label, root, issues, files: [], byFile: new Map(), manifest: null, rawManifest: null};
  }
  if (!fs.existsSync(manifestPath)) {
    issue(issues, 'missing-manifest', `${label} runtime-manifest.json is missing`, manifestPath);
    return {label, root, issues, files: [], byFile: new Map(), manifest: null, rawManifest: null};
  }

  const rawManifest = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(rawManifest.toString('utf8'));
  } catch (error) {
    issue(issues, 'invalid-manifest-json', `${label} runtime-manifest.json is not valid JSON`, String(error));
    return {label, root, issues, files: [], byFile: new Map(), manifest: null, rawManifest};
  }
  const tree = snapshot(root);
  const inventory = Array.isArray(manifest.assetInventory) ? manifest.assetInventory : [];
  const liveAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
  const inventoryNames = inventory.map((item) => item?.file);
  const liveNames = liveAssets.map((item) => item?.file);
  const expectedAssetNames = tree.files
    .map((item) => item.file)
    .filter((file) => !EXPECTED.metadataFiles.includes(file));

  if (manifest.runtimeId !== EXPECTED.runtimeId || manifest.engineRuntimeId !== EXPECTED.runtimeId) {
    issue(issues, 'runtime-id', `${label} runtime ID does not identify cpp-modern-engine-v1`, {
      runtimeId: manifest.runtimeId,
      engineRuntimeId: manifest.engineRuntimeId
    });
  }
  if (manifest.target !== EXPECTED.target) issue(issues, 'target', `${label} target is not ${EXPECTED.target}`, manifest.target);
  if (inventory.length !== EXPECTED.inventoryCount) {
    issue(issues, 'inventory-count', `${label} assetInventory count is not ${EXPECTED.inventoryCount}`, inventory.length);
  }
  if (liveAssets.length !== EXPECTED.liveAssetCount) {
    issue(issues, 'live-count', `${label} live assets count is not ${EXPECTED.liveAssetCount}`, liveAssets.length);
  }
  if (tree.files.length !== EXPECTED.reproducibilityFileCount) {
    issue(issues, 'physical-file-count', `${label} physical file count is not ${EXPECTED.reproducibilityFileCount}`, tree.files.length);
  }
  if (!sameJson([...new Set(inventoryNames)].sort(), inventoryNames.slice().sort())) {
    issue(issues, 'duplicate-inventory', `${label} assetInventory contains duplicate file names`);
  }
  if (!sameJson([...new Set(liveNames)].sort(), liveNames.slice().sort())) {
    issue(issues, 'duplicate-live', `${label} assets contains duplicate file names`);
  }
  if (!sameJson(expectedAssetNames.slice().sort(), inventoryNames.slice().sort())) {
    issue(issues, 'inventory-files', `${label} physical asset files and assetInventory differ`, {
      physical: expectedAssetNames,
      manifest: inventoryNames.slice().sort()
    });
  }

  const metadata = new Map(inventory.map((item) => [item.file, item]));
  for (const item of inventory) {
    const actual = tree.byFile.get(item.file);
    if (!item || typeof item.file !== 'string' || !Number.isInteger(item.bytes) || !validateSha(item.sha256)) {
      issue(issues, 'invalid-asset-metadata', `${label} has invalid asset metadata`, item);
      continue;
    }
    if (!actual) {
      issue(issues, 'missing-asset', `${label} is missing declared asset ${item.file}`);
      continue;
    }
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256.toLowerCase()) {
      issue(issues, 'asset-digest', `${label} asset bytes/SHA-256 mismatch for ${item.file}`, {declared: item, actual});
    }
  }
  for (const item of liveAssets) {
    const declared = metadata.get(item?.file);
    if (!declared) {
      issue(issues, 'live-not-in-inventory', `${label} live asset is absent from assetInventory`, item);
      continue;
    }
    if (item.bytes !== declared.bytes || item.sha256?.toLowerCase() !== declared.sha256?.toLowerCase()) {
      issue(issues, 'live-metadata', `${label} live asset metadata differs from inventory`, item);
    }
  }

  if (!fs.existsSync(indexPath)) {
    issue(issues, 'missing-asset-index', `${label} asset-index.json is missing`, indexPath);
  } else {
    try {
      const index = readJson(indexPath);
      if (!Array.isArray(index) || !sameJson(sortInventory(index), sortInventory(inventory))) {
        issue(issues, 'asset-index', `${label} asset-index.json differs from assetInventory`);
      }
    } catch (error) {
      issue(issues, 'invalid-asset-index', `${label} asset-index.json is not valid evidence`, String(error));
    }
  }
  if (manifest.reproducibleBuild !== 'PASS') {
    issue(issues, 'reproducible-field', `${label} manifest reproducibleBuild is not PASS`, manifest.reproducibleBuild);
  }

  return {
    label,
    root,
    issues,
    files: tree.files,
    byFile: tree.byFile,
    manifest,
    rawManifest,
    manifestSha256: sha256(rawManifest),
    inventory,
    liveAssets
  };
}

function compareSnapshots(left, right) {
  const mismatches = [];
  const names = [...new Set([...left.byFile.keys(), ...right.byFile.keys()])].sort();
  for (const name of names) {
    const a = left.byFile.get(name) || null;
    const b = right.byFile.get(name) || null;
    if (!a || !b || a.bytes !== b.bytes || a.sha256 !== b.sha256) {
      mismatches.push({file: name, left: a, right: b});
    }
  }
  return mismatches;
}

function checkPins(publicEvidence, pinned, llvmSource, issues) {
  const manifest = publicEvidence.manifest || {};
  const llvm = manifest.llvm || {};
  const emscripten = manifest.emscripten || {};
  const wasi = manifest.wasiLibc || {};
  const tag = pinned.LLVM_PROJECT_TAG || EXPECTED.llvmTag;
  let tagObjectSha = null;
  let peeledSourceCommit = null;
  let tagObjectType = null;
  let peeledObjectType = null;
  let showRef = null;
  try {
    tagObjectSha = runGit(llvmSource, ['rev-parse', `${tag}^{object}`]);
    peeledSourceCommit = runGit(llvmSource, ['rev-parse', `${tag}^{}`]);
    tagObjectType = runGit(llvmSource, ['cat-file', '-t', `${tag}^{object}`]);
    peeledObjectType = runGit(llvmSource, ['cat-file', '-t', `${tag}^{}`]);
    showRef = runGit(llvmSource, ['show-ref', '--tags']);
  } catch (error) {
    issue(issues, 'llvm-git', 'LLVM tag/source Git object verification failed', String(error));
  }
  const expectedRequested = pinned.LLVM_PROJECT_COMMIT || EXPECTED.llvmRequestedCommit;
  const expectedEmscripten = {
    version: pinned.EMSDK_VERSION || EXPECTED.emscriptenVersion,
    commit: pinned.EMSDK_COMMIT || EXPECTED.emscriptenCommit,
    image: pinned.EMSDK_IMAGE || EXPECTED.emscriptenImage,
    imageDigest: pinned.EMSDK_IMAGE_DIGEST || EXPECTED.emscriptenImageDigest
  };
  const expectedWasi = pinned.WASI_LIBC_COMMIT || EXPECTED.wasiLibcCommit;
  if (tag !== EXPECTED.llvmTag) issue(issues, 'llvm-tag', 'LLVM tag differs from the frozen v1 tag', {expected: EXPECTED.llvmTag, actual: tag});
  if (tagObjectSha !== expectedRequested) issue(issues, 'llvm-requested-object', 'LLVM tag object SHA differs from the pinned requested object', {expected: expectedRequested, actual: tagObjectSha});
  if (tagObjectType !== 'tag') issue(issues, 'llvm-tag-type', 'LLVM reference is not an annotated tag object', tagObjectType);
  if (peeledObjectType !== 'commit') issue(issues, 'llvm-peeled-type', 'LLVM peeled reference is not a commit', peeledObjectType);
  if (peeledSourceCommit !== EXPECTED.llvmPeeledCommit) issue(issues, 'llvm-peeled-commit', 'LLVM peeled source commit differs from the v1 source pin', {expected: EXPECTED.llvmPeeledCommit, actual: peeledSourceCommit});
  if (!showRef?.split(/\r?\n/).some((line) => line.startsWith(`${tagObjectSha} `) && line.endsWith(`refs/tags/${tag}`))) {
    issue(issues, 'llvm-show-ref', 'LLVM show-ref does not contain the expected tag object SHA', {tag, tagObjectSha});
  }
  if (llvm.tag !== tag || llvm.commit !== tagObjectSha || llvm.resolvedCommit !== peeledSourceCommit) {
    issue(issues, 'llvm-manifest-pin', 'published manifest LLVM pin does not match Git object evidence', {manifest: llvm, tagObjectSha, peeledSourceCommit});
  }
  if (emscripten.version !== expectedEmscripten.version || emscripten.commit !== expectedEmscripten.commit || emscripten.image !== expectedEmscripten.image || emscripten.imageDigest !== expectedEmscripten.imageDigest) {
    issue(issues, 'emscripten-pin', 'published manifest Emscripten pin does not match PINNED_SOURCES.env', {expected: expectedEmscripten, actual: emscripten});
  }
  if (wasi.commit !== expectedWasi || wasi.resolvedCommit !== expectedWasi) {
    issue(issues, 'wasi-pin', 'published manifest wasi-libc pin does not match PINNED_SOURCES.env', {expected: expectedWasi, actual: wasi});
  }
  return {
    llvm: {
      tag,
      tagObjectSha,
      tagObjectType,
      peeledSourceCommit,
      peeledObjectType,
      requestedCommit: expectedRequested,
      manifestCommit: llvm.commit || null,
      manifestResolvedCommit: llvm.resolvedCommit || null,
      showRefContainsTagObject: !!showRef?.split(/\r?\n/).some((line) => line.startsWith(`${tagObjectSha} `) && line.endsWith(`refs/tags/${tag}`))
    },
    emscripten: {
      expected: expectedEmscripten,
      manifest: {
        version: emscripten.version || null,
        commit: emscripten.commit || null,
        image: emscripten.image || null,
        imageDigest: emscripten.imageDigest || null,
        imageId: emscripten.imageId || null
      }
    },
    wasiLibc: {
      expected: {tag: pinned.WASI_LIBC_TAG || EXPECTED.wasiLibcTag, commit: expectedWasi},
      manifest: {commit: wasi.commit || null, resolvedCommit: wasi.resolvedCommit || null}
    }
  };
}

function buildReport(options) {
  const issues = [];
  const pinned = parsePins(options.pins);
  const roots = [
    validateRoot('repro-a', options.reproA),
    validateRoot('repro-b', options.reproB),
    validateRoot('public', options.published)
  ];
  const publicEvidence = roots.find((root) => root.label === 'public');
  const publicManifestBytes = publicEvidence.rawManifest?.byteLength ?? null;
  const publicManifestSha256 = publicEvidence.manifestSha256 ?? null;
  for (const root of roots) {
    for (const rootIssue of root.issues) issue(issues, `${root.label}.${rootIssue.code}`, rootIssue.message, rootIssue.details);
  }

  if (publicManifestBytes !== EXPECTED.manifestBytes) issue(issues, 'manifest-bytes', 'published v1 manifest byte length differs from Checkpoint 1', {expected: EXPECTED.manifestBytes, actual: publicManifestBytes});
  if (publicManifestSha256 !== EXPECTED.manifestSha256) issue(issues, 'manifest-sha256', 'published v1 manifest raw SHA-256 differs from Checkpoint 1', {expected: EXPECTED.manifestSha256, actual: publicManifestSha256});

  const manifestFieldNames = ['runtimeAssetHash', 'assetHash', 'assetsHash'];
  const declaredRuntimeAssetHash = manifestFieldNames.map((name) => publicEvidence.manifest?.[name]).find((value) => typeof value === 'string') || null;
  if (declaredRuntimeAssetHash !== null && declaredRuntimeAssetHash !== publicManifestSha256) {
    issue(issues, 'runtime-asset-hash-field', 'published manifest declares a runtime hash that does not match its raw bytes', {declared: declaredRuntimeAssetHash, actual: publicManifestSha256});
  }

  const manifestComparisons = {};
  const fileComparisons = {};
  for (const root of roots) {
    if (root.label === 'public') continue;
    const manifestMatch = !!publicEvidence.rawManifest && !!root.rawManifest && publicEvidence.rawManifest.equals(root.rawManifest);
    const mismatches = compareSnapshots(root, publicEvidence);
    manifestComparisons[root.label] = {byteIdentical: manifestMatch, sha256: root.manifestSha256 || null};
    fileComparisons[root.label] = {byteIdentical: mismatches.length === 0, mismatchCount: mismatches.length, mismatches};
    if (!manifestMatch) issue(issues, 'manifest-reproducibility', `${root.label} manifest differs from public raw bytes`);
    if (mismatches.length > 0) issue(issues, 'file-reproducibility', `${root.label} physical files differ from public`, mismatches);
  }

  const pinEvidence = checkPins(publicEvidence, pinned, options.llvmSource, issues);
  const publicInventory = publicEvidence.inventory || [];
  const publicLiveAssets = publicEvidence.liveAssets || [];
  const publicFiles = publicEvidence.files || [];
  const assetFileNames = new Set(publicInventory.map((item) => item.file));
  const metadataFiles = publicFiles.filter((item) => !assetFileNames.has(item.file)).map((item) => item.file);
  const allRootsByteIdentical = Object.values(fileComparisons).every((item) => item.byteIdentical);
  const counts = {
    publishedRuntimeManifestSet: publicInventory.length,
    liveRuntimeSet: publicLiveAssets.length,
    buildReproducibilitySet: publicFiles.length,
    physicalPublishedFiles: publicFiles.length,
    nonInventoryFiles: metadataFiles
  };
  const check = (condition, details = {}) => ({status: condition ? 'PASS' : 'FAIL', ...details});
  const report = {
    schemaVersion: 1,
    evidenceId: 'MODERN_CPP_PHASE8_RUNTIME_EVIDENCE_FIX',
    runtimeId: publicEvidence.manifest?.engineRuntimeId || publicEvidence.manifest?.runtimeId || EXPECTED.runtimeId,
    engineChanged: false,
    runtimeAssetHash: publicManifestSha256,
    manifestFileSha256: publicManifestSha256,
    runtimeAssetHashSemantics: {
      algorithm: 'SHA-256',
      input: 'final published v1 runtime-manifest.json raw bytes',
      canonicalization: 'none; bytes are hashed exactly as read from the final disk file',
      manifestFieldPresent: declaredRuntimeAssetHash !== null,
      declaredManifestField: declaredRuntimeAssetHash,
      selfReference: false,
      harnessReadsFinalDiskFile: true,
      note: 'cpp-modern-engine-v1 has no runtimeAssetHash field in the manifest; the externally recorded runtimeAssetHash and separately named manifestFileSha256 intentionally have the same value for this legacy raw-manifest contract.'
    },
    counts,
    published: {
      path: path.relative(REPO_ROOT, options.published).split(path.sep).join('/'),
      manifestBytes: publicManifestBytes,
      manifestFileSha256: publicManifestSha256,
      inventory: publicInventory,
      liveAssets: publicLiveAssets,
      files: publicFiles
    },
    reproducibility: {
      status: allRootsByteIdentical ? 'PASS' : 'FAIL',
      roots: {
        'repro-a': path.relative(REPO_ROOT, options.reproA).split(path.sep).join('/'),
        'repro-b': path.relative(REPO_ROOT, options.reproB).split(path.sep).join('/'),
        public: path.relative(REPO_ROOT, options.published).split(path.sep).join('/')
      },
      fileCount: publicFiles.length,
      allBytesAndSha256Identical: allRootsByteIdentical,
      manifestComparisons,
      fileComparisons,
      files: publicFiles
    },
    llvm: pinEvidence.llvm,
    pins: {
      emscripten: pinEvidence.emscripten,
      wasiLibc: pinEvidence.wasiLibc,
      pinnedSourcesFile: path.relative(REPO_ROOT, options.pins).split(path.sep).join('/')
    },
    checks: {
      runtimeAssetHash: check(publicManifestSha256 === EXPECTED.manifestSha256 && publicManifestBytes === EXPECTED.manifestBytes, {value: publicManifestSha256, bytes: publicManifestBytes}),
      manifestFileSha256: check(publicManifestSha256 === EXPECTED.manifestSha256, {value: publicManifestSha256}),
      assetCounts: check(counts.publishedRuntimeManifestSet === EXPECTED.inventoryCount && counts.liveRuntimeSet === EXPECTED.liveAssetCount && counts.buildReproducibilitySet === EXPECTED.reproducibilityFileCount, counts),
      assetBytesAndSha256: check(roots.every((root) => root.issues.every((item) => !['inventory-count', 'live-count', 'physical-file-count', 'inventory-files', 'invalid-asset-metadata', 'missing-asset', 'asset-digest', 'live-not-in-inventory', 'live-metadata', 'asset-index'].includes(item.code))), {inventoryCount: publicInventory.length}),
      reproducibleBuild: check(allRootsByteIdentical, {fileCount: publicFiles.length}),
      llvmTagSourcePin: check(issues.every((item) => !item.code.startsWith('llvm-')), pinEvidence.llvm),
      emscriptenPin: check(issues.every((item) => item.code !== 'emscripten-pin'), pinEvidence.emscripten),
      wasiLibcPin: check(issues.every((item) => item.code !== 'wasi-pin'), pinEvidence.wasiLibc)
    },
    evidenceConsistency: issues.length === 0 ? 'PASS' : 'FAIL',
    issues
  };
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let report;
  try {
    report = buildReport(options);
  } catch (error) {
    report = {
      schemaVersion: 1,
      evidenceId: 'MODERN_CPP_PHASE8_RUNTIME_EVIDENCE_FIX',
      evidenceConsistency: 'FAIL',
      issues: [{code: 'fatal', message: String(error?.stack || error)}]
    };
  }
  fs.mkdirSync(path.dirname(options.output), {recursive: true});
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`modern-runtime-evidence: ${report.evidenceConsistency}`);
  console.log(`output: ${options.output}`);
  if (report.issues?.length) {
    for (const item of report.issues) console.error(`${item.code}: ${item.message}`);
    process.exitCode = 1;
  }
}

main();
