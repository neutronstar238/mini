/* Phase 8 disposable WASI execution worker. Compiler state never lives here. */
import {WASI} from '/runtime/runno/0.10.0-ojc4/runno-wasi.js';

const ENGINE_RUNTIME_ID = 'cpp-modern-engine-v2';
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const BROWSER_CALL_STACK_LIMIT_MESSAGE = '浏览器本地运行触发 JavaScript 调用栈上限（Maximum call stack size exceeded），这不是程序 RE；请使用服务器判题。 Browser Local hit the JavaScript call-stack limit; this is not a program RE. Use server judging.';

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now();
}

function errorMessage(error) { return String(error && error.message || error || 'unknown error'); }
function isCallStackLimitError(error) { return /maximum call stack size exceeded/i.test(errorMessage(error)); }
function appendCoverageMessage(value, message) {
  const text = String(value || ''); return text.indexOf(message) >= 0 ? text : (text ? text + '\n' : '') + message;
}

function outputBuffer() { return {chunks: [], bytes: 0, truncated: false}; }

function appendOutput(buffer, value) {
  const bytes = new TextEncoder().encode(String(value == null ? '' : value));
  const remaining = MAX_OUTPUT_BYTES - buffer.bytes;
  if (remaining <= 0) { buffer.truncated = true; return; }
  const accepted = bytes.byteLength <= remaining ? bytes : bytes.subarray(0, remaining);
  buffer.chunks.push(accepted.slice());
  buffer.bytes += accepted.byteLength;
  if (accepted.byteLength !== bytes.byteLength) buffer.truncated = true;
}

function outputText(buffer) {
  const bytes = new Uint8Array(buffer.bytes);
  let offset = 0;
  for (const chunk of buffer.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function execute(message) {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const timing = {wasmCompileMs: 0, instantiateMs: 0, executionMs: 0};
  const artifact = message.bytes instanceof Uint8Array
    ? message.bytes : new Uint8Array(message.bytes || 0);
  const stdinBytes = new TextEncoder().encode(String(message.stdin || ''));
  if (stdinBytes.byteLength > MAX_STDIN_BYTES) {
    return {
      ok: false, runtimeId: ENGINE_RUNTIME_ID, compileStatus: 'PASS', runStatus: 'INPUT_LIMIT',
      exitCode: -1, stdout: '', stderr: 'stdin exceeds 4 MiB local limit',
      limitField: 'stdin', limitBytes: MAX_STDIN_BYTES, actualBytes: stdinBytes.byteLength,
      timedOut: false, aborted: false, outputTruncated: false, timing
    };
  }
  let stdinOffset = 0;
  const readStdin = length => {
    if (stdinOffset >= stdinBytes.byteLength) return null;
    const count = Math.min(Number(length) || stdinBytes.byteLength, stdinBytes.byteLength - stdinOffset);
    const chunk = new TextDecoder().decode(stdinBytes.subarray(stdinOffset, stdinOffset + count));
    stdinOffset += count;
    return chunk;
  };
  try {
    const compileStart = now();
    const module = await WebAssembly.compile(artifact);
    timing.wasmCompileMs = Math.round((now() - compileStart) * 10) / 10;
    const wasi = new WASI({
      fs: {}, args: message.args || ['program'], env: message.env || {}, stdin: readStdin,
      stdout: value => appendOutput(stdout, value), stderr: value => appendOutput(stderr, value)
    });
    const instantiateStart = now();
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    timing.instantiateMs = Math.round((now() - instantiateStart) * 10) / 10;
    const executionStart = now();
    const result = wasi.start({instance, module});
    timing.executionMs = Math.round((now() - executionStart) * 10) / 10;
    const truncatedFields = [];
    if (stdout.truncated) truncatedFields.push('stdout');
    if (stderr.truncated) truncatedFields.push('stderr');
    return {
      ok: result.exitCode === 0,
      runtimeId: ENGINE_RUNTIME_ID,
      compileStatus: 'PASS',
      runStatus: result.exitCode === 0 ? 'PASS' : 'RE',
      exitCode: result.exitCode,
      stdout: outputText(stdout), stderr: outputText(stderr),
      stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
      outputTruncated: truncatedFields.length > 0, outputTruncatedFields: truncatedFields,
      timedOut: false, aborted: false, timing, executionMs: timing.executionMs
    };
  } catch (error) {
    const text = errorMessage(error); const callStackLimit = isCallStackLimitError(error);
    const result = {
      ok: false, runtimeId: ENGINE_RUNTIME_ID, compileStatus: 'PASS', runStatus: callStackLimit ? 'LOCAL_UNSUPPORTED' : 'RE', exitCode: -1,
      stdout: outputText(stdout), stderr: callStackLimit ? appendCoverageMessage(outputText(stderr), BROWSER_CALL_STACK_LIMIT_MESSAGE) : outputText(stderr) || text,
      stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
      outputTruncated: stdout.truncated || stderr.truncated,
      outputTruncatedFields: [stdout.truncated ? 'stdout' : null, stderr.truncated ? 'stderr' : null].filter(Boolean),
      timedOut: false, aborted: false, error: text, timing, executionMs: 0
    };
    if (callStackLimit) Object.assign(result, {reason: 'BROWSER_CALL_STACK_LIMIT', coverageLimited: true, coverageMessage: BROWSER_CALL_STACK_LIMIT_MESSAGE});
    return result;
  }
}

self.addEventListener('message', async event => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    self.postMessage({type: 'cancelled', requestId: message.requestId, runtimeId: ENGINE_RUNTIME_ID});
    return;
  }
  if (message.type !== 'run') {
    self.postMessage({type: 'error', requestId: message.requestId, runtimeId: ENGINE_RUNTIME_ID,
      message: 'unknown execution worker message type'});
    return;
  }
  self.postMessage({type: 'run-result', requestId: message.requestId, result: await execute(message)});
});
