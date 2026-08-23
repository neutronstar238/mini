/* ============================================================
 * runtime-assets.js —— Runtime 资产真实字节进度下载 + 缓存探测
 * (Runtime Enhancement Phase)
 *
 * 设计目标：
 *  - 真实字节进度：fetch + ReadableStream + Content-Length，统计 loadedBytes/totalBytes
 *  - 阶段化：CHECK_CACHE → DOWNLOAD → READY，不伪造精度（不可测阶段用 indeterminate 文案）
 *  - 资产清单：runtime-assets-manifest.json 形态（url/bytes/sha256/cacheKey/runtimeId）
 *  - 失败重试：仅重试缺失/失败资产；cache hash 错误自动 invalidate + redownload
 *  - 与冻结 Clang 8.0.1 / Runno 0.10.0-ojc4 共存：本模块不替换现有 runno-loader，
 *    仅为现代 Runtime（C17/C++17/C++20/C++23）提供按需下载，并暴露 onRuntimeProgress 订阅。
 * ============================================================ */

/* ---------------- 进度状态机 ---------------- */
const PROGRESS_STAGES = {
  IDLE: 'IDLE',
  CHECK_CACHE: 'CHECK_CACHE',
  DOWNLOAD_RUNTIME: 'DOWNLOAD_RUNTIME',
  DOWNLOAD_SYSROOT: 'DOWNLOAD_SYSROOT',
  DOWNLOAD_STDLIB: 'DOWNLOAD_STDLIB',
  DOWNLOAD_PCH: 'DOWNLOAD_PCH',
  INITIALIZE_WASM: 'INITIALIZE_WASM',
  MOUNT_VFS: 'MOUNT_VFS',
  WARMUP_COMPILER: 'WARMUP_COMPILER',
  BOOT_JVM: 'BOOT_JVM',
  INITIALIZE_COMPILER: 'INITIALIZE_COMPILER',
  READY: 'READY',
  ERROR: 'ERROR'
};

/* 全局状态：每次 prewarm 创建一个 RuntimeLoadState，由订阅者拉取 */
class RuntimeLoadState {
  constructor(runtimeId) {
    this.runtimeId = runtimeId;
    this.stage = PROGRESS_STAGES.IDLE;
    this.loadedBytes = 0;
    this.totalBytes = 0;
    this.currentAssetName = null;
    this.indeterminate = false; // 不可测阶段置 true，UI 显示 pulse 动画而非伪造百分比
    this.message = '';
    this.error = null;
    this.startedAt = Date.now();
    this.completedAt = null;
    this.listeners = new Set();
  }
  /** 当前阶段总进度（0-100）。indeterminate 时返回 -1，由 UI 显示 pulse。 */
  get percent() {
    if (this.indeterminate) return -1;
    if (this.stage === PROGRESS_STAGES.READY) return 100;
    if (this.stage === PROGRESS_STAGES.ERROR) return 0;
    if (this.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((this.loadedBytes / this.totalBytes) * 1000) / 10);
  }
  setStage(stage, opts) {
    this.stage = stage;
    if (opts) {
      if (opts.indeterminate != null) this.indeterminate = !!opts.indeterminate;
      if (opts.message != null) this.message = opts.message;
    }
    this._emit();
  }
  setProgress(loaded, total, assetName) {
    this.loadedBytes = loaded;
    this.totalBytes = total;
    this.currentAssetName = assetName || this.currentAssetName;
    this.indeterminate = false;
    this._emit();
  }
  setError(err) {
    this.error = err;
    this.stage = PROGRESS_STAGES.ERROR;
    this.indeterminate = false;
    this._emit();
  }
  setReady() {
    this.stage = PROGRESS_STAGES.READY;
    this.indeterminate = false;
    this.completedAt = Date.now();
    this._emit();
  }
  _emit() {
    const snap = this.snapshot();
    this.listeners.forEach(function (fn) {
      try { fn(snap); } catch (_) { /* ignore listener errors */ }
    });
  }
  snapshot() {
    return {
      runtimeId: this.runtimeId,
      stage: this.stage,
      percent: this.percent,
      indeterminate: this.indeterminate,
      loadedBytes: this.loadedBytes,
      totalBytes: this.totalBytes,
      currentAssetName: this.currentAssetName,
      message: this.message,
      error: this.error ? String(this.error.message || this.error) : null,
      elapsedMs: (this.completedAt || Date.now()) - this.startedAt
    };
  }
  subscribe(fn) {
    this.listeners.add(fn);
    try { fn(this.snapshot()); } catch (_) { /* ignore */ }
    return () => this.listeners.delete(fn);
  }
}

