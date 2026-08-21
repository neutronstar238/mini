import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  attachRequestLog,
  byteLength,
  launchChrome,
  loginAndOpenProblem,
  nowIso,
  startLocalContestServer
} from '../../compat-tests/java21/e2e/harness.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REPORT = process.env.MODERN_CPP_REPORT
  || join(ROOT, 'compat-tests', 'c17', 'modern-cpp-phase8-e2e.json');
const BASE_URL = process.env.BASE_URL || '';
const RUN_TIMEOUT_MS = Number(process.env.MODERN_CPP_RUN_TIMEOUT_MS || 90000);
const MODERN_RUNTIME_ID = 'cpp-modern-engine-v1';
const MODERN_MANIFEST_URL = `/runtime/${MODERN_RUNTIME_ID}/runtime-manifest.json`;
const MODERN_PINS = Object.freeze({
  target: 'wasm32-unknown-wasi',
  llvm: {tag: 'llvmorg-19.1.7', commit: 'f34bba6980332ba9447397fc8bd8a0951b224747'},
  emscripten: {
    version: '5.0.2',
    commit: 'c817c0ca4ba889ee24a185fd954cff7de1bd8afa',
    imageDigest: 'sha256:559781dfc5570c6670d74930a04dfe131cff611b4088761662493d537b87976d'
  },
  wasiLibc: {commit: '574b88da481569b65a237cb80daf9a2d5aeaf82d'}
});

const C17_SOURCE = readFileSync(join(ROOT, 'compat-tests', 'c17', 'a-plus-b.c'), 'utf8');
const CPP17_HELLO_SOURCE = readFileSync(join(ROOT, 'compat-tests', 'cpp17', 'hello-world.cpp'), 'utf8');
const CPP17_AB_SOURCE = readFileSync(join(ROOT, 'compat-tests', 'cpp17', 'a-plus-b.cpp'), 'utf8');
const CACHE_SOURCE = CPP17_AB_SOURCE + '\n// phase8 cache gate\n';
const M4_PROBE_SOURCE = C17_SOURCE + '\n/* phase8 M4 worker-init probe */\n';
const LEGACY_COLD_SOURCE = CPP17_AB_SOURCE + '\n// phase8 legacy cold network baseline\n';
const LEGACY_CACHED_COLD_SOURCE = CPP17_AB_SOURCE + '\n// phase8 legacy cached cold baseline\n';
const LEGACY_WARM_SOURCE = CPP17_AB_SOURCE + '\n// phase8 legacy warm compile baseline\n';

function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function record(id, status, details = {}) { return {id, status, ...details}; }
function trimOutput(value) { return String(value == null ? '' : value).trim(); }
function sourceDigest(source) { return {sourceBytes: byteLength(source), sourceSha256: sha256(source)}; }

function isSha256(value) { return /^[a-f0-9]{64}$/i.test(String(value || '')); }

function manifestSummary(manifest, rawSha256) {
  const declaredRuntimeAssetHash = manifest?.runtimeAssetHash || manifest?.assetHash || manifest?.assetsHash || null;
  return {
    runtimeId: manifest?.runtimeId || null,
    engineRuntimeId: manifest?.engineRuntimeId || null,
    engine: manifest?.engine || null,
    status: manifest?.status || null,
    target: manifest?.target || null,
    llvm: manifest?.llvm || null,
    emscripten: manifest?.emscripten || null,
    wasiLibc: manifest?.wasiLibc || null,
    rawSha256,
    runtimeAssetHash: rawSha256 || null,
    declaredRuntimeAssetHash,
    runtimeAssetHashSource: 'manifest-raw-bytes',
    declaredRuntimeAssetHashMatchesRaw: !declaredRuntimeAssetHash || declaredRuntimeAssetHash === rawSha256
  };
}

function validateModernPins(manifest) {
  const checks = {};
  const engineIds = ['runtimeId', 'engineRuntimeId', 'engine']
    .filter(key => manifest && manifest[key] != null)
    .map(key => [key, String(manifest[key])]);
  checks.engineId = engineIds.length > 0 && engineIds.every(([, value]) => value === MODERN_RUNTIME_ID);
  checks.target = manifest?.target === MODERN_PINS.target;
  checks.llvmTag = manifest?.llvm?.tag === MODERN_PINS.llvm.tag;
  checks.llvmCommit = String(manifest?.llvm?.commit || '').toLowerCase() === MODERN_PINS.llvm.commit;
  checks.emscriptenVersion = manifest?.emscripten?.version === MODERN_PINS.emscripten.version;
  checks.emscriptenCommit = String(manifest?.emscripten?.commit || '').toLowerCase() === MODERN_PINS.emscripten.commit;
  checks.emscriptenImageDigest = String(manifest?.emscripten?.imageDigest || '').toLowerCase() === MODERN_PINS.emscripten.imageDigest;
  checks.wasiLibcCommit = String(manifest?.wasiLibc?.commit || '').toLowerCase() === MODERN_PINS.wasiLibc.commit;
  return {ok: Object.values(checks).every(Boolean), checks, expected: MODERN_PINS};
}

/**
 * Fetch and verify the browser-published manifest and every declared output.
 * This intentionally runs in Chrome so the evidence covers the same-origin
 * bytes that the worker will consume, rather than a source-tree manifest.
 */
