/*
 * Modern C/C++ Browser Compiler Worker (Phase 8, Checkpoint 2).
 *
 * This worker is deliberately separate from ide-wasi-worker.js.  The latter is
 * the frozen Clang 8/C11/C++11 path; this file only accepts C17 and C++17 and
 * loads the self-hosted cpp-modern-engine-v1 assets.
 *
 * Protocol:
 *   init    -> inited
 *   compile -> compile-result (object bytes are returned on a cache miss)
 *   stats   -> stats
 *   dispose -> disposed
 *
 * Network access is limited to same-origin GETs named by the runtime manifest.
 * There is no CDN, native-toolchain, or server-run fallback.  READY is emitted
 * only after asset validation, sysroot mounting, WebAssembly.Module compilation,
 * and import validation for both clang and wasm-ld succeed.
 */
import {WASI} from '/runtime/runno/0.10.0-ojc4/runno-wasi.js';

const ENGINE_RUNTIME_ID = 'cpp-modern-engine-v2';
const DEFAULT_MANIFEST_URL = '/runtime/cpp-modern-engine-v2/runtime-manifest.json';
const TARGET = 'wasm32-unknown-wasi';
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const ARTIFACT_CACHE_CAPACITY = 8;

const STATE = Object.freeze({
  NOT_LOADED: 'NOT_LOADED', CHECK_CACHE: 'CHECK_CACHE', DOWNLOAD_RUNTIME: 'DOWNLOAD_RUNTIME',
  INITIALIZE_WASM: 'INITIALIZE_WASM', MOUNT_VFS: 'MOUNT_VFS', WARMUP_COMPILER: 'WARMUP_COMPILER',
  READY: 'READY', COMPILING: 'COMPILING', LINKING: 'LINKING', RUNNING: 'RUNNING',
  FAILED: 'FAILED', DISPOSED: 'DISPOSED'
});

let workerState = STATE.NOT_LOADED;
let runtime = null;
let initPromise = null;
let requestSequence = 0;
const artifactCache = new Map();
const counters = {
  initCount: 0, compileCount: 0, linkCount: 0, runCount: 0,
  cacheHits: 0, cacheMisses: 0, bytesCompiled: 0, bytesExecuted: 0
};