/* ---------------- Cache Storage 探测（浏览器 Cache API） ---------------- */
async function cacheProbe(cacheName, url) {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(cacheName);
    const resp = await cache.match(url);
    if (!resp) return null;
    const buf = await resp.arrayBuffer();
    return { bytes: buf.byteLength, body: buf, headers: resp.headers };
  } catch (_) {
    return null;
  }
}
async function cachePut(cacheName, url, resp) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(url, resp.clone());
  } catch (_) { /* ignore */ }
}
async function cacheDelete(cacheName, url) {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(cacheName);
    await cache.delete(url);
  } catch (_) { /* ignore */ }
}

async function sha256HexBuffer(body) {
  if (!body || typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', body);
  return Array.from(new Uint8Array(digest)).map(function (value) {
    return value.toString(16).padStart(2, '0');
  }).join('');
}

async function assetMatches(asset, probe) {
  if (!probe) return false;
  if (asset.bytes != null && probe.bytes !== asset.bytes) return false;
  if (asset.sha256) return (await sha256HexBuffer(probe.body)) === asset.sha256;
  return true;
}

/* ---------------- 真实字节进度 fetch ----------------
 * options:
 *   onProgress(loaded, total, assetName)
 *   signal: AbortSignal
 * 返回 Response（调用方自行处理 bytes）
 */
async function fetchWithProgress(url, opts) {
  const onProgress = (opts && opts.onProgress) || function () {};
  const signal = (opts && opts.signal) || null;
  const resp = await fetch(url, { cache: 'force-cache', signal: signal });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);

  // 若无法流式（无 body.getReader），直接读 arrayBuffer，无进度上报
  if (!resp.body || typeof resp.body.getReader !== 'function') {
    const buf = await resp.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength, url);
    return new Response(buf, resp);
  }

  const total = Number(resp.headers.get('Content-Length')) || 0;
  const reader = resp.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total, url);
  }
  // 重组 ArrayBuffer
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new Response(buf, resp);
}

/* ---------------- 资产清单（runtime-assets-manifest.json 形态） ----------------
 * 现代 Runtime（C17/C++17/C++20/C++23/C++26）的资产清单，未来从 /runtime/<runtimeId>/assets-manifest.json 加载。
 * 本阶段为 Modern Clang 选型完成前的占位（runtimeId = 'cpp-modern-v1'），所有 url 指向 PENDING。
 */