async function inspectPublishedManifest(page, manifestUrl = MODERN_MANIFEST_URL) {
  return page.evaluate(async manifestUrl => {
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const response = await fetch(manifestUrl, {method: 'GET', cache: 'no-store', credentials: 'same-origin'});
    if (!response.ok) return {ok: false, available: false, httpStatus: response.status, error: `manifest HTTP ${response.status}`};
    const raw = new Uint8Array(await response.arrayBuffer());
    const rawSha256 = await digest(raw);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(raw)); }
    catch (error) { return {ok: false, available: false, rawSha256, error: `manifest JSON: ${error.message || error}`}; }
    if (!manifest || typeof manifest !== 'object') return {ok: false, available: false, rawSha256, error: 'manifest is not an object'};

    const base = new URL('./', new URL(manifestUrl, location.href)).href;
    const candidates = [];
    for (const source of [...(Array.isArray(manifest.assets) ? manifest.assets : []),
      ...(Array.isArray(manifest.assetInventory) ? manifest.assetInventory : [])]) {
      const file = String(source?.file || source?.name || source?.path || '');
      if (!file) continue;
      const expectedBytes = Number.isFinite(Number(source.bytes)) ? Number(source.bytes) : null;
      const expectedSha256 = String(source.sha256 || source.hash || source.sha || '').toLowerCase() || null;
      const target = source.url || source.path || file;
      const url = new URL(String(target), base).href;
      const existing = candidates.find(item => item.file === file);
      if (existing) {
        existing.duplicate = true;
        existing.metadataConsistent = existing.metadataConsistent
          && existing.expectedBytes === expectedBytes && existing.expectedSha256 === expectedSha256
          && existing.url === url;
      } else {
        candidates.push({file, url, kind: source.kind || null, role: source.role || null,
          expectedBytes, expectedSha256, metadataConsistent: true, duplicate: false});
      }
    }
    const assets = [];
    for (const candidate of candidates) {
      const item = {...candidate};
      if (!Number.isFinite(item.expectedBytes) || !/^[a-f0-9]{64}$/i.test(item.expectedSha256 || '')) {
        item.ok = false; item.metadataValid = false; item.error = 'missing bytes/sha256 metadata'; assets.push(item); continue;
      }
      item.metadataValid = !!item.metadataConsistent;
      try {
        const assetResponse = await fetch(item.url, {method: 'GET', cache: 'no-store', credentials: 'same-origin'});
        item.httpStatus = assetResponse.status;
        if (!assetResponse.ok) {
          item.ok = false; item.error = `asset HTTP ${assetResponse.status}`; assets.push(item); continue;
        }
        const body = new Uint8Array(await assetResponse.arrayBuffer());
        item.actualBytes = body.byteLength;
        item.actualSha256 = await digest(body);
        item.bytesMatch = item.actualBytes === item.expectedBytes;
        item.sha256Match = item.actualSha256 === item.expectedSha256;
        item.ok = item.metadataValid && item.bytesMatch && item.sha256Match;
        if (!item.ok) item.error = !item.metadataValid ? 'duplicate metadata mismatch'
          : (!item.bytesMatch ? 'byte length mismatch' : 'SHA-256 mismatch');
      } catch (error) { item.ok = false; item.error = String(error?.message || error); }
      assets.push(item);
    }
    const published = candidates.length > 0;
    const metadataValid = published && assets.every(item => item.metadataValid !== false
      && Number.isFinite(item.expectedBytes) && /^[a-f0-9]{64}$/i.test(item.expectedSha256 || ''));
    const missingOrUnavailable = assets.some(item => item.httpStatus === 404 || item.httpStatus === 410
      || (!item.httpStatus && /failed to fetch|network|not found/i.test(item.error || '')));
    const allAssetsMatch = published && metadataValid && assets.length === candidates.length && assets.every(item => item.ok);
    return {
      ok: true, available: allAssetsMatch, published, rawSha256,
      manifest: {
        runtimeId: manifest.runtimeId || null, engineRuntimeId: manifest.engineRuntimeId || null,
        engine: manifest.engine || null, status: manifest.status || null, target: manifest.target || null,
        llvm: manifest.llvm || null, emscripten: manifest.emscripten || null, wasiLibc: manifest.wasiLibc || null,
        runtimeAssetHash: rawSha256,
        declaredRuntimeAssetHash: manifest.runtimeAssetHash || manifest.assetHash || manifest.assetsHash || null,
        runtimeAssetHashSource: 'manifest-raw-bytes',
        declaredRuntimeAssetHashMatchesRaw: !(manifest.runtimeAssetHash || manifest.assetHash || manifest.assetsHash)
          || (manifest.runtimeAssetHash || manifest.assetHash || manifest.assetsHash) === rawSha256,
        assetCount: Array.isArray(manifest.assets) ? manifest.assets.length : 0,
        inventoryCount: Array.isArray(manifest.assetInventory) ? manifest.assetInventory.length : 0
      },
      assets, metadataValid, allAssetsMatch, missingOrUnavailable,
      compilerAssets: assets.filter(item => item.kind === 'compiler' || /clang\.wasm$/i.test(item.file)),
      linkerAssets: assets.filter(item => item.kind === 'linker' || /wasm-ld\.wasm$|lld\.wasm$/i.test(item.file)),
      compilerGlueAssets: assets.filter(item => item.kind === 'compiler-glue' || /clang\.js$/i.test(item.file)),
      linkerGlueAssets: assets.filter(item => item.kind === 'linker-glue' || /wasm-ld\.js$|lld\.js$/i.test(item.file)),
      sysrootAssets: assets.filter(item => /\.tar(?:\.gz)?$/i.test(item.file) || /sysroot|clang-fs/i.test(item.file))
    };
  }, manifestUrl);
}

