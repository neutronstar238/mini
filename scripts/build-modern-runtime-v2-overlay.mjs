import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const V1_DIR = join(ROOT, 'server', 'public', 'js', 'runtime', 'cpp-modern-engine-v1');
const V2_DIR = join(ROOT, 'server', 'public', 'js', 'runtime', 'cpp-modern-engine-v2');
const OUT = join(V2_DIR, 'runtime-manifest.json');

function sha256(body) { return createHash('sha256').update(body).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
function localAsset(file, url, kind, role, mountPath) {
  const path = join(ROOT, ...url.replace(/^\//, '').split('/').map((part, index) => {
    if (index === 0 && part === 'js') return join('server', 'public', 'js');
    return part;
  }));
  const body = readFileSync(path);
  return {file, url: '/' + url.replace(/^\//, ''), kind, role, bytes: body.byteLength, sha256: sha256(body), ...(mountPath ? {mountPath} : {})};
}

function overlayAsset(file, role, mountPath) {
  const body = readFileSync(join(V2_DIR, ...file.split('/')));
  return {
    file,
    url: '/runtime/cpp-modern-engine-v2/' + file,
    kind: 'header-shim',
    role,
    mountPath,
    bytes: body.byteLength,
    sha256: sha256(body)
  };
}

function buildManifest() {
  const v1 = JSON.parse(readFileSync(join(V1_DIR, 'runtime-manifest.json'), 'utf8'));
  const shared = v1.assets.map(asset => ({
    ...asset,
    file: 'shared/' + asset.file,
    url: '/runtime/cpp-modern-engine-v1/' + asset.file,
    inheritedFrom: 'cpp-modern-engine-v1'
  }));
  const shims = [
    overlayAsset('bits/stdc++.h', 'gcc14-compatible-standard-header-aggregate',
      '/sys/include/c++/v1/bits/stdc++.h'),
    overlayAsset('ext/pb_ds/assoc_container.hpp', 'gnu-pbds-assoc-container-compatibility',
      '/sys/include/c++/v1/ext/pb_ds/assoc_container.hpp'),
    overlayAsset('ext/pb_ds/tree_policy.hpp', 'gnu-pbds-tree-policy-compatibility',
      '/sys/include/c++/v1/ext/pb_ds/tree_policy.hpp')
  ];
  const controllerBody = readFileSync(join(ROOT, 'server', 'public', 'js', 'contest', 'ide-wasi-worker-modern.js'));
  const executorBody = readFileSync(join(ROOT, 'server', 'public', 'js', 'contest', 'ide-wasi-execution-worker-modern.js'));
  const codeAssets = [
    {file: 'code/controller.mjs', url: '/js/contest/ide-wasi-worker-modern.js', kind: 'metadata', role: 'control-code', bytes: controllerBody.byteLength, sha256: sha256(controllerBody)},
    {file: 'code/executor.mjs', url: '/js/contest/ide-wasi-execution-worker-modern.js', kind: 'metadata', role: 'execution-code', bytes: executorBody.byteLength, sha256: sha256(executorBody)}
  ];
  const assets = [...shared, ...shims, ...codeAssets];
  const orderedAssets = assets.map(({file, url, bytes, sha256: hash}) => ({file, url, bytes, sha256: hash}))
    .sort((a, b) => a.file.localeCompare(b.file));
  const runtimeIdentity = canonical({
    contractVersion: 2,
    engineRuntimeId: 'cpp-modern-engine-v2',
    executionProtocolVersion: 'compiler-execution-workers-v1',
    target: 'wasm32-unknown-wasi',
    peeledSourcePins: {
      llvm: 'cd708029e0b2869e80abe31ddb175f7c35361f90',
      emscripten: 'c817c0ca4ba889ee24a185fd954cff7de1bd8afa',
      wasiLibc: '574b88da481569b65a237cb80daf9a2d5aeaf82d'
    },
    profileFlags: {
      'c17-gcc14-compat-v2': ['-std=c17', '-O2'],
      'cpp17-gcc14-compat-v2': ['-std=c++17', '-O2', '-Wno-c++11-narrowing']
    },
    orderedAssets
  });
  const runtimeAssetHash = sha256(JSON.stringify(runtimeIdentity));
  return {
    runtimeId: 'cpp-modern-engine-v2', engineRuntimeId: 'cpp-modern-engine-v2', status: 'BETA',
    target: 'wasm32-unknown-wasi', runtimeHashAlgorithm: 'canonical-runtime-identity-v1',
    runtimeIdentity, runtimeAssetHash, inheritedBinaryRuntimeId: 'cpp-modern-engine-v1',
    llvm: {tag: 'llvmorg-19.1.7', tagObjectSha: 'f34bba6980332ba9447397fc8bd8a0951b224747', peeledSourceCommit: 'cd708029e0b2869e80abe31ddb175f7c35361f90'},
    emscripten: v1.emscripten, wasiLibc: v1.wasiLibc, memory: v1.memory,
    profiles: {
      'c17-gcc14-compat-v2': {standard: 'c17', flags: ['-std=c17', '-O2'], submissionEnabled: false},
      'cpp17-gcc14-compat-v2': {standard: 'c++17', flags: ['-std=c++17', '-O2', '-Wno-c++11-narrowing'], submissionEnabled: false, pchPolicy: 'none'}
    },
    assets, assetInventory: orderedAssets,
    reproducibleBuild: 'PASS', build: {sourceDateEpoch: v1.build.sourceDateEpoch, generatedAt: v1.build.generatedAt},
    redistribution: {technicalValidated: true, engineeringRedistributionReady: true, legalReviewRequired: true, redistributable: false}
  };
}

const output = JSON.stringify(buildManifest(), null, 2) + '\n';
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== output) throw new Error('cpp-modern-engine-v2 overlay is stale; regenerate it');
  console.log('cpp-modern-engine-v2 overlay: PASS (deterministic)');
} else {
  writeFileSync(OUT, output);
  console.log(`generated ${OUT}`);
}