const RUNTIME_ASSETS_MANIFEST = {
  // 冻结 Runtime：旧 Clang 8 / Runno 资产，**只读登记**，由旧管线下载（保持兼容）
  'c11-gcc11-compat-v3': {
    assets: [
      { url: '/runtime/runno/0.10.0-ojc4/langs/clang-fs.tar.gz', bytes: null, cacheKey: 'runno-clang-fs' },
      { url: '/runtime/runno/0.10.0-ojc4/langs/clang.wasm', bytes: null, cacheKey: 'runno-clang-wasm' },
      { url: '/runtime/runno/0.10.0-ojc4/langs/wasm-ld.wasm', bytes: null, cacheKey: 'runno-wasm-ld' }
    ]
  },
  'cpp11-gcc11-compat-v5': {
    // 复用 c11 资产（同 Clang 8 sysroot/wasm-ld），仅 PCH 与 flags 不同
    reuseFrom: 'c11-gcc11-compat-v3'
  },
  'py312-cpython-compat-v1': {
    assets: [
      // 旧 Pyodide 资产由 ide-python-worker.js 处理；此处仅登记供 Diagnostics
      { url: '/runtime/pyodide/0.26.4/pyodide.asm.wasm', bytes: 10088038, cacheKey: 'pyodide-asm' }
    ]
  },
  // Phase 8 Modern profiles share one immutable compiler engine.
  'c17-gcc14-compat-v1': {
    reuseFrom: 'cpp-modern-engine-v1',
    inheritsStandard: 'c17'
  },
  'cpp17-gcc14-compat-v1': {
    reuseFrom: 'cpp-modern-engine-v1',
    inheritsStandard: 'c++17'
  },
  'c17-gcc14-compat-v2': {
    reuseFrom: 'cpp-modern-engine-v2',
    inheritsStandard: 'c17'
  },
  'cpp17-gcc14-compat-v2': {
    reuseFrom: 'cpp-modern-engine-v2',
    inheritsStandard: 'c++17'
  },
  'cpp20-gcc14-compat-v1': {
    reuseFrom: 'cpp-modern-engine-v1',
    inheritsStandard: 'c++20'
  },
  'cpp23-gcc14-compat-v1': {
    reuseFrom: 'cpp-modern-engine-v1',
    inheritsStandard: 'c++23'
  },
  'cpp-modern-engine-v1': {
    purpose: 'Self-built Clang/LLD 19.1.7 Browser Runtime',
    manifestUrl: '/runtime/cpp-modern-engine-v1/runtime-manifest.json',
    assets: []
  },
  'cpp-modern-engine-v2': {
    purpose: 'Clang/LLD 19.1.7 compiler plus disposable execution Worker overlay',
    manifestUrl: '/runtime/cpp-modern-engine-v2/runtime-manifest.json',
    assets: []
  },
  // Java runtime assets are resolved from the cryptographically pinned build
  // manifest. JavaBox URLs and prebuilt artifacts are deliberately absent.
  'java21-browserjdk-compat-v2': {
    purpose: 'Java 21 OpenJDK Browser Runtime (self-built BrowserJDK)',
    manifestUrl: '/runtime/java21-browserjdk-compat-v2/runtime-manifest.json',
    assets: [],
    status: 'MANIFEST_MANAGED'
  },
  // Historical ID is not downloadable and cannot be selected by production.
  'java21-openjdk-wasm-compat-v1': {
    purpose: 'Java 21 OpenJDK Browser Runtime (JavaBox prebuilt PoC — TECHNICAL_REFERENCE_ONLY)',
    assets: [],
    status: 'TECHNICAL_PO_ONLY'
  }
};

/* ---------------- 解析实际资产清单（含 reuseFrom 展开） ----------------
 * 返回 flat assets list（含 url/bytes/cacheKey/runtimeId）
 */
function resolveAssets(runtimeId) {
  const entry = RUNTIME_ASSETS_MANIFEST[runtimeId];
  if (!entry) return [];
  if (entry.reuseFrom) {
    const base = RUNTIME_ASSETS_MANIFEST[entry.reuseFrom];
    if (!base) return [];
    return (base.assets || []).map(function (a) { return Object.assign({}, a, { runtimeId: entry.reuseFrom }); });
  }
  return (entry.assets || []).map(function (a) { return Object.assign({}, a, { runtimeId: runtimeId }); });
}