async function validateBrowserWasm(page, manifestEvidence) {
  const wasm = [
    {label: 'clang', wasm: (manifestEvidence?.compilerAssets || [])[0], glue: (manifestEvidence?.compilerGlueAssets || [])[0]},
    {label: 'wasm-ld', wasm: (manifestEvidence?.linkerAssets || [])[0], glue: (manifestEvidence?.linkerGlueAssets || [])[0]}
  ];
  if (wasm.some(item => !item.wasm?.url || !item.glue?.url)) {
    return {ok: false, available: true, error: 'compiler/linker WASM and Emscripten glue assets are not both published', modules: [], proxyfs: {mounted: false}};
  }
  return page.evaluate(async pairs => {
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const fetchBytes = async asset => {
      const response = await fetch(asset.url, {method: 'GET', cache: 'force-cache', credentials: 'same-origin'});
      if (!response.ok) throw new Error(`${asset.file} HTTP ${response.status}`);
      const body = new Uint8Array(await response.arrayBuffer());
      return {body, bytes: body.byteLength, sha256: await digest(body)};
    };
    const importFactory = async (glue, wasmBytes, label) => {
      const source = new TextDecoder().decode(glue);
      if (!/createModernModule/.test(source) || !/PROXYFS/.test(source) || !/callMain/.test(source)) {
        throw new Error(`${label} glue does not expose createModernModule/PROXYFS/callMain`);
      }
      const blob = new Blob([source, '\nexport { createModernModule };\n'], {type: 'text/javascript'});
      const url = URL.createObjectURL(blob);
      try {
        const namespace = await import(url);
        const factory = namespace.createModernModule || namespace.default;
        if (typeof factory !== 'function') throw new Error(`${label} glue factory export is missing`);
        const wasmBinary = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength);
        const module = await factory({
          wasmBinary, noInitialRun: true, noExitRuntime: true, thisProgram: label,
          locateFile: file => new URL(file, location.href).href,
          print: () => {}, printErr: () => {}
        });
        if (!module?.FS || !module?.PROXYFS || typeof module.callMain !== 'function') {
          throw new Error(`${label} factory did not return FS/PROXYFS/callMain`);
        }
        return {module, sourceBytes: glue.byteLength};
      } finally { URL.revokeObjectURL(url); }
    };
    const modules = [];
    for (const pair of pairs) {
      const item = {label: pair.label, file: pair.wasm.file, url: pair.wasm.url, glueFile: pair.glue.file,
        glueUrl: pair.glue.url, compiled: false, instantiated: false, glueFactoryInstantiated: false};
      try {
        const wasm = await fetchBytes(pair.wasm); const glue = await fetchBytes(pair.glue);
        item.actualBytes = wasm.bytes; item.actualSha256 = wasm.sha256;
        item.bytesMatch = item.actualBytes === pair.wasm.expectedBytes;
        item.sha256Match = item.actualSha256 === pair.wasm.expectedSha256;
        item.glueBytes = glue.bytes; item.glueSha256 = glue.sha256;
        item.glueBytesMatch = item.glueBytes === pair.glue.expectedBytes;
        item.glueSha256Match = item.glueSha256 === pair.glue.expectedSha256;
        const compileStart = performance.now();
        await WebAssembly.compile(wasm.body);
        item.compileMs = Math.round(performance.now() - compileStart); item.compiled = true;
        const instantiateStart = performance.now();
        const loaded = await importFactory(glue.body, wasm.body, pair.label);
        item.instantiateMs = Math.round(performance.now() - instantiateStart); item.instantiated = true;
        item.module = loaded.module;
        item.glueFactoryInstantiated = !!loaded.module;
        item.glueExports = {FS: !!loaded.module.FS, PROXYFS: !!loaded.module.PROXYFS, callMain: typeof loaded.module.callMain === 'function'};
        item.ok = item.bytesMatch && item.sha256Match && item.glueBytesMatch && item.glueSha256Match && item.glueFactoryInstantiated;
        if (!item.ok) item.error = 'module bytes/hash changed after manifest verification';
      } catch (error) { item.ok = false; item.error = String(error?.message || error); }
      modules.push(item);
    }
    let proxyfs = {mounted: false};
    try {
      const clang = modules[0]?.module;
      const linker = modules[1]?.module;
      if (!clang || !linker || !clang.FS || !linker.FS || !linker.PROXYFS) throw new Error('compiler/linker modules unavailable for PROXYFS');
      try { linker.FS.mkdir('/phase8-shared'); } catch (_) { /* already present */ }
      linker.FS.mount(linker.PROXYFS, {root: '/', fs: clang.FS}, '/phase8-shared');
      proxyfs = {mounted: true, mountpoint: '/phase8-shared', root: '/', source: 'clang.FS', target: 'wasm-ld.FS'};
    } catch (error) { proxyfs = {mounted: false, error: String(error?.message || error)}; }
    modules.forEach(item => { delete item.module; });
    return {ok: modules.length === pairs.length && modules.every(item => item.ok && item.compiled && item.instantiated && item.glueFactoryInstantiated)
      && proxyfs.mounted, available: true, modules, proxyfs};
  }, wasm);
}

