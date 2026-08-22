'use strict';

/**
 * Official Judge process sandbox.
 *
 * Production runs must use a transient systemd unit.  The explicit
 * `direct-test` mode exists only for local unit tests; it is rejected whenever
 * the process is marked production/required.  There is deliberately no
 * automatic fallback from systemd to an unsandboxed child process.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SYSTEMD_RUN = '/usr/bin/systemd-run';
const SYSTEMCTL = '/usr/bin/systemctl';
const SANDBOX_USER = 'nobody';
const SANDBOX_GROUP = 'nogroup';
const SANDBOX_UID = 65534;
const SANDBOX_GID = 65534;
const CONTAINER_WORKDIR = '/work';
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const DEFAULT_MEMORY_MB = 256;
const DEFAULT_MAX_PROCESSES = 64;

function isProductionRequired() {
  return process.env.NODE_ENV === 'production' ||
    process.env.APP_ENV === 'production' ||
    process.env.JUDGE_SANDBOX_REQUIRED === '1';
}

function requestedMode() {
  return String(process.env.JUDGE_SANDBOX_MODE || 'systemd').trim().toLowerCase();
}

function getSandboxStatus() {
  const mode = requestedMode();
  const required = isProductionRequired();

  if (mode === 'direct-test') {
    if (required) {
      return {
        available: false,
        mode,
        productionRequired: true,
        reason: 'direct-test sandbox is forbidden in production'
      };
    }
    return {
      available: true,
      mode,
      productionRequired: false,
      reason: null
    };
  }

  if (mode !== 'systemd') {
    return {
      available: false,
      mode,
      productionRequired: required,
      reason: `unsupported JUDGE_SANDBOX_MODE: ${mode || '(empty)'}`
    };
  }

  if (process.platform !== 'linux') {
    return {
      available: false,
      mode,
      productionRequired: required,
      reason: 'systemd sandbox requires Linux'
    };
  }

  try {
    fs.accessSync(SYSTEMD_RUN, fs.constants.X_OK);
  } catch (_) {
    return {
      available: false,
      mode,
      productionRequired: required,
      reason: `${SYSTEMD_RUN} is unavailable`
    };
  }

  return {
    available: true,
    mode,
    productionRequired: required,
    reason: null
  };
}

function safeEnvironment() {
  // Do not forward the application environment to user code.  In particular,
  // no JWT/HMAC/DB/API credentials or PM2 variables are inherited.
  if (process.platform === 'win32') {
    // Explicit direct-test mode is useful on Windows, where systemd is not
    // available.  Keep the same allowlist shape while retaining only the
    // platform's executable/temp paths needed by the test adapter.
    return {
      PATH: String(process.env.PATH || ''),
      HOME: 'C:\\Windows\\Temp',
      TEMP: String(process.env.TEMP || ''),
      TMP: String(process.env.TMP || ''),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8'
    };
  }
  return {
    PATH: SAFE_PATH,
    HOME: '/nonexistent',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp',
    JAVA_HOME: '/usr/lib/jvm/java-21-openjdk-amd64'
  };
}

function normalizeHostPath(value) {
  return path.resolve(String(value));
}

/** Map a host workdir path to the only path exposed inside the unit. */
function mapWorkPath(value, cwd) {
  if (typeof value !== 'string' || !cwd) return value;
  const base = normalizeHostPath(cwd);
  const candidate = normalizeHostPath(value);
  if (candidate === base) return CONTAINER_WORKDIR;
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (candidate.startsWith(prefix)) {
    const suffix = candidate.slice(prefix.length).split(path.sep).join('/');
    return `${CONTAINER_WORKDIR}/${suffix}`;
  }
  return value;
}