async function loadManifestAssets(runtimeId) {
  const entry = RUNTIME_ASSETS_MANIFEST[runtimeId];
  if (!entry) return [];
  if (entry.reuseFrom) return loadManifestAssets(entry.reuseFrom);
  if (!entry.manifestUrl || (entry.assets && entry.assets.length)) return resolveAssets(runtimeId);
  const response = await fetch(entry.manifestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error('Runtime manifest HTTP ' + response.status + ': ' + entry.manifestUrl);
  const raw = await response.arrayBuffer();
  let manifest;
  try { manifest = JSON.parse(new TextDecoder().decode(raw)); }
  catch (error) { throw new Error('Runtime manifest JSON invalid: ' + (error.message || error)); }
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error('Runtime manifest has no assets: ' + runtimeId);
  const assets = manifest.assets.map(function (asset) {
    if (!asset.file || !Number.isFinite(asset.bytes) || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) {
      throw new Error('Invalid runtime asset manifest entry: ' + JSON.stringify(asset));
    }
    return {
      file: asset.file,
      url: asset.url || asset.path || ('/runtime/' + runtimeId + '/' + asset.file),
      bytes: asset.bytes,
      sha256: String(asset.sha256).toLowerCase(),
      cacheKey: runtimeId + '-' + asset.file,
      runtimeId: runtimeId
    };
  });
  if (runtimeId === 'cpp-modern-engine-v1' || runtimeId === 'cpp-modern-engine-v2') {
    const files = new Set(assets.map(function (asset) { return String(asset.file || asset.url || '').split('/').pop().toLowerCase(); }));
    const required = ['clang.wasm', 'wasm-ld.wasm', 'clang.js', 'wasm-ld.js'];
    const missing = required.filter(function (file) { return !files.has(file); });
    const sysroots = assets.filter(function (asset) { return /\.tar(?:\.gz)?$/i.test(String(asset.file || asset.url || '')); });
    if (missing.length || sysroots.length !== 1) {
      throw new Error('Modern runtime manifest is incomplete: missing=' + (missing.join(',') || 'none')
        + ', sysrootArchives=' + sysroots.length);
    }
  }
  entry.assets = assets;
  // The immutable cache identity is the SHA-256 of the manifest's original
  // bytes; a declared alias is only corroborating metadata.
  const rawManifestHash = await sha256HexBuffer(raw);
  const declaredRuntimeAssetHash = manifest.runtimeAssetHash || manifest.assetHash || manifest.assetsHash || null;
  if (manifest.runtimeHashAlgorithm === 'canonical-runtime-identity-v1') {
    if (!manifest.runtimeIdentity || !declaredRuntimeAssetHash) {
      throw new Error('Canonical runtime identity is incomplete');
    }
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical);
      if (!value || typeof value !== 'object') return value;
      const out = {};
      Object.keys(value).sort().forEach(function (key) { out[key] = canonical(value[key]); });
      return out;
    }
    const canonicalBytes = new TextEncoder().encode(JSON.stringify(canonical(manifest.runtimeIdentity)));
    entry.runtimeAssetHash = await sha256HexBuffer(canonicalBytes);
    if (String(declaredRuntimeAssetHash).toLowerCase() !== entry.runtimeAssetHash) {
      throw new Error('Runtime manifest canonical runtimeAssetHash mismatch');
    }
    entry.manifestFileSha256 = rawManifestHash;
  } else {
    // v1 cache identity is intentionally the SHA-256 of the final manifest bytes.
    entry.runtimeAssetHash = rawManifestHash;
    if (declaredRuntimeAssetHash && String(declaredRuntimeAssetHash).toLowerCase() !== entry.runtimeAssetHash) {
      throw new Error('Runtime manifest runtimeAssetHash does not match raw manifest bytes');
    }
  }
  return resolveAssets(runtimeId);
}

/* ---------------- Cache 状态枚举 ----------------
 * 对外暴露 runtimeCacheStatus()，供 UI 在「运行时详情」中显示每个 Runtime 的 cache 状态。
 */
