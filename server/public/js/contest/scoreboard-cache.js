'use strict';
/**
 * Scoreboard 本地缓存（Phase 5 · Client Cache Lease）
 *
 * 尺寸判断：
 *  - 元数据（version / nextSyncAt / 最近更新时间）：始终 localStorage（小）
 *  - 完整 Snapshot：若 JSON 序列化后 > 阈值（config.SCOREBOARD_CACHE_INDEXEDDB_THRESHOLD=64KB）→ IndexedDB；
 *    否则 localStorage。绝不把 Runtime wasm / Pyodide（13MB）等大资源塞进 localStorage。
 *
 * Cache Lease 语义：
 *  - snapshot.nextSyncAt 之前：优先显示本地缓存，后台经 SSE/Lease 更新；
 *  - 超过 nextSyncAt：缓存视为可能过期，但仍可作「先显示后更新」的降级展示。
 *
 * 注意：Cache Lease 不是安全机制；服务器仍有 Rate Limit。恶意清 localStorage 无碍。
 */
(function (global) {
  var KEY_PREFIX = 'oj:scoreboard:v1';
  var INDEXEDDB_THRESHOLD = 65536; // 64KB
  var DB_NAME = 'oj-scoreboard-cache';
  var STORE = 'snapshots';

  /* ---------- IndexedDB 封装（Promise） ---------- */
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('IndexedDB 不可用'));
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result ? r.result.value : null); };
        r.onerror = function () { reject(r.error); };
      });
    }).catch(function () { return null; });
  }
  function idbSet(key, value) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key: key, value: value, savedAt: Date.now() });
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    }).catch(function () { return false; });
  }

  /* ---------- 内存态 ---------- */
  var memCache = { key: null, snapshot: null, size: 0 };

  function metaKey(cid) { return KEY_PREFIX + ':meta:' + cid; }
  function dataKey(cid) { return KEY_PREFIX + ':data:' + cid; }

  /** 尺寸判断：是否应使用 IndexedDB */
  function shouldUseIndexedDB(snapshot) {
    try {
      return JSON.stringify(snapshot).length > INDEXEDDB_THRESHOLD;
    } catch (_) { return false; }
  }

  /**
   * 保存缓存（同步写 localStorage 元数据 + 异步写快照）。
   * 返回 Promise<boolean>。
   */
  function save(cid, snapshot) {
    var now = Date.now();
    // 元数据始终写 localStorage（小）
    try {
      localStorage.setItem(metaKey(cid), JSON.stringify({
        version: snapshot.version,
        savedAt: now,
        nextSyncAt: snapshot.nextSyncAt,
        serverTime: snapshot.serverTime
      }));
    } catch (_) { /* 忽略（隐私模式等） */ }
    try {
      memCache.key = cid;
      memCache.snapshot = snapshot;
      memCache.size = JSON.stringify(snapshot).length;
    } catch (_) {}
    if (shouldUseIndexedDB(snapshot)) {
      return idbSet(dataKey(cid), snapshot);
    }
    try {
      localStorage.setItem(dataKey(cid), JSON.stringify(snapshot));
      return Promise.resolve(true);
    } catch (_) {
      // localStorage 放不下（罕见）→ 尝试 IndexedDB
      return idbSet(dataKey(cid), snapshot);
    }
  }

  /**
   * 读取缓存。返回 { snapshot, version, nextSyncAt, fresh }。
   * fresh = nextSyncAt 在未来（Lease 有效）。
   */
  function load(cid) {
    var meta = null;
    try { meta = JSON.parse(localStorage.getItem(metaKey(cid)) || 'null'); } catch (_) {}
    var now = Date.now();
    var fresh = !!(meta && meta.nextSyncAt && new Date(meta.nextSyncAt).getTime() > now);
    // 先返回内存态（同页切换极快）
    if (memCache.key === cid && memCache.snapshot) {
      return Promise.resolve({ snapshot: memCache.snapshot, version: memCache.snapshot.version, nextSyncAt: (meta && meta.nextSyncAt) || null, fresh: fresh });
    }
    // IndexedDB 优先（大快照），否则 localStorage
    return idbGet(dataKey(cid)).then(function (idbSnap) {
      if (idbSnap) return { snapshot: idbSnap, version: idbSnap.version, nextSyncAt: (meta && meta.nextSyncAt) || idbSnap.nextSyncAt, fresh: fresh };
      var ls = null;
      try { ls = JSON.parse(localStorage.getItem(dataKey(cid)) || 'null'); } catch (_) {}
      if (ls) return { snapshot: ls, version: ls.version, nextSyncAt: (meta && meta.nextSyncAt) || ls.nextSyncAt, fresh: fresh };
      return { snapshot: null, version: (meta && meta.version) || 0, nextSyncAt: (meta && meta.nextSyncAt) || null, fresh: fresh };
    }).catch(function () {
      var ls = null;
      try { ls = JSON.parse(localStorage.getItem(dataKey(cid)) || 'null'); } catch (_) {}
      return { snapshot: ls, version: (meta && meta.version) || (ls && ls.version) || 0, nextSyncAt: (meta && meta.nextSyncAt) || null, fresh: fresh };
    });
  }

  /** 清除某比赛缓存（full sync 后也可保留；提供接口供诊断） */
  function clear(cid) {
    try { localStorage.removeItem(metaKey(cid)); localStorage.removeItem(dataKey(cid)); } catch (_) {}
    if (memCache.key === cid) { memCache.key = null; memCache.snapshot = null; memCache.size = 0; }
    return idbGet(dataKey(cid)).then(function () { return true; });
  }

  global.ScoreboardCache = { save: save, load: load, clear: clear, shouldUseIndexedDB: shouldUseIndexedDB };
})(window);