function unitName() {
  return `mini-oj-judge-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

function secondsFor(ms, floor = 1) {
  return Math.max(floor, Math.ceil(Number(ms || 1000) / 1000));
}

function memoryForMb(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : DEFAULT_MEMORY_MB;
}

function createSystemdArgs(command, args, options, unit) {
  const cwd = normalizeHostPath(options.cwd);
  const timeoutSec = secondsFor(options.timeoutMs, 1);
  const memoryMb = memoryForMb(options.memoryLimitMb);
  const maxProcesses = Math.max(8, Math.min(DEFAULT_MAX_PROCESSES, Number(options.maxProcesses) || DEFAULT_MAX_PROCESSES));
  const fileLimitMb = Math.max(16, Math.min(512, Number(options.maxFileMb) || 256));
  const mappedCommand = mapWorkPath(command, cwd);
  const mappedArgs = (args || []).map((arg) => mapWorkPath(arg, cwd));
  const properties = [
    `User=${SANDBOX_USER}`,
    `Group=${SANDBOX_GROUP}`,
    `WorkingDirectory=${CONTAINER_WORKDIR}`,
    `BindPaths=${cwd}:${CONTAINER_WORKDIR}`,
    'ReadWritePaths=/work',
    'PrivateNetwork=yes',
    'PrivateIPC=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectProc=invisible',
    'ProcSubset=pid',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'NoNewPrivileges=yes',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'RestrictNamespaces=yes',
    'RestrictSUIDSGID=yes',
    'RestrictRealtime=yes',
    'LockPersonality=yes',
    'KeyringMode=private',
    'SystemCallArchitectures=native',
    // Keep ordinary compiler/runtime calls available while denying syscall
    // families that enable kernel/module, mount, raw-I/O, namespace, or
    // privileged escape paths.
    'SystemCallFilter=~@debug @keyring @module @mount @obsolete @privileged @raw-io @reboot @swap',
    `RestrictAddressFamilies=AF_UNIX`,
    `MemoryMax=${memoryMb}M`,
    'MemorySwapMax=0',
    `TasksMax=${maxProcesses}`,
    `LimitNPROC=${maxProcesses}`,
    'LimitNOFILE=256',
    `LimitFSIZE=${fileLimitMb}M`,
    `LimitCPU=${timeoutSec}s`,
    `RuntimeMaxSec=${timeoutSec + 1}s`,
    'TimeoutStopSec=1s',
    'KillMode=mixed',
    'OOMPolicy=kill',
    'UMask=077',
    'Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'Environment=HOME=/nonexistent',
    'Environment=LANG=C.UTF-8',
    'Environment=LC_ALL=C.UTF-8',
    'Environment=TMPDIR=/tmp',
    'Environment=JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64',
    // The app and its deployment tree contain secrets/configuration.  They
    // are not needed by a compiler or executable and are hidden entirely.
    // ProtectHome covers /root and /home.  Keep this list limited to the
    // deployment tree: systemd itself needs parts of /run while setting up a
    // transient namespace, and hiding /run here makes the unit fail before
    // exec with EXIT_NAMESPACE on Ubuntu 24.04.
    'InaccessiblePaths=/www /var/www /run/docker.sock'
  ];
  const result = [
    '--unit', unit,
    '--wait',
    '--pipe',
    '--collect',
    '--quiet',
    '--service-type=exec'
  ];
  for (const property of properties) result.push('--property', property);
  // systemd-run resolves the service executable before applying BindPaths.
  // A compiled binary lives only in the bound /work directory, so invoke the
  // host-resident env helper and let it exec the mapped path inside the unit.
  if (mappedCommand !== command) {
    result.push('--', '/usr/bin/env', mappedCommand, ...mappedArgs);
  } else {
    result.push('--', mappedCommand, ...mappedArgs);
  }
  return result;
}

function killUnit(unit) {
  if (!unit) return;
  try {
    const killer = spawn(SYSTEMCTL, ['kill', '--kill-who=all', '--signal=SIGKILL', unit], {
      stdio: 'ignore',
      env: safeEnvironment()
    });
    killer.on('error', () => {});
  } catch (_) {
    // The RuntimeMaxSec unit limit remains as a second, independent cleanup
    // boundary if systemctl cannot be contacted during an already timed-out
    // child process.
  }
}

function runDirectTest(command, args, options) {
  return spawn(command, args, {
    cwd: options.cwd,
    env: safeEnvironment()
  });
}

/**
 * Spawn one compiler/runtime process under the selected sandbox.
 * Result shape intentionally matches the old runProc helper, with explicit
 * sandboxUnavailable/outputLimit flags for fail-closed handling by Judge.
 */
function runSandboxed(command, args, options = {}) {
  const status = getSandboxStatus();
  const baseResult = {
    ok: false,
    timedOut: false,
    killed: false,
    sandboxUnavailable: false,
    outputLimit: false,
    error: null,
    stdout: '',
    stderr: ''
  };
  if (!status.available) {
    return Promise.resolve({
      ...baseResult,
      sandboxUnavailable: true,
      error: `Judge sandbox unavailable: ${status.reason}`
    });
  }
  if (!options.cwd) {
    return Promise.resolve({
      ...baseResult,
      sandboxUnavailable: true,
      error: 'Judge sandbox requires an isolated working directory'
    });
  }

  const maxOutput = Math.max(1024, Number(options.maxOutput) || 4 * 1024 * 1024);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 10000);
  const unit = status.mode === 'systemd' ? unitName() : null;
  let child;
  try {
    if (status.mode === 'systemd') {
      child = spawn(SYSTEMD_RUN, createSystemdArgs(command, args, options, unit), {
        cwd: options.cwd,
        env: safeEnvironment()
      });
    } else {
      child = runDirectTest(command, args, options);
    }
  } catch (error) {
    return Promise.resolve({ ...baseResult, error: error.message });
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let outputLimit = false;
    let settled = false;
    const append = (current, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (current.length >= maxOutput) return { value: current, overflow: true };
      const remaining = maxOutput - current.length;
      return { value: current + text.slice(0, remaining), overflow: text.length > remaining };
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killed = true;
      if (unit) killUnit(unit);
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...baseResult,
        ...result,
        timedOut,
        killed,
        outputLimit,
        stdout,
        stderr
      });
    };
    if (child.stdout) child.stdout.on('data', (data) => {
      const next = append(stdout, data);
      stdout = next.value;
      if (next.overflow && !outputLimit) {
        outputLimit = true;
        killed = true;
        if (unit) killUnit(unit);
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    });
    if (child.stderr) child.stderr.on('data', (data) => {
      const next = append(stderr, data);
      stderr = next.value;
      if (next.overflow && !outputLimit) {
        outputLimit = true;
        killed = true;
        if (unit) killUnit(unit);
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }
    });
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (code, signal) => finish({ ok: true, code, signal }));
    const input = options.input == null ? '' : String(options.input);
    try { child.stdin.end(input); } catch (_) { /* ignore */ }
  });
}

/** Prepare a host directory that will be bind-mounted as /work. */
function prepareWorkDir(cwd) {
  const status = getSandboxStatus();
  if (!status.available) return { ok: false, error: status.reason };
  if (status.mode === 'direct-test') return { ok: true };
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return { ok: false, error: 'systemd sandbox requires a root process to chown the isolated workdir to nobody' };
  }
  try {
    fs.chmodSync(cwd, 0o700);
    fs.chownSync(cwd, SANDBOX_UID, SANDBOX_GID);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `cannot prepare isolated workdir: ${error.message}` };
  }
}

module.exports = {
  getSandboxStatus,
  isProductionRequired,
  mapWorkPath,
  prepareWorkDir,
  runSandboxed,
  safeEnvironment,
  SANDBOX_USER,
  SANDBOX_GROUP,
  CONTAINER_WORKDIR
};