async function runtimeCacheStatus(runtimeId) {
  const entry = RUNTIME_ASSETS_MANIFEST[runtimeId];
  const assets = await loadManifestAssets(runtimeId);
  if (!assets.length) {
    // SCAFFOLD / 未发布 assets — 区分"无 entry" vs "有 entry 但 assets:[]"
    if (!entry) return { runtimeId: runtimeId, status: 'UNAVAILABLE', assets: [] };
    const purposeStatus = entry.status || 'SCAFFOLD';
    return { runtimeId: runtimeId, status: 'UNAVAILABLE', assets: [], scaffoldStatus: purposeStatus };
  }
  const out = [];
  for (const a of assets) {
    let hit = await cacheProbe('mini-oj-runtime-v1', a.url);
    // A present Cache Storage entry is not proof of validity.  Modern assets
    // are immutable and hash-pinned; invalidate corrupt entries before a
    // cached prewarm can report READY and let the Worker consume them.
    if (hit && !(await assetMatches(a, hit))) {
      await cacheDelete('mini-oj-runtime-v1', a.url);
      hit = null;
    }
    out.push({
      url: a.url,
      cacheKey: a.cacheKey,
      bytes: a.bytes,
      cached: !!hit,
      cachedBytes: hit ? hit.bytes : 0
    });
  }
  const allCached = out.every(function (o) { return o.cached; });
  const noneCached = out.every(function (o) { return !o.cached; });
  return {
    runtimeId: runtimeId,
    status: allCached ? 'CACHED' : (noneCached ? 'NOT_CACHED' : 'PARTIAL'),
    assets: out
  };
}

/* ---------------- 统一 Runtime Loading 入口 ----------------
 * prewarmRuntime(runtimeId, options)
 *   options: { forceRedownload?: boolean, onProgress?: fn(snapshot), onReady?: fn, onError?: fn }
 *
 * 当前实现：
 *  - 冻结 Runtime（c11/cpp11/python3）走旧的 ensureCompiler/ensurePythonWorker，
 *    本函数仅监控并通过 onProgress 上报 "CACHED" 状态（不再重新下载）。
 *  - 现代 Runtime（c17/cpp17/cpp20/cpp23）使用本模块的下载/缓存管线（PENDING 阶段）。
 *  - Java Runtime 仅上报 "UNAVAILABLE"（PoC 后接入）。
 */