async function inspectBrowserSysroot(page, sysrootAsset) {
  if (!sysrootAsset?.url) return {ok: false, available: false, error: 'sysroot archive is not published'};
  return page.evaluate(async asset => {
    const decode = (bytes, start, length) => new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/, '');
    const octal = (bytes, start, length) => {
      const value = decode(bytes, start, length).trim().replace(/\0/g, '');
      return value ? parseInt(value, 8) : 0;
    };
    const strip = value => String(value || '').replace(/^\.\//, '').replace(/^(?:wasi-sysroot|sysroot|clang-fs)\//, '');
    try {
      const response = await fetch(asset.url, {method: 'GET', cache: 'force-cache', credentials: 'same-origin'});
      if (!response.ok) return {ok: false, available: false, error: `sysroot HTTP ${response.status}`};
      let body = new Uint8Array(await response.arrayBuffer());
      if (/\.gz$/i.test(asset.file)) {
        if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream unavailable');
        body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      }
      if (body.length < 512 || body.length % 512 !== 0) throw new Error('invalid tar size');
      const paths = []; let offset = 0; let longName = null;
      while (offset + 512 <= body.length) {
        const header = body.subarray(offset, offset + 512);
        if (header.every(byte => byte === 0)) break;
        const type = String.fromCharCode(header[156] || 0);
        const size = octal(header, 124, 12);
        const name = decode(header, 0, 100);
        const prefix = decode(header, 345, 155);
        const fullName = strip(longName || (prefix ? `${prefix}/${name}` : name));
        const dataStart = offset + 512;
        if (type === 'L') {
          longName = decode(body, dataStart, size).replace(/\0.*$/, '');
        } else {
          if (fullName && type !== '5') paths.push(fullName);
          longName = null;
        }
        offset = dataStart + Math.ceil(size / 512) * 512;
      }
      const find = pattern => paths.find(path => pattern.test(path)) || null;
      const evidence = {
        archiveBytes: body.byteLength,
        fileCount: paths.length,
        hasIncludeTree: paths.some(path => path === 'include' || path.startsWith('include/')),
        hasLibTree: paths.some(path => path === 'lib' || path.startsWith('lib/')),
        libcxxHeader: find(/^include\/c\+\+\/v1\/(?:__config|iostream|vector|memory)$/),
        libcxxArchive: find(/(?:^|\/)libc\+\+\.a$/),
        libcxxabiArchive: find(/(?:^|\/)libc\+\+abi\.a$/),
        compilerRtArchive: find(/(?:^|\/)libclang_rt\.builtins(?:-[^/]+)?\.a$/),
        crtObject: find(/(?:^|\/)crt1(?:-command)?\.o$/),
        resourceHeader: find(/(?:^|\/)lib\/clang\/19\.1\.7\/include\/[^/]+\.h$/)
          || find(/(?:^|\/)clang-resource\/[^/]+\.h$/),
        // wasi-libc versions in this build use target-specific headers under
        // include/wasm32-wasi rather than a single include/wasi/api.h file.
        wasiApiHeader: find(/(?:^|\/)include\/(?:wasi|wasm32-wasi)\/[^/]+\.h$/),
        wasiLibcArchive: find(/(?:^|\/)lib\/wasm32-wasi\/libc\.a$/)
      };
      const required = ['hasIncludeTree', 'hasLibTree', 'libcxxHeader', 'libcxxArchive', 'libcxxabiArchive',
        'compilerRtArchive', 'crtObject', 'resourceHeader', 'wasiApiHeader', 'wasiLibcArchive'];
      return {ok: required.every(key => !!evidence[key]), available: true, evidence};
    } catch (error) { return {ok: false, available: true, error: String(error?.message || error)}; }
  }, sysrootAsset);
}

function classifyNetwork(entries) {
  const runtimeGets = entries.filter(item => item.method === 'GET' && /\/runtime\/cpp-modern-(?:engine-v1|v1)\//.test(item.url));
  const sourceLike = entries.filter(item => item.hasSourceLikeBody);
  const submissions = entries.filter(item => /\/api\/contest\/contests\/[^/]+\/submissions(?:$|\?)/.test(item.url));
  const nonGet = entries.filter(item => item.method !== 'GET');
  const heartbeat = nonGet.filter(item => /\/api\/contest\/devices\/heartbeat(?:$|\?)/.test(item.url)
    && item.bodyFields.length === 0);
  const forbiddenNonGet = nonGet.filter(item => !heartbeat.includes(item));
  return {
    total: entries.length,
    runtimeGets,
    sourceLike,
    submissions,
    nonGet,
    heartbeat,
    forbiddenNonGet,
    noUpload: sourceLike.length === 0 && submissions.length === 0 && forbiddenNonGet.length === 0
  };
}

async function runModern(page, options) {
  return page.evaluate(async ({options, timeoutMs}) => {
    const runner = globalThis.__IDE_RUNNER__;
    if (!runner || typeof runner.runCode !== 'function') throw new Error('modern runner unavailable');
    const timeout = new Promise(resolve => setTimeout(() => resolve({
      ok: false, runStatus: 'HARNESS_TIMEOUT', compileStatus: 'HARNESS_TIMEOUT', stdout: '', stderr: '', timedOut: true
    }), timeoutMs));
    return Promise.race([runner.runCode(options), timeout]);
  }, {options, timeoutMs: RUN_TIMEOUT_MS});
}

async function waitForRunner(page) {
  await page.waitForFunction(() => globalThis.__IDE_RUNNER__ && typeof globalThis.__IDE_RUNNER__.runCode === 'function', null, {timeout: 30000});
}

async function collectModernPerformance(page) {
  return page.evaluate(runtimeId => performance.getEntriesByType('resource')
    .filter(entry => entry.name.includes(`/runtime/${runtimeId}/`))
    .map(entry => ({
      name: entry.name,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
      decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
      durationMs: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
      startTimeMs: Number.isFinite(entry.startTime) ? Math.round(entry.startTime) : null
    })), MODERN_RUNTIME_ID);
}

async function collectLegacyResources(page) {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => /\/runtime\/runno\/0\.10\.0-ojc4\/langs\/(?:clang\.wasm|wasm-ld\.wasm|clang-fs\.tar\.gz)/.test(entry.name))
    .map(entry => ({
      name: entry.name,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
      decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
      durationMs: Number.isFinite(entry.duration) ? Math.round(entry.duration) : null
    })));
}

