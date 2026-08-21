/*
 * Copyright (c) 2026 Mini-OJ contributors.
 * MIT License; see LICENSE. This adapter is not part of the OpenJDK binary.
 */
import createBrowserJDK from './browserjdk.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const baseUrl = new URL('./', import.meta.url);
const COMPILE_CACHE_CAPACITY = 8;
const CONFIGURED_MAXIMUM_MEMORY_BYTES = 512 * 1024 * 1024;
let moduleInstance;
let requestSequence = 1;
let responsePending = new Uint8Array();
let compileCacheSize = 0;

function buildFrame(opcode, requestId, className = '', source = '') {
  const classBytes = encoder.encode(className);
  const sourceBytes = encoder.encode(source);
  const bodySize = opcode === 2 ? 20 + classBytes.length + sourceBytes.length : 12;
  const bytes = new Uint8Array(4 + bodySize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bodySize, false);
  view.setUint32(4, 0x424a4f4a, false);
  view.setUint8(8, 1);
  view.setUint8(9, opcode);
  view.setUint16(10, 0, false);
  view.setUint32(12, requestId, false);
  if (opcode === 2) {
    view.setUint32(16, classBytes.length, false);
    view.setUint32(20, sourceBytes.length, false);
    bytes.set(classBytes, 24);
    bytes.set(sourceBytes, 24 + classBytes.length);
  }
  return bytes;
}

async function writeAll(functionName, bytes, timeoutMs = 120000) {
  let offset = 0;
  const deadline = performance.now() + timeoutMs;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 64 * 1024));
    const count = moduleInstance.ccall(functionName, 'number', ['array', 'number'], [chunk, chunk.length]);
    if (count < 0) throw new Error('INTERRUPTED');
    if (count === 0) {
      if (performance.now() >= deadline) throw new Error(functionName + ' ring write timeout');
      // A zero write is normal back-pressure while the CompileServer/program
      // drains the shared ring. Yield so the pthread can make progress.
      await new Promise(resolve => setTimeout(resolve, 0));
      continue;
    }
    offset += count;
  }
}

function readAvailable() {
  const available = moduleInstance.ccall('browserjdk_control_response_available', 'number', [], []);
  if (available <= 0) return new Uint8Array();
  const pointer = moduleInstance._malloc(available);
  try {
    const count = moduleInstance._browserjdk_control_response_read(pointer, available);
    return moduleInstance.HEAPU8.slice(pointer, pointer + Math.max(0, count));
  } finally {
    moduleInstance._free(pointer);
  }
}