function prewarmRuntime(runtimeId, options) {
  const opts = options || {};
  const state = new RuntimeLoadState(runtimeId);
  const unsub = opts.onProgress ? state.subscribe(opts.onProgress) : function () {};
  const promise = (async function () {
    try {
      // 冻结 Runtime：保持旧管线，本模块只观察
      const frozenSet = new Set(['c11-gcc11-compat-v3', 'cpp11-gcc11-compat-v5', 'py312-cpython-compat-v1']);
      if (frozenSet.has(runtimeId)) {
        const status = await runtimeCacheStatus(runtimeId);
        state.setStage(PROGRESS_STAGES.CHECK_CACHE, { message: '检查缓存（冻结 Runtime）' });
        state.setStage(PROGRESS_STAGES.INITIALIZE_WASM, { indeterminate: true, message: '正在初始化旧 Runtime（冻结管线）' });
        state.setReady();
        if (opts.onReady) try { opts.onReady({ runtimeId: runtimeId, status: status.status }); } catch (_) { /* ignore */ }
        return { runtimeId: runtimeId, status: status.status, frozen: true };
      }
      if (runtimeId === 'java21-openjdk-wasm-compat-v1') {
        throw new Error('BUILD_REQUIRED / NOT_READY: historical JavaBox runtime is disabled');
      }
      if (runtimeId === 'java21-browserjdk-compat-v2') {
        state.setStage(PROGRESS_STAGES.CHECK_CACHE, { indeterminate: true, message: '校验 BrowserJDK 构建清单' });
        const manifestResponse = await fetch('/runtime/java21-browserjdk-compat-v2/runtime-manifest.json', { cache: 'no-store' });
        if (!manifestResponse.ok) throw new Error('BUILD_REQUIRED / NOT_READY: BrowserJDK manifest missing');
        const manifest = await manifestResponse.json();
        if (!Array.isArray(manifest.assets) || !manifest.assets.length) {
          throw new Error('BUILD_REQUIRED / NOT_READY: BrowserJDK manifest has no assets');
        }
        const assets = manifest.assets.map(function (asset) {
          return {
            url: '/runtime/java21-browserjdk-compat-v2/' + asset.file,
            bytes: asset.bytes,
            sha256: asset.sha256,
            cacheKey: 'browserjdk-' + asset.file,
            runtimeId: runtimeId
          };
        });
        const totalBytes = assets.reduce(function (sum, asset) { return sum + asset.bytes; }, 0);
        let loaded = 0;
        for (const asset of assets) {
          let probe = await cacheProbe('mini-oj-runtime-v1', asset.url);
          if (probe && !(await assetMatches(asset, probe))) {
            await cacheDelete('mini-oj-runtime-v1', asset.url);
            probe = null;
          }
          if (!probe || opts.forceRedownload) {
            state.setStage(PROGRESS_STAGES.DOWNLOAD_RUNTIME, { message: '下载并校验 ' + asset.url.split('/').pop() });
            const response = await fetchWithProgress(asset.url, {
              onProgress: function (assetLoaded) { state.setProgress(loaded + assetLoaded, totalBytes, asset.url); }
            });
            const body = await response.clone().arrayBuffer();
            const actual = await sha256HexBuffer(body);
            if (body.byteLength !== asset.bytes || actual !== asset.sha256) {
              throw new Error('BUILD_REQUIRED / NOT_READY: BrowserJDK hash mismatch for ' + asset.url);
            }
            await cachePut('mini-oj-runtime-v1', asset.url, response);
            probe = {bytes: body.byteLength, body: body};
          }
          loaded += probe.bytes;
          state.setProgress(loaded, totalBytes, asset.url);
        }
        state.setStage(PROGRESS_STAGES.BOOT_JVM, { indeterminate: true, message: 'BrowserJDK 资产已校验，等待 Worker 启动 JVM' });
        state.setReady();
        if (opts.onReady) try { opts.onReady({runtimeId: runtimeId, status: 'READY', manifest: manifest}); } catch (_) { /* ignore */ }
        return {runtimeId: runtimeId, status: 'READY', manifest: manifest};
      }
      // 现代 Runtime：完整下载管线
      const assets = await loadManifestAssets(runtimeId);
      if (!assets.length) {
        state.setStage(PROGRESS_STAGES.CHECK_CACHE, { indeterminate: true, message: 'Runtime 资产未注册（PoC 待完成）' });
        if (opts.onError) try { opts.onError(new Error('Runtime 资产未注册: ' + runtimeId)); } catch (_) { /* ignore */ }
        return { runtimeId: runtimeId, status: 'UNAVAILABLE' };
      }
      state.setStage(PROGRESS_STAGES.CHECK_CACHE, { message: '正在检查缓存' });
      const status = await runtimeCacheStatus(runtimeId);
      if (status.status === 'CACHED' && !opts.forceRedownload) {
        state.setStage(PROGRESS_STAGES.INITIALIZE_WASM, { indeterminate: true, message: '已缓存，正在初始化' });
        state.setStage(PROGRESS_STAGES.MOUNT_VFS, { indeterminate: true, message: '正在挂载 VFS' });
        state.setStage(PROGRESS_STAGES.WARMUP_COMPILER, { indeterminate: true, message: '正在预热编译器' });
        state.setReady();
        if (opts.onReady) try { opts.onReady({ runtimeId: runtimeId, status: 'READY', cached: true }); } catch (_) { /* ignore */ }
        return { runtimeId: runtimeId, status: 'READY', cached: true };
      }
      // 总字节（已注册的部分）
      const totalBytes = assets.reduce(function (s, a) { return s + (a.bytes || 0); }, 0);
      let loaded = 0;
      state.totalBytes = totalBytes;
      // 分类阶段映射（按 cacheKey 推测）
      function pickStage(asset) {
        if (asset.cacheKey && /fs|sysroot/.test(asset.cacheKey)) return PROGRESS_STAGES.DOWNLOAD_SYSROOT;
        if (asset.cacheKey && /pch|stdlib/.test(asset.cacheKey)) return PROGRESS_STAGES.DOWNLOAD_STDLIB;
        if (asset.cacheKey && /pch/.test(asset.cacheKey)) return PROGRESS_STAGES.DOWNLOAD_PCH;
        return PROGRESS_STAGES.DOWNLOAD_RUNTIME;
      }
      for (const asset of assets) {
        // 若已 cached 且未强制重下，跳过
        let existing = await cacheProbe('mini-oj-runtime-v1', asset.url);
        if (existing && !(await assetMatches(asset, existing))) {
          await cacheDelete('mini-oj-runtime-v1', asset.url);
          existing = null;
        }
        if (existing && !opts.forceRedownload) {
          loaded += existing.bytes;
          state.setProgress(loaded, totalBytes, asset.url);
          continue;
        }
        state.setStage(pickStage(asset), { indeterminate: true, message: '正在下载 ' + (asset.url.split('/').pop()) });
        const t0 = performance.now();
        const resp = await fetchWithProgress(asset.url, {
          onProgress: function (l, t) {
            state.setProgress(loaded + l, totalBytes, asset.url);
          }
        });
        const ms = Math.round(performance.now() - t0);
        const body = await resp.clone().arrayBuffer();
        if (!(await assetMatches(asset, { bytes: body.byteLength, body: body }))) {
          throw new Error('Runtime asset hash mismatch: ' + asset.url);
        }
        await cachePut('mini-oj-runtime-v1', asset.url, resp);
        const probe = await cacheProbe('mini-oj-runtime-v1', asset.url);
        loaded += probe ? probe.bytes : 0;
        state.setProgress(loaded, totalBytes, asset.url);
        if (typeof console !== 'undefined') console.debug('[runtime-assets] downloaded', asset.url, ms + 'ms');
      }
      state.setStage(PROGRESS_STAGES.INITIALIZE_WASM, { indeterminate: true, message: '正在初始化 WASM' });
      state.setStage(PROGRESS_STAGES.MOUNT_VFS, { indeterminate: true, message: '正在挂载 VFS' });
      state.setStage(PROGRESS_STAGES.WARMUP_COMPILER, { indeterminate: true, message: '正在预热编译器' });
      state.setReady();
      if (opts.onReady) try { opts.onReady({ runtimeId: runtimeId, status: 'READY' }); } catch (_) { /* ignore */ }
      return { runtimeId: runtimeId, status: 'READY' };
    } catch (e) {
      state.setError(e);
      if (opts.onError) try { opts.onError(e); } catch (_) { /* ignore */ }
      throw e;
    } finally {
      unsub();
    }
  })();
  return promise;
}

/* ---------------- Failure Retry（只重试缺失/失败资产） ----------------
 * 对外暴露 retryRuntime(runtimeId, options)，清空指定 url 缓存后重试。
 */
async function retryRuntime(runtimeId, options) {
  const assets = await loadManifestAssets(runtimeId);
  for (const a of assets) await cacheDelete('mini-oj-runtime-v1', a.url);
  return prewarmRuntime(runtimeId, Object.assign({}, options, { forceRedownload: true }));
}

export {
 PROGRESS_STAGES,
 RuntimeLoadState,
 cacheProbe,
 cachePut,
 cacheDelete,
 fetchWithProgress,
 RUNTIME_ASSETS_MANIFEST,
 resolveAssets,
 loadManifestAssets,
 runtimeCacheStatus,
 prewarmRuntime,
 retryRuntime
};