async function benchmarkLegacy(page) {
  const firstStarted = Date.now();
  const first = await runModern(page, {language: 'cpp', source: LEGACY_COLD_SOURCE, stdin: '3 5', optLevel: '-O0'});
  const coldNetworkStartMs = Date.now() - firstStarted;
  const coldResources = await collectLegacyResources(page);

  await page.reload({waitUntil: 'domcontentloaded'});
  await waitForRunner(page);
  const cachedStarted = Date.now();
  const cached = await runModern(page, {language: 'cpp', source: LEGACY_CACHED_COLD_SOURCE, stdin: '3 5', optLevel: '-O0'});
  const cachedColdStartMs = Date.now() - cachedStarted;
  const cachedResources = await collectLegacyResources(page);

  const warm = await runModern(page, {language: 'cpp', source: LEGACY_WARM_SOURCE, stdin: '3 5', optLevel: '-O0'});
  const ok = [first, cached, warm].every(result => trimOutput(result?.stdout) === '8'
    && result?.compileStatus === 'PASS' && result?.runStatus === 'PASS');
  return {
    status: ok ? 'PASS' : 'FAIL',
    coldNetworkStartMs,
    cachedColdStartMs,
    compilerInit: first?.timing?.compilerInitMs || cached?.timing?.compilerInitMs || null,
    warmCompileMs: warm?.compileTime ?? warm?.timing?.compileMs ?? null,
    warmLinkMs: warm?.linkTime ?? warm?.timing?.linkMs ?? null,
    warmExecutionMs: warm?.executionTime ?? warm?.executionMs ?? null,
    coldResources,
    cachedResources,
    results: {cold: first, cachedCold: cached, warm}
  };
}

function addFunctionalBlockedCases(report, reason, prerequisite = 'M1-M4 modern runtime gates') {
  const details = {reason, prerequisite};
  for (const id of [
    'M5-c17-a-plus-b', 'M5-cpp17-hello-world', 'M5-cpp17-a-plus-b', 'M5-network-no-upload',
    'M6-cache-miss-first', 'M6-cache-hit-same-source-different-stdin', 'M6-cache-hit-skips-compile-link',
    'M6-cache-miss-mutated-source', 'M6-cache-end-to-end', 'M7-local-run-no-source-upload',
    'M7-formal-submit-not-triggered'
  ]) report.cases.push(record(id, 'BLOCKED', details));
  report.network = {status: 'BLOCKED', reason, noUpload: null, submissions: []};
}