async function readResponse(timeoutMs, interruptOnTimeout = false) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const chunk = readAvailable();
    if (chunk.length) {
      const joined = new Uint8Array(responsePending.length + chunk.length);
      joined.set(responsePending);
      joined.set(chunk, responsePending.length);
      responsePending = joined;
    }
    if (responsePending.length >= 4) {
      const expected = new DataView(responsePending.buffer, responsePending.byteOffset, 4).getUint32(0, false);
      if (expected < 1 || expected > 16 * 1024 * 1024) throw new Error('invalid BJOJ/1 response length ' + expected);
      if (responsePending.length >= expected + 4) {
        const payload = responsePending.slice(4, expected + 4);
        responsePending = responsePending.slice(expected + 4);
        return JSON.parse(decoder.decode(payload));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const state = moduleInstance.ccall('browserjdk_debug_state', 'number', [], []);
  if (interruptOnTimeout) {
    try { moduleInstance.ccall('browserjdk_request_interrupt', null, [], []); } catch (_) { /* best effort */ }
  }
  const error = new Error('LOCAL_TIMEOUT: BJOJ/1 response timeout after ' + timeoutMs
    + 'ms (native state ' + state + ', buffered ' + responsePending.length + ')');
  error.code = interruptOnTimeout ? 'LOCAL_TIMEOUT' : 'BJOJ_RESPONSE_TIMEOUT';
  error.timedOut = interruptOnTimeout;
  throw error;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function verifyAssets() {
  const response = await fetch(new URL('runtime-manifest.json', baseUrl), {cache: 'no-store'});
  if (!response.ok) throw new Error('BUILD_REQUIRED / NOT_READY: runtime-manifest.json missing');
  const manifest = await response.json();
  if (!Array.isArray(manifest.assets) || !manifest.assets.length) {
    throw new Error('BUILD_REQUIRED / NOT_READY: runtime asset manifest is empty');
  }
  for (const asset of manifest.assets) {
    if (asset.file === 'loader.mjs' || asset.file === 'runtime-manifest.json') continue;
    const assetResponse = await fetch(new URL(asset.file, baseUrl), {cache: 'force-cache'});
    if (!assetResponse.ok) throw new Error('BUILD_REQUIRED / NOT_READY: missing ' + asset.file);
    const body = await assetResponse.arrayBuffer();
    const actual = await sha256Hex(body);
    if (body.byteLength !== asset.bytes || actual !== asset.sha256) {
      throw new Error('BUILD_REQUIRED / NOT_READY: hash mismatch for ' + asset.file);
    }
  }
  if (manifest.runtimeId !== 'java21-browserjdk-compat-v2'
      || manifest.protocol !== 'BJOJ/1' || manifest.redistributable !== false) {
    throw new Error('BUILD_REQUIRED / NOT_READY: incompatible BrowserJDK manifest');
  }
  return manifest;
}

async function waitForNativeControl(timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (moduleInstance.ccall('browserjdk_runtime_stage', 'number', [], []) >= 5) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('BrowserJDK native control loop did not become ready');
}

export async function initialize(options = {}) {
  if (moduleInstance) return {javaVersion: options.javaVersion || '21', manifest: options.manifest || null};
  responsePending = new Uint8Array();
  compileCacheSize = 0;
  const manifest = await verifyAssets();
  moduleInstance = await createBrowserJDK({
    locateFile(path) { return new URL(path, baseUrl).href; },
    print(text) { if (options.onRuntimeStdout) options.onRuntimeStdout(String(text)); },
    printErr(text) { if (options.onRuntimeStderr) options.onRuntimeStderr(String(text)); }
  });
  await waitForNativeControl(options.bootTimeoutMs || 120000);
  const requestId = requestSequence++;
  await writeAll('browserjdk_control_write', buildFrame(1, requestId));
  const pong = await readResponse(options.bootTimeoutMs || 120000);
  if (pong.protocol !== 'BJOJ/1' || pong.requestId !== requestId || pong.verdict !== 'PONG') {
    throw new Error('BJOJ/1 PING failed');
  }
  compileCacheSize = Number(pong.cacheSize) || 0;
  return {javaVersion: pong.stdout, manifest};
}

export async function run({source, stdin = '', className = 'Main', timeoutMs = 10000}) {
  if (!moduleInstance) throw new Error('BUILD_REQUIRED / NOT_READY: BrowserJDK is not initialized');
  const requestId = requestSequence++;
  const classBytes = encoder.encode(className);
  const sourceBytes = encoder.encode(source);
  if (classBytes.length < 1 || classBytes.length > 4096 || sourceBytes.length > 12 * 1024 * 1024) {
    throw new Error('BJOJ/1 source dimensions exceed protocol limits');
  }
  moduleInstance.ccall('browserjdk_program_stdin_reset', null, [], []);
  await writeAll('browserjdk_control_write', buildFrame(2, requestId, className, source));
  await writeAll('browserjdk_program_stdin_write', encoder.encode(stdin));
  moduleInstance.ccall('browserjdk_program_stdin_close', null, [], []);
  const result = await readResponse(timeoutMs, true);
  if (result.protocol !== 'BJOJ/1' || result.requestId !== requestId) {
    throw new Error('BJOJ/1 request/response mismatch');
  }
  compileCacheSize = Number(result.cacheSize) || 0;
  return result;
}

export function interrupt() {
  if (moduleInstance) moduleInstance.ccall('browserjdk_request_interrupt', null, [], []);
}

/* Read-only diagnostics for memory-stress tooling.  These values describe
 * Emscripten linear memory, not JVM heap, JS heap, or renderer RSS. */
export function memoryStats() {
  const heap = moduleInstance && (moduleInstance.HEAP8 || moduleInstance.HEAPU8);
  const buffer = heap && heap.buffer;
  return {
    linearMemoryBytes: buffer ? buffer.byteLength : 0,
    configuredMaximumBytes: CONFIGURED_MAXIMUM_MEMORY_BYTES
  };
}

export function cacheStats() {
  return {size: compileCacheSize, capacity: COMPILE_CACHE_CAPACITY};
}

export async function dispose() {
  if (!moduleInstance) return;
  const requestId = requestSequence++;
  try {
    await writeAll('browserjdk_control_write', buildFrame(3, requestId));
    try { await readResponse(2000); } catch (_) { /* terminating worker is the fallback */ }
  } catch (_) {
    /* An interrupted ring rejects the shutdown frame; the worker can still
     * be terminated and the next run will instantiate a fresh module. */
  } finally {
    moduleInstance = undefined;
    responsePending = new Uint8Array();
    compileCacheSize = 0;
  }
}

export default {initialize, run, interrupt, dispose, memoryStats, cacheStats};