function post(message, transfer) { self.postMessage(message, transfer || []); }
function setState(next, extra) {
  workerState = next;
  post(Object.assign({type: 'state', state: next, runtimeId: ENGINE_RUNTIME_ID}, extra || {}));
}
function progress(stage, extra) {
  post(Object.assign({type: 'progress', runtimeId: ENGINE_RUNTIME_ID, stage, state: workerState}, extra || {}));
}
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}
function errorMessage(error) { return String(error && error.message || error || 'unknown error'); }
function pendingValue(value) { return value == null || value === '' || /^PENDING(?:_|$)/i.test(String(value)); }
function asHex(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}
async function sha256Hex(body) {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
}
function originUrl(value, base) {
  const baseUrl = base || (typeof location !== 'undefined' ? location.href : 'http://localhost/');
  const url = new URL(value, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new Error('cross-origin modern runtime asset rejected: ' + url.href);
  return url;
}
function manifestBase(manifestUrl) { return new URL('./', manifestUrl).href; }

function normaliseProfile(input) {
  const value = String(input || '').toLowerCase();
  if (value === 'c' || value === 'c17' || value === 'c17-gcc14-compat-v1' || value === 'c17-gcc14-compat-v2') {
    return {profileId: 'c17-gcc14-compat-v2', standard: 'c17', language: 'c'};
  }
  if (value === 'cpp' || value === 'c++' || value === 'cpp17' || value === 'c++17'
      || value === 'cpp17-gcc14-compat-v1' || value === 'cpp17-gcc14-compat-v2') {
    return {profileId: 'cpp17-gcc14-compat-v2', standard: 'c++17', language: 'cpp'};
  }
  if (value === 'cpp20' || value === 'c++20' || value === 'cpp23' || value === 'c++23'
      || value === 'cpp20-gcc14-compat-v1' || value === 'cpp23-gcc14-compat-v1') {
    return {unsupported: true, profileId: value, standard: value, language: 'cpp'};
  }
  return {profileId: value || 'cpp17-gcc14-compat-v2', standard: 'c++17', language: 'cpp'};
}
function sourceOf(message) { return String(message.source != null ? message.source : (message.code != null ? message.code : '')); }
function flagsOf(message) {
  if (Array.isArray(message.flags)) return message.flags.map(String);
  if (typeof message.flags === 'string') return message.flags.trim() ? message.flags.trim().split(/\s+/) : [];
  return [];
}
function canonicalFlags(flags) { return flags.map(String).join(' '); }
function optLevelOf(message) {
  const value = String(message && message.optLevel || '');
  return /^-O[0-2s]$/.test(value) ? value : '-O2';
}
function makeCacheKey(profileId, standard, flags, runtimeAssetHash, sourceHash) {
  // stdin intentionally does not participate in the artifact key.
  return [ENGINE_RUNTIME_ID, profileId, standard, flags, runtimeAssetHash, sourceHash].join('|');
}
function cachePut(key, entry) {
  if (artifactCache.has(key)) artifactCache.delete(key);
  artifactCache.set(key, entry);
  while (artifactCache.size > ARTIFACT_CACHE_CAPACITY) artifactCache.delete(artifactCache.keys().next().value);
}
function cacheGet(key) {
  const entry = artifactCache.get(key);
  if (!entry) return null;
  artifactCache.delete(key); artifactCache.set(key, entry); return entry;
}
function appendCapped(buffer, value) {
  const text = String(value == null ? '' : value);
  const room = MAX_OUTPUT_CHARS - buffer.text.length;
  if (room <= 0) { buffer.truncated = true; return; }
  buffer.text += text.slice(0, room);
  if (text.length > room) buffer.truncated = true;
}
function fileEntry(path, content, mode) {
  const fileMode = mode || 'binary';
  const stored = fileMode === 'string'
    ? String(content == null ? '' : content)
    : (content instanceof Uint8Array ? content : new TextEncoder().encode(String(content)));
  const timestamp = new Date();
  return {path, mode: fileMode, content: stored,
    timestamps: {access: timestamp, modification: timestamp, change: timestamp}};
}
function cloneFs(fs) { return Object.assign({}, fs || {}); }

function readTarString(bytes, offset, length) {
  let end = offset; const limit = Math.min(bytes.length, offset + length);
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end)).replace(/\0+$/, '');
}
function parseOctal(bytes, offset, length) {
  const text = readTarString(bytes, offset, length).trim();
  if (!text) return 0; const value = parseInt(text.replace(/[^0-7]/g, ''), 8);
  return Number.isFinite(value) ? value : 0;
}
async function unpackSysroot(bytes) {
  let body = bytes;
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) {
    if (typeof DecompressionStream !== 'function') throw new Error('gzip sysroot requires browser DecompressionStream');
    const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'));
    body = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (body.length < 512 || body.length % 512 !== 0) throw new Error('sysroot archive is not a complete tar stream');
  const fs = {}; let offset = 0; let longName = null;
  while (offset + 512 <= body.length) {
    const header = body.subarray(offset, offset + 512); let empty = true;
    for (const byte of header) { if (byte !== 0) { empty = false; break; } }
    if (empty) break;
    const name = readTarString(body, offset, 100);
    const prefix = readTarString(body, offset + 345, 155);
    const type = body[offset + 156] || 0; const size = parseOctal(body, offset + 124, 12);
    const dataStart = offset + 512; const dataEnd = dataStart + size;
    if (dataEnd > body.length) throw new Error('sysroot tar entry exceeds archive length');
    const pathName = longName || (prefix ? prefix + '/' + name : name);
    if (type === 5) {
      if (pathName) {
        const path = pathName.replace(/^\.\//, '').replace(/\\/g, '/');
        const mounted = '/' + path.replace(/^\/+/, '');
        fs[mounted] = {path: mounted, directory: true};
      }
      longName = null;
    } else if (type === 0 || type === 48) {
      if (pathName) {
        const path = pathName.replace(/^\.\//, '').replace(/\\/g, '/');
        const mounted = '/' + path.replace(/^\/+/, '');
        fs[mounted] = fileEntry(mounted, body.slice(dataStart, dataEnd));
      }
      longName = null;
    } else if (type === 76 || type === 75) {
      longName = new TextDecoder().decode(body.subarray(dataStart, dataEnd)).replace(/\0+$/, '');
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!Object.keys(fs).length) throw new Error('sysroot archive contains no files');
  return fs;
}
function hasPrefix(fs, prefix) { return Object.keys(fs).some(path => path === prefix || path.startsWith(prefix + '/')); }
function mountSysroot(fs) {
  if (!Object.keys(fs).length || hasPrefix(fs, '/sys')) return fs;
  const mounted = {};
  for (const [path, entry] of Object.entries(fs)) {
    let relative = path.replace(/^\/+/, '');
    // wasi-sdk archives commonly carry one directory around the actual
    // sysroot.  The compiler contract is always /sys/{include,lib,...}.
    relative = relative.replace(/^(?:wasi-sysroot|sysroot|clang-fs)\//, '');
    const mount = '/sys/' + relative;
    mounted[mount] = Object.assign({}, entry, {path: mount});
  }
  return mounted;
}

function ensureEmscriptenDirectory(module, path) {
  const fs = module && module.FS;
  if (!fs) throw new Error('Emscripten FS is unavailable');
  const clean = String(path || '/').replace(/\\+/g, '/').replace(/\/$/, '') || '/';
  if (clean === '/') return;
  const parts = clean.split('/').filter(Boolean); let current = '';
  for (const part of parts) {
    current += '/' + part;
    try { fs.mkdir(current); } catch (error) {
      try { fs.stat(current); } catch (_) { throw error; }
    }
  }
}

function writeSysrootToEmscripten(module, fsEntries) {
  if (!module || !module.FS) throw new Error('Emscripten FS is unavailable');
  const entries = Object.entries(fsEntries || {}).sort(([a], [b]) => a.length - b.length || a.localeCompare(b));
  for (const [path, entry] of entries) {
    if (!path || path === '/') continue;
    const clean = '/' + path.replace(/^\/+/, '').replace(/\\/g, '/');
    const slash = clean.lastIndexOf('/');
    ensureEmscriptenDirectory(module, slash > 0 ? clean.slice(0, slash) : '/');
    if (entry && entry.directory) {
      ensureEmscriptenDirectory(module, clean);
      continue;
    }
    const content = entry && entry.content instanceof Uint8Array ? entry.content : new Uint8Array(0);
    try { module.FS.writeFile(clean, content, {encoding: 'binary'}); }
    catch (error) { throw new Error('cannot write sysroot file ' + clean + ': ' + errorMessage(error)); }
  }
}

function writeEmscriptenFile(module, path, content) {
  const clean = '/' + String(path || '').replace(/^\/+/, '');
  const slash = clean.lastIndexOf('/');
  ensureEmscriptenDirectory(module, slash > 0 ? clean.slice(0, slash) : '/');
  const bytes = content instanceof Uint8Array ? content : new TextEncoder().encode(String(content == null ? '' : content));
  module.FS.writeFile(clean, bytes, {encoding: 'binary'});
}

function removeEmscriptenFile(module, path) {
  try { module.FS.unlink(path); } catch (_) { /* missing output is expected on a fresh compile */ }
}

function moduleReadFile(module, path) {
  const bytes = module.FS.readFile(path, {encoding: 'binary'});
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function mountProxyFs(clangModule, linkerModule) {
  if (!clangModule || !linkerModule || !clangModule.FS || !linkerModule.FS || !linkerModule.PROXYFS) {
    throw new Error('Emscripten FS/PROXYFS export is unavailable');
  }
  const mountpoint = '/shared';
  ensureEmscriptenDirectory(linkerModule, mountpoint);
  linkerModule.FS.mount(linkerModule.PROXYFS, {root: '/', fs: clangModule.FS}, mountpoint);
  return {mountpoint, root: '/', source: 'clang.FS', target: 'wasm-ld.FS', mounted: true};
}

function glueFactoryFromSource(source, label) {
  if (typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw manifestFailure('llvm-build', label + ' Emscripten glue requires Blob URL module loading');
  }
  if (!/createModernModule/.test(source) || !/PROXYFS/.test(source) || !/callMain/.test(source)) {
    throw manifestFailure('llvm-build', label + ' glue does not expose createModernModule/PROXYFS/callMain');
  }
  const blob = new Blob([source, '\nexport { createModernModule };\n'], {type: 'text/javascript'});
  const url = URL.createObjectURL(blob);
  return import(url).then(namespace => {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    const factory = namespace.createModernModule || namespace.default;
    if (typeof factory !== 'function') throw manifestFailure('llvm-build', label + ' glue factory export is missing');
    return factory;
  }, error => {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    throw manifestFailure('llvm-build', label + ' glue module evaluation failed: ' + errorMessage(error));
  });
}

async function instantiateEmscriptenModule(glueAsset, wasmAsset, label, baseUrl) {
  const source = new TextDecoder().decode(glueAsset.bytes);
  let factory;
  try { factory = await glueFactoryFromSource(source, label); }
  catch (error) { if (error.failureLayer) throw error; throw manifestFailure('llvm-build', label + ' glue load failed: ' + errorMessage(error)); }
  const output = {stdout: null, stderr: null};
  try {
    const wasmBuffer = wasmAsset.bytes.buffer.slice(wasmAsset.bytes.byteOffset,
      wasmAsset.bytes.byteOffset + wasmAsset.bytes.byteLength);
    const module = await factory({
      wasmBinary: wasmBuffer, noInitialRun: true, noExitRuntime: true, thisProgram: label,
      locateFile: file => new URL(file, baseUrl).href,
      print: value => { if (output.stdout) appendCapped(output.stdout, value); },
      printErr: value => { if (output.stderr) appendCapped(output.stderr, value); }
    });
    if (!module || !module.FS || !module.PROXYFS || typeof module.callMain !== 'function') {
      throw new Error('factory did not return FS, PROXYFS and callMain');
    }
    return {module, output, label, factoryVerified: true};
  } catch (error) {
    throw manifestFailure('instantiate', label + ' Emscripten module instantiate failed: ' + errorMessage(error));
  }
}

function runEmscriptenCommand(handle, args, programName) {
  const stdout = {text: '', truncated: false}; const stderr = {text: '', truncated: false};
  handle.output.stdout = stdout; handle.output.stderr = stderr;
  const command = Array.isArray(args) ? args.slice() : [];
  if (command.length && command[0] === programName) command.shift();
  const started = now(); let exitCode = -1; let error = null;
  try {
    const result = handle.module.callMain(command);
    exitCode = Number.isFinite(Number(result)) ? Number(result) : 0;
  } catch (caught) { error = caught; }
  handle.output.stdout = null; handle.output.stderr = null;
  return {ok: !error && exitCode === 0, exitCode, stdout: stdout.text, stderr: stderr.text,
    outputTruncated: stdout.truncated || stderr.truncated, error, runMs: now() - started};
}

function assetKind(asset) {
  const text = [asset.kind, asset.role, asset.type, asset.file, asset.path, asset.name].filter(Boolean).join(' ').toLowerCase();
  if (/sysroot|sys-root|clang-fs|\.tar(?:\.gz)?$/.test(text)) return 'sysroot';
  if (/clang\.js|compiler-glue|emscripten-worker-glue/.test(text)) return 'compiler-glue';
  if (/wasm-ld\.js|lld\.js|linker-glue/.test(text)) return 'linker-glue';
  if (/wasm-ld|lld|linker/.test(text)) return 'linker';
  if (/compiler-rt|builtins/.test(text)) return 'compiler-rt';
  if (/libc\+\+abi|libcxxabi/.test(text)) return 'libcxxabi';
  if (/libc\+\+|libcxx/.test(text)) return 'libcxx';
  if (/loader/.test(text)) return 'loader';
  if (/header-shim|bits\/stdc\+\+\.h/.test(text)) return 'header-shim';
  if (/clang\.wasm|compiler|clang/.test(text)) return 'compiler';
  return 'other';
}
function normaliseAssets(manifest, manifestUrl) {
  const input = Array.isArray(manifest.assets) ? manifest.assets : [];
  const base = manifestBase(manifestUrl);
  return input.map((asset, index) => {
    const source = asset || {}; const file = source.file || source.name || source.path || ('asset-' + index);
    const urlValue = source.url || (String(file).startsWith('/') ? file : new URL(String(file), base).href);
    return {...source, file: String(file), url: originUrl(urlValue, manifestUrl).href, kind: assetKind(source),
      bytes: Number.isFinite(Number(source.bytes)) ? Number(source.bytes) : null,
      sha256: asHex(source.sha256 || source.hash || source.sha),
      expectedHash: source.sha256 || source.hash || source.sha || null,
      mountPath: source.mountPath || source.mount || null};
  });
}
function pickAsset(assets, kinds, patterns) {
  for (const kind of kinds) { const found = assets.find(asset => asset.kind === kind); if (found) return found; }
  for (const pattern of patterns) {
    const found = assets.find(asset => pattern.test((asset.file + ' ' + asset.url).toLowerCase()));
    if (found) return found;
  }
  return null;
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) output[key] = canonicalValue(value[key]);
  return output;
}
async function manifestAssetHash(manifest, rawManifestHash) {
  const declared = asHex(manifest.runtimeAssetHash || manifest.assetHash || manifest.assetsHash);
  if (manifest.runtimeHashAlgorithm === 'canonical-runtime-identity-v1') {
    if (!declared || !manifest.runtimeIdentity) {
      throw manifestFailure('manifest', 'canonical runtime identity/hash is missing');
    }
    const canonical = JSON.stringify(canonicalValue(manifest.runtimeIdentity));
    const computed = await sha256Hex(new TextEncoder().encode(canonical));
    if (computed !== declared) {
      throw manifestFailure('manifest', 'runtimeAssetHash does not match canonical runtime identity', {
        declaredRuntimeAssetHash: declared, computedRuntimeAssetHash: computed
      });
    }
    return declared;
  }
  if (declared && declared !== rawManifestHash) {
    throw manifestFailure('manifest', 'legacy runtimeAssetHash does not match raw runtime-manifest.json bytes');
  }
  return rawManifestHash;
}
async function fetchBytes(asset, total, loaded, manifestUrl) {
  const response = await fetch(originUrl(asset.url, manifestUrl).href, {method: 'GET', cache: 'force-cache'});
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + asset.url);
  const body = new Uint8Array(await response.arrayBuffer());
  if (asset.bytes != null && body.byteLength !== asset.bytes) {
    throw new Error('byte length mismatch for ' + asset.file + ': expected ' + asset.bytes + ', got ' + body.byteLength);
  }
  const actual = await sha256Hex(body);
  if (asset.expectedHash && !pendingValue(asset.expectedHash) && actual !== String(asset.expectedHash).toLowerCase()) {
    throw new Error('SHA-256 mismatch for ' + asset.file + ': expected ' + asset.expectedHash + ', got ' + actual);
  }
  progress('DOWNLOAD_RUNTIME', {asset: asset.file, loadedBytes: loaded + body.byteLength, totalBytes: total,
    assetBytes: body.byteLength, sha256: actual});
  return {bytes: body, sha256: actual};
}
function manifestFailure(layer, message, extra) { const error = new Error(message); error.failureLayer = layer; if (extra) Object.assign(error, extra); return error; }

async function loadManifest(url) {
  let requested = url || DEFAULT_MANIFEST_URL;
  let response = await fetch(originUrl(requested).href, {method: 'GET', cache: 'no-store'});
  if (!response.ok) throw manifestFailure('manifest', 'runtime manifest unavailable: HTTP ' + response.status);
  const raw = new Uint8Array(await response.arrayBuffer()); let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(raw)); }
  catch (error) { throw manifestFailure('manifest', 'runtime manifest is not valid JSON: ' + errorMessage(error)); }
  if (!manifest || typeof manifest !== 'object') throw manifestFailure('manifest', 'runtime manifest is empty');
  return {manifest, manifestUrl: originUrl(requested).href, raw, rawHash: await sha256Hex(raw)};
}
function findFsFile(fs, suffixes) {
  for (const suffix of suffixes) { const found = Object.keys(fs).find(path => path.endsWith(suffix)); if (found) return found; }
  return null;
}
function findResourceDir(fs, manifest) {
  const explicit = manifest.resourceDir || manifest.clangResourceDir || manifest.resourceDirPath;
  if (explicit) return String(explicit);
  const found = Object.keys(fs).find(path => /\/lib\/clang\/[^/]+\/include\//.test(path));
  if (found) return found.slice(0, found.indexOf('/include/')) + '/include';
  const packaged = Object.keys(fs).find(path => path.startsWith('/sys/clang-resource/'));
  if (packaged) return '/sys/clang-resource';
  return '/sys/lib/clang/19.1.7/include';
}
function replaceTemplate(value, replacements) {
  return String(value).replace(/\{(\w+)\}|<(source|object|output|sysroot)>/g, (_all, a, b) => {
    const key = a || b; return replacements[key] == null ? _all : replacements[key];
  });
}
function templateArgs(value, replacements) { return Array.isArray(value) ? value.map(item => replaceTemplate(item, replacements)) : null; }

function compileArgs(profile, message, manifest, fs) {
  const optLevel = /^-O[0-2s]$/.test(String(message.optLevel || '')) ? String(message.optLevel) : '-O2';
  const flags = flagsOf(message).filter(flag => !/^-std=/.test(flag) && !/^-O[0-3s]$/.test(flag));
  const resourceDir = findResourceDir(fs, manifest);
  if (profile.language === 'cpp') {
    // Keep C++ on the same integrated-cc1 path as C.  The standalone driver
    // shipped in this browser build crashes while parsing libc++ headers;
    // explicit cc1 include ordering still gives libc++'s include_next the
    // target wasi headers it needs.
  }
  const replacements = {source: '/program', object: '/program.o', output: '/program.wasm', sysroot: '/sys',
    standard: profile.standard, resourceDir, optLevel};
  const fromManifest = templateArgs(manifest.compilerArgs || manifest.compileArgs, replacements);
  if (fromManifest) return fromManifest.concat(flags);
  // These are cc1 arguments, not driver arguments.  The generated Clang 19
  // browser binary rejects the driver-only diagnostic formatting switches.
  const args = ['clang', '-cc1', '-triple', TARGET, '-isysroot', '/sys', '-ferror-limit', '4',
    '-std=' + profile.standard, '-emit-obj',
    optLevel];
  // libc++ uses include_next for the wasi-libc C headers.  Put the C++
  // headers first so include_next reaches the target C headers afterwards.
  if (profile.language === 'c') {
    args.push('-internal-isystem', '/sys/include/wasm32-wasi',
      '-internal-isystem', resourceDir, '-fno-common', '-x', 'c');
  } else {
    args.push('-internal-isystem', '/sys/include/c++/v1', '-internal-externc-isystem', '/sys/include/wasm32-wasi',
      '-internal-isystem', resourceDir, '-x', 'c++');
  }
  return args.concat(flags, ['-o', '/program.o', '/program']);
}
function linkerArgs(profile, message, manifest, fs, sharedRoot) {
  const root = String(sharedRoot || '/shared').replace(/\/$/, '');
  const sharedPath = path => path && path.startsWith('/') ? root + path : path;
  // Keep inputs on the shared PROXYFS mount, but write the link result to the
  // linker's own MEMFS.  PROXYFS is intentionally used for the shared source,
  // object and sysroot; some Emscripten PROXYFS builds cannot create/truncate
  // a new file through the mounted root after a prior callMain invocation.
  const replacements = {source: root + '/program', object: root + '/program.o', output: '/program.wasm', sysroot: root + '/sys'};
  const fromManifest = templateArgs(manifest.linkerArgs || manifest.linkArgs, replacements);
  if (fromManifest) return fromManifest;
  const crt = manifest.crt1 || manifest.startupObject
    || findFsFile(fs, ['/sys/lib/wasm32-wasi/crt1-command.o', '/sys/lib/wasm32-wasi/crt1.o']);
  const args = ['wasm-ld', '--export-dynamic', '--undefined=main', '-z', 'stack-size=1048576', '-L' + root + '/sys/lib/wasm32-wasi'];
  if (crt) args.push(sharedPath(crt));
  const libraryDirs = new Set([root + '/sys/lib/wasm32-wasi']);
  for (const suffix of ['/libc++.a', '/libc++abi.a', '/libclang_rt.builtins-wasm32.a']) {
    const path = findFsFile(fs, [suffix]);
    if (path) libraryDirs.add(sharedPath(path.slice(0, path.lastIndexOf('/')) || '/'));
  }
  for (const directory of libraryDirs) {
    const arg = '-L' + directory;
    if (!args.includes(arg)) args.push(arg);
  }
  args.push(root + '/program.o');
  if (profile.language === 'cpp') args.push('-lc++', '-lc++abi');
  if (profile.language === 'c') args.push('-lc-printscan-long-double');
  args.push('-lc');
  const builtins = findFsFile(fs, ['/libclang_rt.builtins-wasm32.a']);
  if (builtins) {
    const index = builtins.lastIndexOf('/');
    args.push('-L' + sharedPath(index > 0 ? builtins.slice(0, index) : '/sys/lib'), '-lclang_rt.builtins-wasm32');
  }
  return args.concat(flagsOf(message), ['-o', '/program.wasm']);
}
function classifyFailure(phase, text) {
  const value = String(text || '').toLowerCase();
  if (phase === 'manifest') return 'manifest'; if (phase === 'asset') return 'asset';
  if (phase === 'instantiate') return 'instantiate'; if (phase === 'filesystem') return 'filesystem';
  if (phase === 'compile') return /libc\+\+|libcxx|c\+\+abi/.test(value) ? 'libc++' : 'frontend';
  if (phase === 'link') {
    if (/compiler-rt|builtins/.test(value)) return 'compiler-rt';
    if (/libc\+\+|libcxx|c\+\+abi/.test(value)) return 'libc++'; return 'wasm-ld';
  }
  if (phase === 'execution') return 'execution'; return phase || 'runtime';
}

async function prepareToolPair(compilerGlue, compilerWasm, linkerGlue, linkerWasm, label, baseUrl) {
  let compilerHandle; let linkerHandle;
  try {
    compilerHandle = await instantiateEmscriptenModule(compilerGlue, compilerWasm, label + '-clang', baseUrl);
    linkerHandle = await instantiateEmscriptenModule(linkerGlue, linkerWasm, label + '-wasm-ld', baseUrl);
  } catch (error) {
    if (error.failureLayer) throw error;
    throw manifestFailure('instantiate', label + ' Emscripten compiler/linker initialization failed: ' + errorMessage(error));
  }
  return {
    compilerHandle,
    linkerHandle,
    clangModule: compilerHandle.module,
    lldModule: linkerHandle.module,
    compilerInitMs: 0,
    proxyFs: null
  };
}

function mountToolPair(pair, fs) {
  try {
    writeSysrootToEmscripten(pair.clangModule, fs);
    const proxyFs = mountProxyFs(pair.clangModule, pair.lldModule);
    if (!proxyFs.mounted) throw new Error('PROXYFS mount did not report mounted');
    pair.proxyFs = proxyFs;
    return pair;
  } catch (error) {
    throw manifestFailure('filesystem', 'Emscripten sysroot/PROXYFS mount failed: ' + errorMessage(error));
  }
}

async function runWasiCommand(module, args, fs, options) {
  const opts = options || {}; const stdout = {text: '', truncated: false}; const stderr = {text: '', truncated: false};
  const wasi = new WASI({fs, args, env: opts.env || {}, stdin: opts.stdin || (() => null),
    stdout: text => appendCapped(stdout, text), stderr: text => appendCapped(stderr, text)});
  const instantiateStart = now(); let instance;
  try { instance = await WebAssembly.instantiate(module, wasi.getImportObject()); }
  catch (error) { return {ok: false, exitCode: -1, stdout: stdout.text, stderr: stderr.text, error,
    instantiateFailed: true, instantiateMs: now() - instantiateStart, runMs: 0, fs}; }
  const runStart = now();
  try {
    const result = wasi.start({instance, module});
    return {ok: result.exitCode === 0, exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text,
      outputTruncated: stdout.truncated || stderr.truncated, instantiateMs: now() - instantiateStart,
      runMs: now() - runStart, fs: result.fs || fs};
  } catch (error) {
    return {ok: false, exitCode: -1, stdout: stdout.text, stderr: stderr.text,
      outputTruncated: stdout.truncated || stderr.truncated, error, instantiateMs: now() - instantiateStart,
      runMs: now() - runStart, fs};
  }
}

async function loadRuntime(message) {
  const initStarted = now();
  const loaded = await loadManifest(message && message.manifestUrl); const manifest = loaded.manifest;
  const runtimeAssetHash = await manifestAssetHash(manifest, loaded.rawHash);
  if (manifest.runtimeId && manifest.runtimeId !== ENGINE_RUNTIME_ID) {
    throw manifestFailure('manifest', 'unexpected runtimeId: ' + manifest.runtimeId);
  }
  if (manifest.engineRuntimeId && manifest.engineRuntimeId !== ENGINE_RUNTIME_ID) {
    throw manifestFailure('manifest', 'unexpected engineRuntimeId: ' + manifest.engineRuntimeId);
  }
  const assets = normaliseAssets(manifest, loaded.manifestUrl);
  if (!assets.length) throw manifestFailure('manifest', 'runtime manifest has no assets');
  const sysrootAssets = assets.filter(asset => asset.kind === 'sysroot');
  if (sysrootAssets.length > 1) {
    throw manifestFailure('filesystem', 'runtime manifest must contain one deterministic sysroot archive; found ' + sysrootAssets.length);
  }
  if (sysrootAssets.length === 1 && !/\.tar(?:\.gz)?$/i.test(sysrootAssets[0].file)) {
    throw manifestFailure('filesystem', 'sysroot asset must be a .tar or .tar.gz archive: ' + sysrootAssets[0].file);
  }
  const compilerAsset = pickAsset(assets, ['compiler'], [/clang\.wasm/, /compiler/]);
  const linkerAsset = pickAsset(assets, ['linker'], [/wasm-ld\.wasm/, /lld\.wasm/, /linker/]);
  const compilerGlueAsset = pickAsset(assets, ['compiler-glue'], [/clang\.js/, /compiler.*\.js/]);
  const linkerGlueAsset = pickAsset(assets, ['linker-glue'], [/wasm-ld\.js/, /lld\.js/, /linker.*\.js/]);
  const sysrootAsset = pickAsset(assets, ['sysroot'], [/sysroot/, /clang-fs/]);
  if (!compilerAsset || !linkerAsset) throw manifestFailure('manifest', 'compiler or wasm-ld WASM asset missing');
  if (!compilerGlueAsset || !linkerGlueAsset) {
    throw manifestFailure('manifest', 'Emscripten compiler/linker glue asset missing; standalone WASI modules are not accepted');
  }
  if (!sysrootAsset) throw manifestFailure('filesystem', 'modern runtime sysroot archive is missing');
  const required = assets.filter(asset => asset.kind !== 'other' || asset === compilerAsset || asset === linkerAsset);
  const total = required.reduce((sum, asset) => sum + (asset.bytes || 0), 0); let loadedBytes = 0;
  const downloaded = new Map(); setState(STATE.DOWNLOAD_RUNTIME, {assetCount: required.length});
  for (const asset of required) {
    if (pendingValue(asset.expectedHash) || asset.bytes == null) {
      throw manifestFailure('asset', 'asset metadata is incomplete for ' + asset.file);
    }
    let item;
    try { item = await fetchBytes(asset, total, loadedBytes, loaded.manifestUrl); }
    catch (error) {
      throw manifestFailure('asset', 'runtime asset validation failed for ' + asset.file + ': ' + errorMessage(error));
    }
    loadedBytes += item.bytes.byteLength;
    downloaded.set(asset.file, Object.assign({}, asset, item));
  }
  setState(STATE.INITIALIZE_WASM, {indeterminate: true});
  const compilerWasm = downloaded.get(compilerAsset.file); const linkerWasm = downloaded.get(linkerAsset.file);
  const compilerGlue = downloaded.get(compilerGlueAsset.file); const linkerGlue = downloaded.get(linkerGlueAsset.file);
  if (!compilerWasm || !linkerWasm || !compilerGlue || !linkerGlue) {
    throw manifestFailure('asset', 'compiler/linker WASM or Emscripten glue asset was not downloaded');
  }
  const basePair = await prepareToolPair(compilerGlue, compilerWasm, linkerGlue, linkerWasm,
    'c17', manifestBase(loaded.manifestUrl));
  setState(STATE.MOUNT_VFS, {indeterminate: true}); let fs = {};
  const sysroot = downloaded.get(sysrootAsset.file);
  if (!sysroot) throw manifestFailure('filesystem', 'sysroot asset was not downloaded');
  try { fs = mountSysroot(await unpackSysroot(sysroot.bytes)); }
  catch (error) { throw manifestFailure('filesystem', 'sysroot mount failed: ' + errorMessage(error)); }
  for (const asset of downloaded.values()) {
    if (asset.kind === 'header-shim') {
      const path = asset.mountPath || '/sys/include/c++/v1/bits/stdc++.h';
      fs[path] = fileEntry(path, asset.bytes);
      continue;
    }
    if (!['libcxx', 'libcxxabi', 'compiler-rt'].includes(asset.kind)) continue;
    const path = asset.mountPath || (asset.kind === 'libcxx' ? '/sys/lib/wasm32-wasi/libc++.a'
      : asset.kind === 'libcxxabi' ? '/sys/lib/wasm32-wasi/libc++abi.a'
      : '/sys/lib/clang/19/lib/wasi/libclang_rt.builtins-wasm32.a');
    fs[path] = fileEntry(path, asset.bytes);
  }
  if (!Object.keys(fs).length) throw manifestFailure('filesystem', 'modern runtime sysroot is empty');
  mountToolPair(basePair, fs);
  setState(STATE.WARMUP_COMPILER, {indeterminate: true});
  basePair.compilerInitMs = Math.round(now() - initStarted);
  runtime = {manifest, manifestUrl: loaded.manifestUrl, manifestHash: loaded.rawHash, runtimeAssetHash,
    assets: downloaded, fs, clangModule: basePair.clangModule, lldModule: basePair.lldModule,
    compilerHandle: basePair.compilerHandle, linkerHandle: basePair.linkerHandle,
    pairs: new Map([['c17', basePair]]), pairPromises: new Map(),
    compilerAsset: compilerAsset.file, linkerAsset: linkerAsset.file,
    compilerGlueAsset: compilerGlueAsset.file, linkerGlueAsset: linkerGlueAsset.file,
    sysrootAsset: sysrootAsset.file, proxyFs: basePair.proxyFs,
    compilerInitMs: basePair.compilerInitMs, readyAt: new Date().toISOString()};
  setState(STATE.READY, {runtimeAssetHash, loadedBytes, totalBytes: total, compilerGlueVerified: true,
    linkerGlueVerified: true, proxyFsMounted: true});
  return {type: 'inited', ok: true, status: 'READY', runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID,
    runtimeAssetHash, clangVersion: manifest.clangVersion || manifest.compilerVersion || 'Clang 19.1.7',
    lldVersion: manifest.lldVersion || manifest.linkerVersion || 'LLD 19.1.7', target: manifest.target || TARGET,
    libcxxVersion: manifest.libcxxVersion || 'libc++19 / libc++abi19', runtimeSource: 'self-hosted',
    manifestUrl: loaded.manifestUrl, assetBytes: total, assetCount: downloaded.size,
    compilerInitMs: runtime.compilerInitMs, compilerGlueVerified: true, linkerGlueVerified: true,
    proxyFsMounted: true, proxyFs: runtime.proxyFs};
}
async function init(message) {
  if (runtime && workerState === STATE.READY) {
    return {type: 'inited', ok: true, status: 'READY', runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID,
      runtimeAssetHash: runtime.runtimeAssetHash, clangVersion: runtime.manifest.clangVersion || 'Clang 19.1.7',
      lldVersion: runtime.manifest.lldVersion || 'LLD 19.1.7', target: runtime.manifest.target || TARGET,
      compilerInitMs: runtime.compilerInitMs, compilerGlueVerified: true, linkerGlueVerified: true,
      proxyFsMounted: !!(runtime.proxyFs && runtime.proxyFs.mounted), proxyFs: runtime.proxyFs,
      cached: true, manifestUrl: runtime.manifestUrl};
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    counters.initCount += 1; setState(STATE.CHECK_CACHE);
    try { return await loadRuntime(message || {}); }
    catch (error) {
      runtime = null; setState(STATE.FAILED, {failureLayer: error.failureLayer || 'runtime', error: errorMessage(error)});
      return {type: 'inited', ok: false, status: 'PENDING', runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID,
        failureLayer: error.failureLayer || 'runtime', error: errorMessage(error), message: errorMessage(error)};
    } finally { initPromise = null; }
  })();
  return initPromise;
}

async function createSubmissionPair(profile) {
  if (!runtime || !runtime.assets || !runtime.fs) {
    throw manifestFailure('runtime', 'Modern Clang runtime submission assets are unavailable');
  }
  const pairId = profile.language === 'c' ? 'c17' : 'cpp17';
  const pairStarted = now();
  try {
    const pair = await prepareToolPair(
      runtime.assets.get(runtime.compilerGlueAsset), runtime.assets.get(runtime.compilerAsset),
      runtime.assets.get(runtime.linkerGlueAsset), runtime.assets.get(runtime.linkerAsset),
      pairId + '-submission', manifestBase(runtime.manifestUrl));
    mountToolPair(pair, runtime.fs);
    pair.compilerInitMs = Math.round(now() - pairStarted);
    return pair;
  } catch (error) {
    if (error.failureLayer) throw error;
    throw manifestFailure('instantiate', pairId + ' submission compiler/linker initialization failed: ' + errorMessage(error));
  }
}

function releaseSubmissionPair(pair) {
  if (!pair) return;
  try {
    if (pair.proxyFs?.mountpoint && pair.lldModule?.FS?.unmount) pair.lldModule.FS.unmount(pair.proxyFs.mountpoint);
  } catch (_) { /* disposal is best-effort; the pair is no longer referenced below */ }
  try { if (typeof pair.compilerHandle?.module?.destroy === 'function') pair.compilerHandle.module.destroy(); } catch (_) {}
  try { if (typeof pair.linkerHandle?.module?.destroy === 'function') pair.linkerHandle.module.destroy(); } catch (_) {}
  pair.proxyFs = null; pair.compilerHandle = null; pair.linkerHandle = null;
  pair.clangModule = null; pair.lldModule = null;
}

async function compile(message) {
  const started = now(); const source = sourceOf(message || {});
  const profile = normaliseProfile((message && (message.profileId || message.language || message.lang)) || 'cpp17');
  const flags = flagsOf(message || {}); const flagsText = canonicalFlags(flags.concat([optLevelOf(message || {})])); const sourceBytes = new TextEncoder().encode(source);
  if (profile.unsupported) return {ok: false, runtimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId, sourceHash: null,
    cacheHit: false, compileStatus: 'PENDING', runStatus: 'UNAVAILABLE', exitCode: -1, failureLayer: 'profile',
    error: 'Only C17 and C++17 are enabled in Phase 8 Checkpoint 2'};
  if (!runtime || workerState !== STATE.READY) return {ok: false, runtimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
    sourceHash: null, cacheHit: false, compileStatus: 'NOT_READY', runStatus: 'UNAVAILABLE', exitCode: -1,
    failureLayer: 'runtime', error: 'Modern Clang runtime is not READY (state=' + workerState + ')'};
  if (sourceBytes.byteLength > MAX_SOURCE_BYTES) return {ok: false, runtimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
    sourceHash: null, cacheHit: false, compileStatus: 'CE', runStatus: 'CE', exitCode: -1, failureLayer: 'frontend',
    error: 'source exceeds 1 MiB local limit', stderr: 'source exceeds 1 MiB local limit',
    limitField: 'source', limitBytes: MAX_SOURCE_BYTES, actualBytes: sourceBytes.byteLength};
  const sourceHash = await sha256Hex(sourceBytes);
  const key = makeCacheKey(profile.profileId, profile.standard, flagsText, runtime.runtimeAssetHash, sourceHash);
  const cached = cacheGet(key);
  if (cached) {
    counters.cacheHits += 1;
    return {ok: true, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      standard: profile.standard, sourceHash, cacheKey: key, cacheHit: true, bytes: cached.bytes.slice(), compileStatus: 'PASS',
      runStatus: 'PASS', exitCode: 0, timing: {compilerInitMs: runtime.compilerInitMs, compileMs: 0, linkMs: 0, totalMs: Math.round(now() - started)},
      compilerInitMs: runtime.compilerInitMs, compileMs: 0, linkMs: 0,
      compilerGlueVerified: !!runtime.compilerHandle?.factoryVerified, linkerGlueVerified: !!runtime.linkerHandle?.factoryVerified,
      proxyFsMounted: !!runtime.proxyFs?.mounted};
  }
  counters.cacheMisses += 1; counters.compileCount += 1;
  let pair;
  try { pair = await createSubmissionPair(profile); }
  catch (error) {
    const failureLayer = error.failureLayer || 'instantiate'; const text = errorMessage(error);
    setState(STATE.READY, {failureLayer, profileId: profile.profileId, sourceHash});
    return {ok: false, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      standard: profile.standard, sourceHash, cacheKey: key, cacheHit: false, compileStatus: 'CE', runStatus: 'CE',
      exitCode: -1, failureLayer, error: text, stdout: '', stderr: text,
      timing: {compilerInitMs: runtime.compilerInitMs, compileMs: 0, linkMs: 0, totalMs: Math.round(now() - started)},
      compilerInitMs: runtime.compilerInitMs, compileMs: 0, linkMs: 0,
      compilerGlueVerified: false, linkerGlueVerified: false, proxyFsMounted: false};
  }
  const fs = runtime.fs;
  try {
    removeEmscriptenFile(pair.clangModule, '/program.o'); removeEmscriptenFile(pair.clangModule, '/program.wasm');
    writeEmscriptenFile(pair.clangModule, '/program', source);
  } catch (error) {
    const result = {ok: false, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      standard: profile.standard, sourceHash, cacheKey: key, cacheHit: false, compileStatus: 'CE', runStatus: 'CE',
      exitCode: -1, failureLayer: 'filesystem', error: errorMessage(error), stdout: '', stderr: errorMessage(error),
      compilerInitMs: pair.compilerInitMs, compileMs: 0, linkMs: 0,
      compilerGlueVerified: !!pair.compilerHandle.factoryVerified, linkerGlueVerified: !!pair.linkerHandle.factoryVerified,
      proxyFsMounted: !!pair.proxyFs?.mounted};
    releaseSubmissionPair(pair);
    return result;
  }
  const timing = {compilerInitMs: 0, compileMs: 0, linkMs: 0, totalMs: 0}; setState(STATE.COMPILING, {profileId: profile.profileId, sourceHash});
  const compileStart = now(); let cc;
  try { cc = runEmscriptenCommand(pair.compilerHandle, compileArgs(profile, message || {}, runtime.manifest, fs), 'clang'); }
  catch (error) { cc = {ok: false, exitCode: -1, stdout: '', stderr: errorMessage(error), error, runMs: 0}; }
  timing.compilerInitMs = pair.compilerInitMs;
  timing.compileMs = Math.round(cc.runMs || (now() - compileStart));
  if (!cc.ok || cc.exitCode !== 0) {
    const failureLayer = 'frontend'; timing.totalMs = Math.round(now() - started); setState(STATE.READY, {failureLayer});
    const text = cc.stderr || cc.error && errorMessage(cc.error) || 'clang frontend failed';
    const result = {ok: false, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      standard: profile.standard, sourceHash, cacheKey: key, cacheHit: false, compileStatus: 'CE', runStatus: 'CE',
      exitCode: cc.exitCode, failureLayer, error: text, stdout: cc.stdout || '', stderr: text,
      timing, compilerInitMs: timing.compilerInitMs, compileMs: timing.compileMs, linkMs: 0,
      compilerGlueVerified: !!pair.compilerHandle.factoryVerified, linkerGlueVerified: !!pair.linkerHandle.factoryVerified,
      proxyFsMounted: !!pair.proxyFs?.mounted};
    releaseSubmissionPair(pair);
    return result;
  }
  setState(STATE.LINKING, {profileId: profile.profileId, sourceHash}); counters.linkCount += 1; const linkStart = now(); let ld;
  removeEmscriptenFile(pair.lldModule, '/program.wasm');
  try { ld = runEmscriptenCommand(pair.linkerHandle,
    linkerArgs(profile, message || {}, runtime.manifest, fs, pair.proxyFs.mountpoint), 'wasm-ld'); }
  catch (error) { ld = {ok: false, exitCode: -1, stdout: '', stderr: errorMessage(error), error, runMs: 0}; }
  timing.linkMs = Math.round(ld.runMs || (now() - linkStart)); let bytes = null;
  try { bytes = moduleReadFile(pair.lldModule, '/program.wasm'); } catch (_) { bytes = null; }
  if (!ld.ok || ld.exitCode !== 0 || !bytes || !bytes.byteLength) {
    timing.totalMs = Math.round(now() - started); const text = ld.stderr || ld.error && errorMessage(ld.error) || 'wasm-ld failed';
    const failureLayer = classifyFailure('link', text);
    setState(STATE.READY, {failureLayer});
    const result = {ok: false, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      standard: profile.standard, sourceHash, cacheKey: key, cacheHit: false, compileStatus: 'CE', runStatus: 'CE',
      exitCode: ld.exitCode, failureLayer, error: text, stdout: ld.stdout || '', stderr: text,
      timing, compilerInitMs: timing.compilerInitMs, compileMs: timing.compileMs, linkMs: timing.linkMs,
      compilerGlueVerified: !!pair.compilerHandle.factoryVerified, linkerGlueVerified: !!pair.linkerHandle.factoryVerified,
      proxyFsMounted: !!pair.proxyFs?.mounted};
    releaseSubmissionPair(pair);
    return result;
  }
  const artifact = bytes.slice(); cachePut(key, {bytes: artifact, sourceHash, profileId: profile.profileId, standard: profile.standard, createdAt: Date.now()});
  counters.bytesCompiled += artifact.byteLength; timing.totalMs = Math.round(now() - started); setState(STATE.READY, {profileId: profile.profileId, sourceHash, cacheHit: false});
  const result = {ok: true, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
    standard: profile.standard, sourceHash, cacheKey: key, cacheHit: false, bytes: artifact, compileStatus: 'PASS', runStatus: 'PASS',
    exitCode: 0, timing, compilerInitMs: timing.compilerInitMs, compileMs: timing.compileMs, linkMs: timing.linkMs,
    compilerGlueVerified: !!pair.compilerHandle.factoryVerified, linkerGlueVerified: !!pair.linkerHandle.factoryVerified,
    proxyFsMounted: !!pair.proxyFs?.mounted};
  releaseSubmissionPair(pair);
  return result;
}

function makeStdinReader(stdinBuffer) {
  if (!stdinBuffer) return () => null; const view = new DataView(stdinBuffer);
  return function readStdin(length) {
    if (typeof Atomics !== 'undefined' && typeof SharedArrayBuffer !== 'undefined' && stdinBuffer instanceof SharedArrayBuffer) Atomics.wait(new Int32Array(stdinBuffer), 0, 0);
    const available = view.getInt32(0); if (available < 0) { view.setInt32(0, 0); return null; } if (!available) return null;
    const bytes = new Uint8Array(stdinBuffer, 4, available); const count = Math.min(Number(length) || available, available);
    const text = new TextDecoder().decode(bytes.slice(0, count)); const rest = bytes.slice(count); new Uint8Array(stdinBuffer, 4).set(rest); view.setInt32(0, rest.byteLength); return text;
  };
}
async function executeArtifact(bytes, message, profile, compileResult) {
  const stdout = {text: '', truncated: false}; const stderr = {text: '', truncated: false};
  const timing = {wasmCompileMs: 0, instantiateMs: 0, executionMs: 0}; let module;
  try {
    if (bytes instanceof WebAssembly.Module) module = bytes;
    else { const compileStart = now(); module = await WebAssembly.compile(bytes); timing.wasmCompileMs = Math.round((now() - compileStart) * 10) / 10; }
    const stdinBytes = new TextEncoder().encode(String(message.stdin || ''));
    if (stdinBytes.byteLength > MAX_STDIN_BYTES) return {ok: false, runtimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      sourceHash: compileResult.sourceHash, cacheHit: !!compileResult.cacheHit, compileStatus: 'PASS', runStatus: 'INPUT_LIMIT', exitCode: -1,
      runtimeAssetHash: runtime && runtime.runtimeAssetHash || null, cacheKey: compileResult.cacheKey || null,
      stdout: '', stderr: 'stdin exceeds 4 MiB local limit', failureLayer: 'execution', timedOut: false, aborted: false, timing,
      compilerInitMs: compileResult.compilerInitMs || 0, compileMs: compileResult.compileMs || 0, linkMs: compileResult.linkMs || 0,
      compilerGlueVerified: compileResult.compilerGlueVerified ?? !!runtime?.compilerHandle?.factoryVerified,
      linkerGlueVerified: compileResult.linkerGlueVerified ?? !!runtime?.linkerHandle?.factoryVerified,
      proxyFsMounted: compileResult.proxyFsMounted ?? !!runtime?.proxyFs?.mounted};
    const stdinBuffer = message.stdinBuffer || null; let stdinOffset = 0;
    const stringStdin = length => {
      if (stdinOffset >= stdinBytes.length) return null;
      const count = Math.min(Number(length) || stdinBytes.length, stdinBytes.length - stdinOffset);
      const chunk = new TextDecoder().decode(stdinBytes.slice(stdinOffset, stdinOffset + count));
      stdinOffset += count;
      return chunk;
    };
    const wasi = new WASI({fs: {}, args: message.args || ['program'], env: message.env || {}, stdin: stdinBuffer ? makeStdinReader(stdinBuffer) : stringStdin,
      stdout: text => appendCapped(stdout, text), stderr: text => appendCapped(stderr, text)});
    const instantiateStart = now(); const instance = await WebAssembly.instantiate(module, wasi.getImportObject()); timing.instantiateMs = Math.round((now() - instantiateStart) * 10) / 10;
    const executionStart = now(); const result = wasi.start({instance, module}); timing.executionMs = Math.round((now() - executionStart) * 10) / 10;
    counters.bytesExecuted += bytes.byteLength || 0; counters.runCount += 1;
    return {ok: result.exitCode === 0, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId,
      sourceHash: compileResult.sourceHash, cacheHit: !!compileResult.cacheHit, compileStatus: 'PASS', runStatus: result.exitCode === 0 ? 'PASS' : 'RE',
      runtimeAssetHash: runtime && runtime.runtimeAssetHash || null, cacheKey: compileResult.cacheKey || null,
      exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text, outputTruncated: stdout.truncated || stderr.truncated, timedOut: false, aborted: false,
      failureLayer: result.exitCode === 0 ? null : 'execution', timing, compilerInitMs: compileResult.compilerInitMs || 0,
      compileMs: compileResult.compileMs || 0, linkMs: compileResult.linkMs || 0, executionMs: timing.executionMs,
      compileTime: (compileResult.compileMs || 0) + (compileResult.linkMs || 0), executionTime: timing.executionMs,
      compilerGlueVerified: compileResult.compilerGlueVerified ?? !!runtime?.compilerHandle?.factoryVerified,
      linkerGlueVerified: compileResult.linkerGlueVerified ?? !!runtime?.linkerHandle?.factoryVerified,
      proxyFsMounted: compileResult.proxyFsMounted ?? !!runtime?.proxyFs?.mounted};
  } catch (error) {
    return {ok: false, runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId, sourceHash: compileResult.sourceHash,
      cacheHit: !!compileResult.cacheHit, compileStatus: 'PASS', runStatus: 'RE', exitCode: -1, stdout: stdout.text, stderr: stderr.text || errorMessage(error),
      runtimeAssetHash: runtime && runtime.runtimeAssetHash || null, cacheKey: compileResult.cacheKey || null,
      outputTruncated: stdout.truncated || stderr.truncated, timedOut: false, aborted: false, failureLayer: 'execution', error: errorMessage(error), timing,
      compilerInitMs: compileResult.compilerInitMs || 0, compileMs: compileResult.compileMs || 0, linkMs: compileResult.linkMs || 0, executionMs: 0,
      compileTime: (compileResult.compileMs || 0) + (compileResult.linkMs || 0), executionTime: 0,
      compilerGlueVerified: compileResult.compilerGlueVerified ?? !!runtime?.compilerHandle?.factoryVerified,
      linkerGlueVerified: compileResult.linkerGlueVerified ?? !!runtime?.linkerHandle?.factoryVerified,
      proxyFsMounted: compileResult.proxyFsMounted ?? !!runtime?.proxyFs?.mounted};
  }
}
async function run(message) {
  const profile = normaliseProfile((message && (message.profileId || message.language || message.lang)) || 'cpp17');
  if (profile.unsupported) return {ok: false, runtimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId, compileStatus: 'PENDING', runStatus: 'UNAVAILABLE', exitCode: -1,
    cacheHit: false, stdout: '', stderr: '', failureLayer: 'profile', error: 'Only C17 and C++17 are enabled in Phase 8 Checkpoint 2'};
  if (workerState !== STATE.READY || !runtime) return {ok: false, runtimeId: ENGINE_RUNTIME_ID, profileId: profile.profileId, compileStatus: 'NOT_READY', runStatus: 'UNAVAILABLE', exitCode: -1,
    cacheHit: false, stdout: '', stderr: '', failureLayer: 'runtime', error: 'Modern Clang runtime is not READY (state=' + workerState + ')'};
  const compileResult = message.bytes ? {ok: true, bytes: message.bytes instanceof Uint8Array ? message.bytes : new Uint8Array(message.bytes), sourceHash: message.sourceHash || null, cacheHit: !!message.cacheHit, compilerInitMs: 0, compileMs: 0, linkMs: 0} : await compile(message);
  if (!compileResult.ok) return Object.assign({compileFailed: true}, compileResult);
  setState(STATE.RUNNING, {
    profileId: profile.profileId, sourceHash: compileResult.sourceHash,
    cacheHit: !!compileResult.cacheHit,
    runtimeAssetHash: runtime.runtimeAssetHash,
    cacheKey: compileResult.cacheKey || null,
    compilerInitMs: compileResult.compilerInitMs || 0,
    compileMs: compileResult.compileMs || 0, linkMs: compileResult.linkMs || 0
  });
  const result = await executeArtifact(compileResult.bytes, message || {}, profile, compileResult);
  result.artifactBytes = compileResult.bytes && compileResult.bytes.byteLength || 0;
  setState(STATE.READY, {profileId: profile.profileId, sourceHash: compileResult.sourceHash}); return Object.assign({compileFailed: false}, result);
}
function stats() {
  const cachedArtifactBytes = Array.from(artifactCache.values()).reduce((sum, entry) =>
    sum + (entry && entry.bytes ? entry.bytes.byteLength : 0), 0);
  return {type: 'stats', runtimeId: ENGINE_RUNTIME_ID, engineRuntimeId: ENGINE_RUNTIME_ID, state: workerState, ready: workerState === STATE.READY,
    runtimeAssetHash: runtime && runtime.runtimeAssetHash || null,
    compilerGlueVerified: !!runtime?.compilerHandle?.factoryVerified,
    linkerGlueVerified: !!runtime?.linkerHandle?.factoryVerified,
    proxyFsMounted: !!runtime?.proxyFs?.mounted, proxyFs: runtime?.proxyFs || null,
    cacheSize: artifactCache.size, cacheCapacity: ARTIFACT_CACHE_CAPACITY,
    memory: {
      compilerLinearMemoryBytes: runtime?.compilerHandle?.module?.HEAPU8?.buffer?.byteLength || null,
      linkerLinearMemoryBytes: runtime?.linkerHandle?.module?.HEAPU8?.buffer?.byteLength || null,
      cachedArtifactBytes
    },
    counters: {...counters}};
}
function dispose() { artifactCache.clear(); runtime = null; initPromise = null; setState(STATE.DISPOSED); post({type: 'disposed', runtimeId: ENGINE_RUNTIME_ID}); }

self.addEventListener('message', async event => {
  const message = event.data || {}; const requestId = message.requestId == null ? ++requestSequence : message.requestId;
  try {
    if (message.type === 'init') { post(Object.assign({requestId}, await init(message))); return; }
    if (message.type === 'compile') {
      const response = await compile(message);
      // Never transfer the cache-owned buffer: detaching it would turn a cache
      // hit into an empty artifact after the first disposable execution.
      const result = response && response.bytes instanceof Uint8Array
        ? Object.assign({}, response, {bytes: response.bytes.slice()}) : response;
      const transfer = result && result.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
      post(Object.assign({type: 'compile-result', requestId}, result), transfer); return;
    }
    if (message.type === 'stats') { post(Object.assign({requestId}, stats())); return; }
    if (message.type === 'dispose') { dispose(); return; }
    post({type: 'error', requestId, runtimeId: ENGINE_RUNTIME_ID, failureLayer: 'protocol', message: 'unknown worker message type'});
  } catch (error) {
    setState(STATE.FAILED, {failureLayer: error.failureLayer || 'runtime', error: errorMessage(error)});
    post({type: 'error', requestId, runtimeId: ENGINE_RUNTIME_ID, failureLayer: error.failureLayer || 'runtime', message: errorMessage(error), stack: String(error && error.stack || '').slice(0, 800)});
  }
});