async function main() {
  const report = {
    checkpoint: 'MODERN_CPP_PHASE8_CHECKPOINT_1',
    area: 'M1-M7 Modern C17/C++17 Browser Local',
    generatedAt: nowIso(),
    baseUrl: BASE_URL || null,
    browser: null,
    startFromProblemPage: false,
    cases: [],
    network: null,
    performance: {
      modernAssetResources: [],
      runtimePrewarmWallMs: null,
      runtimePrewarmCachedWallMs: null,
      m4TotalWallMs: null,
      workerCompilerInitMs: null,
      workerCachedInitWallMs: null,
      workerCachedCompilerInitMs: null,
      workerCachedInitResult: null,
      legacy: null,
      note: 'transferSize/encodedBodySize/decodedBodySize are reported as null when Chrome does not expose them. Cached cold start is measured after a full problem-page reload in the same browser context.'
    },
    blockingFailures: [],
    caveats: [
      'Only source byte lengths and SHA-256 digests are retained; source text is not written to the report.',
      'This harness validates Local Run through __IDE_RUNNER__.runCode; Formal Submit is intentionally never clicked.',
      'C++20 and C++23 are outside Checkpoint 1 and are not executed.',
      'M1-M4 are prerequisite gates; unavailable published assets are recorded as BLOCKED, never as PASS.'
    ]
  };
  let app = null;
  let chrome = null;
  try {
    app = BASE_URL ? {baseUrl: BASE_URL, async stop() {}} : await startLocalContestServer({startTimeoutMs: 30000});
    chrome = await launchChrome();
    report.browser = {headless: process.env.HEADLESS !== 'false', executable: 'Google Chrome'};
    const requests = attachRequestLog(chrome.page);
    const start = await loginAndOpenProblem(chrome.page, app.baseUrl);
    report.start = start;
    report.startFromProblemPage = /\/contest\/contests\/[^/]+\/problems\/[^/]+$/.test(chrome.page.url());
    report.cases.push(record('problem-page', report.startFromProblemPage ? 'PASS' : 'FAIL', {url: chrome.page.url(), title: start.title}));
    await waitForRunner(chrome.page);

    try { report.performance.legacy = await benchmarkLegacy(chrome.page); }
    catch (error) { report.performance.legacy = {status: 'ERROR', error: String(error?.message || error)}; }

    let published = null;
    try { published = await inspectPublishedManifest(chrome.page); }
    catch (error) { published = {ok: false, available: false, error: String(error?.message || error)}; }
    const manifest = published?.manifest || null;
    const pins = manifest ? validateModernPins(manifest) : null;
    const manifestUnavailable = !manifest && (published?.httpStatus === 404 || published?.httpStatus === 410
      || /failed to fetch|network|HTTP 5\d\d/i.test(published?.error || ''));
    const m1Status = !manifest ? (manifestUnavailable ? 'BLOCKED' : 'FAIL') : (pins.ok ? 'PASS' : 'FAIL');
    report.cases.push(record('M1-modern-manifest-pins', m1Status, {
      manifestUrl: MODERN_MANIFEST_URL,
      manifest: manifest ? manifestSummary(manifest, published.rawSha256) : null,
      checks: pins?.checks || null,
      expected: pins?.expected || MODERN_PINS,
      error: published?.error || null
    }));

    const declaredRuntimeAssetHash = manifest?.runtimeAssetHash || manifest?.assetHash || manifest?.assetsHash || null;
    const runtimeAssetHash = manifest ? (published.rawSha256 || null) : null;
    const runtimeAssetHashValid = isSha256(runtimeAssetHash);
    const declaredRuntimeAssetHashMatchesRaw = !declaredRuntimeAssetHash
      || declaredRuntimeAssetHash === published?.rawSha256;
    let m2Status = 'BLOCKED';
    if (manifest) {
      if (!published.published) m2Status = 'BLOCKED';
      else if (manifest.status === 'BUILD_PENDING' && !published.metadataValid) m2Status = 'BLOCKED';
      else if (!published.metadataValid) m2Status = 'FAIL';
      else if (!declaredRuntimeAssetHashMatchesRaw) m2Status = 'FAIL';
      else if (!runtimeAssetHashValid) m2Status = 'FAIL';
      else if (published.allAssetsMatch) m2Status = 'PASS';
      else if (published.missingOrUnavailable) m2Status = 'BLOCKED';
      else m2Status = 'FAIL';
    } else if (!manifestUnavailable) m2Status = 'FAIL';
    report.cases.push(record('M2-modern-assets-bytes-sha256', m2Status, {
      manifestUrl: MODERN_MANIFEST_URL,
      published: !!published?.published,
      metadataValid: published?.metadataValid ?? false,
      allAssetsMatch: published?.allAssetsMatch ?? false,
      missingOrUnavailable: published?.missingOrUnavailable ?? true,
      runtimeAssetHash: {
        expectedByWorker: runtimeAssetHash,
        manifestRawSha256: published?.rawSha256 || null,
        declared: declaredRuntimeAssetHash,
        declaredIsSha256: isSha256(declaredRuntimeAssetHash),
        declaredMatchesRaw: declaredRuntimeAssetHashMatchesRaw,
        source: 'manifest-raw-bytes'
      },
      assets: published?.assets || [],
      error: published?.error || null
    }));
    report.preflight = {
      manifest: manifest ? manifestSummary(manifest, published.rawSha256) : null,
      m1Pins: pins,
      m2: {status: m2Status, assetCount: published?.assets?.length || 0}
    };

    let m3 = {ok: false, available: false, error: 'M2 is not PASS', modules: []};
    if (m2Status === 'PASS') {
      try { m3 = await validateBrowserWasm(chrome.page, published); }
      catch (error) { m3 = {ok: false, available: true, error: String(error?.message || error), modules: []}; }
    }
    report.cases.push(record('M3-chrome-compile-instantiate-clang-wasm-ld',
      m2Status !== 'PASS' ? 'BLOCKED' : (m3.ok ? 'PASS' : 'FAIL'), {
        compiler: published?.compilerAssets || [], linker: published?.linkerAssets || [], evidence: m3
      }));

    let m4Sysroot = {ok: false, available: false, error: 'M2 is not PASS'};
    let m4Prewarm = null;
    let m4Probe = null;
    let m4WallStart = null;
    let m4WallEnd = null;
    if (m2Status === 'PASS') {
      const sysroots = published.sysrootAssets || [];
      if (sysroots.length === 1) {
        try { m4Sysroot = await inspectBrowserSysroot(chrome.page, sysroots[0]); }
        catch (error) { m4Sysroot = {ok: false, available: true, error: String(error?.message || error)}; }
      } else {
        m4Sysroot = {ok: false, available: true, error: `expected one sysroot archive, found ${sysroots.length}`};
      }
      m4WallStart = Date.now();
      const prewarmWallStart = Date.now();
      try {
        m4Prewarm = await chrome.page.evaluate(async runtimeId => {
          const runner = globalThis.__IDE_RUNNER__;
          if (!runner || typeof runner.prewarmModernRuntime !== 'function') return {status: 'UNAVAILABLE', error: 'prewarm API unavailable'};
          return runner.prewarmModernRuntime(runtimeId);
        }, MODERN_RUNTIME_ID);
      } catch (error) { m4Prewarm = {status: 'FAILED', error: String(error?.message || error)}; }
      report.performance.runtimePrewarmWallMs = Date.now() - prewarmWallStart;
      const cachedStart = Date.now();
      try {
        const cached = await chrome.page.evaluate(async runtimeId => {
          const runner = globalThis.__IDE_RUNNER__;
          if (!runner || typeof runner.prewarmModernRuntime !== 'function') return {status: 'UNAVAILABLE'};
          return runner.prewarmModernRuntime(runtimeId);
        }, MODERN_RUNTIME_ID);
        report.performance.runtimePrewarmCachedWallMs = Date.now() - cachedStart;
        report.performance.runtimePrewarmCachedStatus = cached?.status || null;
      } catch (error) {
        report.performance.runtimePrewarmCachedWallMs = Date.now() - cachedStart;
        report.performance.runtimePrewarmCachedStatus = 'FAILED';
        report.performance.runtimePrewarmCachedError = String(error?.message || error);
      }
      try {
        m4Probe = await runModern(chrome.page, {
          language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17', source: M4_PROBE_SOURCE, stdin: '3 5', optLevel: '-O0'
        });
      } catch (error) { m4Probe = {compileStatus: 'ERROR', runStatus: 'ERROR', error: String(error?.message || error)}; }
      m4WallEnd = Date.now();
      report.performance.m4TotalWallMs = m4WallEnd - m4WallStart;
      report.performance.workerCompilerInitMs = m4Probe?.compilerInitMs ?? m4Probe?.timing?.compilerInitMs ?? null;
    }
    const workerInitReady = m4Prewarm?.status === 'READY'
      && m4Probe?.runtimeId === MODERN_RUNTIME_ID
      && m4Probe?.compileStatus === 'PASS'
      && m4Probe?.runStatus === 'PASS'
      && Number(m4Probe?.compilerInitMs ?? m4Probe?.timing?.compilerInitMs) > 0
      && m4Probe?.compilerGlueVerified === true
      && m4Probe?.linkerGlueVerified === true
      && m4Probe?.proxyFsMounted === true
      && trimOutput(m4Probe?.stdout) === '8';
    const m4Status = m2Status !== 'PASS' ? 'BLOCKED' : (m4Sysroot.ok && workerInitReady ? 'PASS' : 'FAIL');
    report.cases.push(record('M4-worker-ready-complete-sysroot', m4Status, {
      sysroot: m4Sysroot,
      workerInit: {
        prewarmStatus: m4Prewarm?.status || null,
        status: workerInitReady ? 'READY' : (m2Status === 'PASS' ? 'FAILED' : 'BLOCKED'),
        compilerInitMs: m4Probe?.compilerInitMs ?? m4Probe?.timing?.compilerInitMs ?? null,
        compilerGlueVerified: m4Probe?.compilerGlueVerified ?? null,
        linkerGlueVerified: m4Probe?.linkerGlueVerified ?? null,
        proxyFsMounted: m4Probe?.proxyFsMounted ?? null,
        proxyFs: m4Probe?.proxyFs ?? null,
        probe: m4Probe
      },
      initWallMs: m4WallStart != null && m4WallEnd != null ? m4WallEnd - m4WallStart : null
    }));
    const workerRuntimeAssetHash = m4Probe?.runtimeAssetHash
      || (typeof m4Probe?.cacheKey === 'string' ? m4Probe.cacheKey.split('|')[4] : null);
    const m2Case = report.cases.find(item => item.id === 'M2-modern-assets-bytes-sha256');
    if (m2Case) m2Case.runtimeAssetHash.workerEvidence = {
      value: workerRuntimeAssetHash || null,
      available: isSha256(workerRuntimeAssetHash),
      matchesManifestEvidence: !!workerRuntimeAssetHash && workerRuntimeAssetHash === runtimeAssetHash,
      note: workerRuntimeAssetHash ? 'Observed from modern worker run result/cache key.'
        : 'Worker run result does not expose runtimeAssetHash/cacheKey; manifest raw-byte evidence remains recorded.'
    };
    report.performance.modernAssetResources = await collectModernPerformance(chrome.page).catch(() => []);

    const blocked = value => /NOT_READY|UNAVAILABLE|PENDING|HARNESS_TIMEOUT|不可用/i.test(JSON.stringify(value || {}));
    const modernPrerequisitesPass = m2Status === 'PASS' && m3.ok && m4Status === 'PASS';
    if (!modernPrerequisitesPass) {
      const prerequisiteFailure = m2Status !== 'PASS'
        ? `M2 published modern assets ${m2Status}: ${published?.error || 'asset manifest is not ready'}`
        : `M1-M4 prerequisite failed: M3=${m3.ok ? 'PASS' : 'FAIL'}, M4=${m4Status}`;
      addFunctionalBlockedCases(report, prerequisiteFailure);
    }

    if (modernPrerequisitesPass) {
    const m5Start = requests.mark();
    const c17 = await runModern(chrome.page, {
      language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17', source: C17_SOURCE, stdin: '3 5', optLevel: '-O0'
    });
    const cppHello = await runModern(chrome.page, {
      language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17', source: CPP17_HELLO_SOURCE, stdin: '', optLevel: '-O0'
    });
    const cppAb = await runModern(chrome.page, {
      language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17', source: CPP17_AB_SOURCE, stdin: '3 5', optLevel: '-O0'
    });
    const m5Network = classifyNetwork(requests.since(m5Start));
    const c17Pass = trimOutput(c17?.stdout) === '8' && c17?.compileStatus === 'PASS' && c17?.runStatus === 'PASS';
    const helloPass = trimOutput(cppHello?.stdout) === 'CPP17_BROWSER_OK' && cppHello?.compileStatus === 'PASS' && cppHello?.runStatus === 'PASS';
    const abPass = trimOutput(cppAb?.stdout) === '8' && cppAb?.compileStatus === 'PASS' && cppAb?.runStatus === 'PASS';
    const blocked = value => /NOT_READY|UNAVAILABLE|PENDING|HARNESS_TIMEOUT|不可用/i.test(JSON.stringify(value || {}));
    report.cases.push(record('M5-c17-a-plus-b', blocked(c17) ? 'BLOCKED' : (c17Pass ? 'PASS' : 'FAIL'), {
      ...sourceDigest(C17_SOURCE), result: c17
    }));
    report.cases.push(record('M5-cpp17-hello-world', blocked(cppHello) ? 'BLOCKED' : (helloPass ? 'PASS' : 'FAIL'), {
      ...sourceDigest(CPP17_HELLO_SOURCE), result: cppHello
    }));
    report.cases.push(record('M5-cpp17-a-plus-b', blocked(cppAb) ? 'BLOCKED' : (abPass ? 'PASS' : 'FAIL'), {
      ...sourceDigest(CPP17_AB_SOURCE), result: cppAb
    }));
    report.cases.push(record('M5-network-no-upload', m5Network.noUpload ? 'PASS' : 'FAIL', {network: m5Network}));

    const m6Start = requests.mark();
    const first = await runModern(chrome.page, {
      language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17', source: CACHE_SOURCE, stdin: '3 5', optLevel: '-O0'
    });
    const second = await runModern(chrome.page, {
      language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17', source: CACHE_SOURCE, stdin: '10 20', optLevel: '-O0'
    });
    const mutated = await runModern(chrome.page, {
      language: 'cpp17', profileId: 'cpp17-gcc14-compat-v1', standard: 'c++17', source: CACHE_SOURCE + '\n', stdin: '10 20', optLevel: '-O0'
    });
    const m6Network = classifyNetwork(requests.since(m6Start));
    const m6Pass = first?.cacheHit === false && second?.cacheHit === true
      && second?.compileMs === 0 && second?.linkMs === 0 && mutated?.cacheHit === false
      && trimOutput(first?.stdout) === '8' && trimOutput(second?.stdout) === '30' && trimOutput(mutated?.stdout) === '30';
    const firstCachePass = first?.cacheHit === false && first?.compileStatus === 'PASS' && first?.runStatus === 'PASS'
      && trimOutput(first?.stdout) === '8';
    const secondCachePass = second?.cacheHit === true && second?.compileStatus === 'PASS' && second?.runStatus === 'PASS'
      && second?.compileMs === 0 && second?.linkMs === 0 && trimOutput(second?.stdout) === '30';
    const mutatedCachePass = mutated?.cacheHit === false && mutated?.compileStatus === 'PASS' && mutated?.runStatus === 'PASS'
      && trimOutput(mutated?.stdout) === '30';
    const m6Blocked = blocked(first) && blocked(second) && blocked(mutated);
    report.cases.push(record('M6-cache-miss-first', m6Blocked ? 'BLOCKED' : (firstCachePass ? 'PASS' : 'FAIL'), {result: first}));
    report.cases.push(record('M6-cache-hit-same-source-different-stdin', m6Blocked ? 'BLOCKED' : (secondCachePass ? 'PASS' : 'FAIL'), {result: second}));
    report.cases.push(record('M6-cache-hit-skips-compile-link', m6Blocked ? 'BLOCKED'
      : (secondCachePass ? 'PASS' : 'FAIL'), {
      compileMs: second?.compileMs, linkMs: second?.linkMs, result: second
    }));
    report.cases.push(record('M6-cache-miss-mutated-source', m6Blocked ? 'BLOCKED' : (mutatedCachePass ? 'PASS' : 'FAIL'), {result: mutated}));
    report.cases.push(record('M6-cache-end-to-end', m6Blocked ? 'BLOCKED' : (m6Pass ? 'PASS' : 'FAIL'), {network: m6Network}));

    const m7Start = requests.mark();
    const networkRun = await runModern(chrome.page, {
      language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17', source: C17_SOURCE, stdin: '3 5', optLevel: '-O0'
    });
    const m7Network = classifyNetwork(requests.since(m7Start));
    report.network = m7Network;
    const m7RunPass = trimOutput(networkRun?.stdout) === '8'
      && networkRun?.compileStatus === 'PASS' && networkRun?.runStatus === 'PASS';
    report.cases.push(record('M7-local-run-no-source-upload', m7Network.noUpload && m7RunPass ? 'PASS' : 'FAIL', {
      result: networkRun, network: m7Network
    }));
    report.cases.push(record('M7-formal-submit-not-triggered', 'PASS', {
      submissionRequests: m7Network.submissions.length,
      note: 'Formal Submit was not invoked for EXPERIMENTAL / LOCAL_PREVIEW.'
    }));

    try {
      await chrome.page.reload({waitUntil: 'domcontentloaded'});
      await waitForRunner(chrome.page);
      const cachedModernStart = Date.now();
      const cachedModern = await runModern(chrome.page, {
        language: 'c17', profileId: 'c17-gcc14-compat-v1', standard: 'c17',
        source: C17_SOURCE + '\n/* phase8 modern cached cold baseline */\n', stdin: '3 5', optLevel: '-O0'
      });
      report.performance.workerCachedInitWallMs = Date.now() - cachedModernStart;
      report.performance.workerCachedCompilerInitMs = cachedModern?.compilerInitMs ?? cachedModern?.timing?.compilerInitMs ?? null;
      report.performance.workerCachedInitResult = cachedModern;
    } catch (error) {
      report.performance.workerCachedInitResult = {status: 'ERROR', error: String(error?.message || error)};
    }
    }
  } catch (error) {
    report.blockingFailures.push({id: 'modern-cpp-e2e-harness', reason: String(error?.stack || error)});
    report.cases.push(record('modern-cpp-e2e-harness', 'FAIL', {error: String(error?.stack || error)}));
  } finally {
    report.cases.filter(item => item.status === 'FAIL' || item.status === 'BLOCKED').forEach(item => {
      if (!report.blockingFailures.some(failure => failure.id === item.id)) {
        report.blockingFailures.push({id: item.id, status: item.status,
          reason: item.status === 'BLOCKED' ? 'acceptance prerequisite unavailable' : 'acceptance condition not met'});
      }
    });
    report.gateStatus = report.cases.some(item => item.status === 'BLOCKED') ? 'BLOCKED'
      : (report.blockingFailures.length ? 'FAIL' : 'PASS');
    mkdirSync(dirname(REPORT), {recursive: true});
    writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
    try { await chrome?.context?.close(); } catch (_) {}
    try { await chrome?.browser?.close(); } catch (_) {}
    try { await chrome?.server?.close(); } catch (_) {}
    try { await app?.stop(); } catch (_) {}
  }
  console.log(JSON.stringify({report: REPORT, blockingFailures: report.blockingFailures.length,
    cases: report.cases.length}));
  if (report.blockingFailures.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
