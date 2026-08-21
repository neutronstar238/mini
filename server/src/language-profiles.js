'use strict';
/**
 * language-profiles.js —— 全量 LanguageProfile 单一数据源（Runtime Enhancement Phase）
 *
 * 职责：
 *  - 聚合"冻结 Browser Runtime"与"现代新增 Profile"，统一描述每门语言的两套环境：
 *      * localRuntime  (Browser Local: Clang/WASI / Pyodide / OpenJDK-WASM)
 *      * officialJudge (Server: GCC/G++/CPython/OpenJDK，唯一正式判定)
 *  - 覆盖 c11/c17/cpp11/cpp17/cpp20/cpp23/python3/java21
 *  - config.languages / config.languageProfiles 由此派生（向后兼容 c11/cpp11/python3）
 *  - 提供 sanitizedPublicProfile()，供 /api/public/runtime-profiles 安全返回
 *
 * 安全边界（关键）：
 *  - 本文件只含编译/运行命令与公开元数据；
 *  - 绝不包含 hidden test path / db path / secret / cookie / session；
 *  - 对外暴露命令一律经 sanitizeOfficialCommand()（仅公开参数），不做命令注入拼接。
 *
 * 冻结隔离：c11/cpp11/python3 的 runtimeId/标准/命令照抄冻结 manifest，禁止改动。
 */

/* ==================== 单语言 Profile 构造 ==================== */

function profile(opts) {
  const id = opts.id;
  const language = opts.language || id;
  const displayName = opts.displayName || language.toUpperCase();
  const status = opts.status || 'ENABLED';
  const local = opts.localRuntime || {};
  const off = opts.officialJudge || {};
  return {
    id,
    language,
    displayName,
    status,
    submissionEnabled: opts.submissionEnabled === true ||
      (opts.submissionEnabled !== false && ['ENABLED', 'BETA', 'BETA_FROZEN', 'STABLE', 'FROZEN'].includes(status)),
    localRuntime: {
      supported: !!local.supported,
      enabled: local.enabled !== false && !!local.supported,
      preview: !!local.preview,
      technicalValidated: local.technicalValidated === true,
      engineeringRedistributionReady: local.engineeringRedistributionReady === true,
      legalReviewRequired: local.legalReviewRequired === true,
      redistributable: local.redistributable === true,
      runtimeId: local.runtimeId || null,
      compiler: local.compiler || null,
      compilerVersion: local.compilerVersion || null,
      standard: local.standard || null,
      target: local.target || null,
      sysrootVersion: local.sysrootVersion || null,
      assetHash: local.assetHash || null,
      pchPolicy: local.pchPolicy || 'none',
      // 前端加载/缓存/运行元数据（供 Runtime Manager）
      assets: local.assets || null,
      workerUrl: local.workerUrl || null,
      preloadDefault: !!local.preloadDefault,
      status: local.status || (local.supported ? 'READY' : 'UNAVAILABLE')
    },
    officialJudge: {
      supported: !!off.supported,
      referenceStatus: off.referenceStatus || (off.supported ? 'READY' : 'PENDING'),
      compiler: off.compiler || null,
      compilerVersion: off.compilerVersion || null,
      standard: off.standard || null,
      compileCommand: sanitizeCommand(off.compileCommand),
      runCommand: sanitizeCommand(off.runCommand),
      timeAdjustment: off.timeAdjustment != null ? off.timeAdjustment : 1.0,
      memoryAdjustment: off.memoryAdjustment != null ? off.memoryAdjustment : 1.0,
      os: off.os || null
    }
  };
}

/** 仅保留命令数组的浅拷贝（内部使用时保留原始结构；对外时由 sanitizedPublicProfile 过滤） */
function sanitizeCommand(cmds) {
  if (!cmds) return [];
  return Array.isArray(cmds) ? cmds.slice() : [String(cmds)];
}

/* ==================== 冻结 Runtime（照抄 manifest，禁止改动） ==================== */

/* ---------------- c11-gcc11-compat-v3 (FINAL FROZEN) ---------------- */
const c11 = profile({
  id: 'c11',
  displayName: 'C11',
  status: 'ENABLED',
  localRuntime: {
    supported: true,
    runtimeId: 'c11-gcc11-compat-v3',
    compiler: 'Clang',
    compilerVersion: 'Clang 8.0.1',
    standard: 'c11',
    target: 'wasm32-unknown-wasi',
    sysrootVersion: 'clang-fs.tar.gz (WASI libc, musl-based)',
    assetHash: 'B2E4B0F28A2C56B80CA43B61DC1CA2B62B8263B582735504E6C376FED4B1F363',
    pchPolicy: 'none',
    status: 'READY',
    preloadDefault: false
  },
  officialJudge: {
    supported: true,
    compiler: 'GCC (gcc-11)',
    compilerVersion: 'Ubuntu 11.5.0-1ubuntu1~24.04.1',
    standard: 'c11',
    compileCommand: ['gcc-11', '-O2', '-std=c11', '<src>', '-lm', '-o', '<out>'],
    runCommand: ['<out>', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ---------------- cpp11-gcc11-compat-v4 (FROZEN) ---------------- */
const cpp11 = profile({
  id: 'cpp11',
  displayName: 'C++11',
  status: 'ENABLED',
  localRuntime: {
    supported: true,
    runtimeId: 'cpp11-gcc11-compat-v4',
    compiler: 'Clang',
    compilerVersion: 'Clang 8.0.1',
    standard: 'c++11',
    target: 'wasm32-unknown-wasi',
    sysrootVersion: 'clang-fs.tar.gz (WASI libc + libc++)',
    assetHash: 'B2E4B0F28A2C56B80CA43B61DC1CA2B62B8263B582735504E6C376FED4B1F363',
    pchPolicy: 'explicit-bits-only',
    status: 'READY',
    preloadDefault: false
  },
  officialJudge: {
    supported: true,
    compiler: 'G++ (g++-11)',
    compilerVersion: 'Ubuntu 11.5.0-1ubuntu1~24.04.1',
    standard: 'c++11',
    compileCommand: ['g++-11', '-O2', '-std=c++11', '<src>', '-o', '<out>'],
    runCommand: ['<out>', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ---------------- py312-cpython-compat-v1 (FROZEN) ---------------- */
const python3 = profile({
  id: 'python3',
  displayName: 'Python 3.12',
  status: 'ENABLED',
  localRuntime: {
    supported: true,
    runtimeId: 'py312-cpython-compat-v1',
    compiler: 'Pyodide / CPython',
    compilerVersion: 'CPython 3.12.1 (Pyodide 0.26.4)',
    standard: 'python3',
    target: 'wasm32-emscripten',
    sysrootVersion: 'python_stdlib.zip',
    assetHash: '17E09D0EF8C89EF403F8DB7F34AACFE323A271D624F6CF1C4C9D1CB43B38922B',
    pchPolicy: 'none',
    status: 'READY',
    preloadDefault: false
  },
  officialJudge: {
    supported: true,
    compiler: 'CPython',
    compilerVersion: '3.12.3',
    standard: 'python3',
    compileCommand: [], // 解释型：无编译
    runCommand: ['python3', '<src>.py', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ==================== 现代新增 Profile（独立 Runtime ID，不覆盖冻结） ==================== */

/* ---------------- c17-gcc14-compat-v1 ---------------- */
const c17 = profile({
  id: 'c17',
  displayName: 'C17 🧪 Local Preview',
  status: 'EXPERIMENTAL',
  submissionEnabled: false,
  localRuntime: {
    supported: true,
    enabled: true,
    preview: true,
    runtimeId: 'c17-gcc14-compat-v1',
    compiler: 'Clang',
    compilerVersion: 'Clang 19.1.7 (browser WASM)',
    standard: 'c17',
    target: 'wasm32-unknown-wasi',
    sysrootVersion: 'cpp-modern-engine-v1 sysroot',
    assetHash: '25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c',
    pchPolicy: 'none',
    status: 'LOCAL_PREVIEW'
  },
  officialJudge: {
    supported: true,
    referenceStatus: 'GCC14_REFERENCE_READY',
    compiler: 'GCC (gcc-14)',
    compilerVersion: 'GCC 14.2.0 reference (Formal Submit disabled)',
    standard: 'c17',
    compileCommand: ['gcc-14', '-O2', '-std=c17', '<src>', '-lm', '-o', '<out>'],
    runCommand: ['<out>', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ---------------- cpp17-gcc14-compat-v1 ---------------- */
const cpp17 = profile({
  id: 'cpp17',
  displayName: 'C++17 🧪 Local Preview',
  status: 'EXPERIMENTAL',
  submissionEnabled: false,
  localRuntime: {
    supported: true,
    enabled: true,
    preview: true,
    runtimeId: 'cpp17-gcc14-compat-v1',
    compiler: 'Clang',
    compilerVersion: 'Clang 19.1.7 (browser WASM)',
    standard: 'c++17',
    target: 'wasm32-unknown-wasi',
    sysrootVersion: 'cpp-modern-engine-v1 sysroot',
    assetHash: '25433ade343cb3e2e3a3255c5a26ffc600b659d26d296749c33ac34d1afaff3c',
    pchPolicy: 'none',
    status: 'LOCAL_PREVIEW',
    preloadDefault: false
  },
  officialJudge: {
    supported: true,
    referenceStatus: 'GCC14_REFERENCE_READY',
    compiler: 'G++ (g++-14)',
    compilerVersion: 'GCC 14.2.0 reference (Formal Submit disabled)',
    standard: 'c++17',
    compileCommand: ['g++-14', '-O2', '-std=c++17', '<src>', '-o', '<out>'],
    runCommand: ['<out>', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ---------------- cpp20-gcc14-compat-v1 ---------------- */
const cpp20 = profile({
  id: 'cpp20',
  displayName: 'C++20',
  status: 'PENDING',
  submissionEnabled: false,
  localRuntime: {
    supported: false,
    enabled: false,
    runtimeId: 'cpp20-gcc14-compat-v1',
    compiler: 'Clang',
    compilerVersion: 'Modern Clang (wasm32-wasi)',
    standard: 'c++20',
    target: 'wasm32-unknown-wasi',
    sysrootVersion: 'cpp-modern-engine-v1 sysroot',
    assetHash: 'PENDING-MODERN-CLANG',
    pchPolicy: 'none',
    status: 'PENDING'
  },
  officialJudge: {
    supported: false,
    referenceStatus: 'PENDING',
    compiler: 'G++ (g++-14)',
    compilerVersion: 'GCC 14.2.0 reference (not activated)',
    standard: 'c++20',
    compileCommand: ['g++-14', '-O2', '-std=c++20', '<src>', '-o', '<out>'],
    runCommand: ['<out>', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ---------------- cpp23-gcc14-compat-v1 ---------------- */
const cpp23 = profile({
  id: 'cpp23',
  displayName: 'C++23',
  status: 'PENDING',
  submissionEnabled: false,
  localRuntime: {
    supported: false,
    enabled: false,
    runtimeId: 'cpp23-gcc14-compat-v1',
    compiler: 'Clang',
    compilerVersion: 'Modern Clang (wasm32-wasi)',
    standard: 'c++23',
    target: 'wasm32-unknown-wasi',
    sysrootVersion: 'cpp-modern-engine-v1 sysroot',
    assetHash: 'PENDING-MODERN-CLANG',
    pchPolicy: 'none',
    status: 'PENDING'
  },
  officialJudge: {
    supported: false,
    referenceStatus: 'PENDING',
    compiler: 'G++ (g++-14)',
    compilerVersion: 'GCC 14.2.0 reference (not activated)',
    standard: 'c++23',
    compileCommand: ['g++-14', '-O2', '-std=c++23', '<src>', '-o', '<out>'],
    runCommand: ['<out>', '<', '<in>'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ---------------- java21 (Phase 8：browserjdk-oj BETA_FROZEN / legal review pending) ---------------- */
const java21 = profile({
  id: 'java21',
  displayName: 'Java 21',
  status: 'BETA_FROZEN',
  submissionEnabled: true,
  localRuntime: {
    supported: true,                       // Phase 6 Worker 已实现
    runtimeId: 'java21-browserjdk-compat-v2',
    compiler: 'OpenJDK 21u (Zero interpreter, WASM via Emscripten)',
    compilerVersion: 'OpenJDK 21.0.10+7 / browserjdk-oj self-built',
    standard: 'java21',
    target: 'wasm32 (OpenJDK-WASM)',
    sysrootVersion: 'browserjdk-oj (OpenJDK 21u + Emscripten + libffi)',
    assetHash: 'eee8298d267c2ba781cc6db4d587e6a8a2a39ff8aac5692f1c3a3d01daee5878',
    pchPolicy: 'none',
    // Phase 7 Checkpoint 2：自建 v2 runtime 已通过 cache/isolation/timeout、
    // corpus、Chrome E2E、network isolation、memory stress 与工程再分发门禁。
    // 法律/项目负责人审核前仍保持 redistributable=false。
    status: 'BETA_FROZEN',
    technicalValidated: true,
    engineeringRedistributionReady: true,
    legalReviewRequired: true,
    redistributable: false,
    preloadDefault: false
  },
  officialJudge: {
    supported: true,
    referenceStatus: 'OpenJDK 21 Stable',
    compiler: 'OpenJDK (javac/java)',
    compilerVersion: 'OpenJDK 21.x',
    standard: 'java21',
    compileCommand: ['javac', '-J-Xms1024M', '-J-Xmx1024M', '-J-Xss64M', '-encoding', 'UTF-8', 'Main.java'],
    runCommand: ['java', '-Dfile.encoding=UTF-8', '-XX:+UseSerialGC', '-Xss64M', '-Xms1024M', '-Xmx<configured>', '-cp', '.', 'Main'],
    timeAdjustment: 1.0,
    memoryAdjustment: 1.0,
    os: 'Ubuntu 24.04 LTS'
  }
});

/* ==================== 聚合与派生 ==================== */

/** 全量 profile（内部使用，含命令详情） */
const PROFILES = {
  c11,
  c17,
  cpp11,
  cpp17,
  cpp20,
  cpp23,
  python3,
  java21
};

/** 顺序列表（UI / API 展示顺序） */
const PROFILE_ORDER = ['c11', 'c17', 'cpp11', 'cpp17', 'cpp20', 'cpp23', 'python3', 'java21'];

function stateAllowsSubmission(status) {
  return ['ENABLED', 'BETA', 'BETA_FROZEN', 'STABLE', 'FROZEN'].includes(status);
}

/** 派生的正式语言 allowlist。PENDING/EXPERIMENTAL/DISABLED 永不进入正式提交 allowlist。 */
const enabledOfficialLanguages = () =>
  PROFILE_ORDER.filter((id) => {
    const p = PROFILES[id];
    if (!p || !p.officialJudge.supported || !p.submissionEnabled) return false;
    return stateAllowsSubmission(getEffectiveStatus(id));
  });

/**
 * 返回 { id, language, serverLabel, browserRuntimeId } 兼容结构（config.languageProfiles 原形态）。
 * 仅供 config.js 向后兼容派生，不承担命令字段。
 */
function legacyLanguageProfiles() {
  const out = {};
  for (const id of PROFILE_ORDER) {
    const p = PROFILES[id];
    out[id] = {
      serverLabel: p.officialJudge.compiler ? (p.officialJudge.compiler + ' ' + p.officialJudge.standard) : p.displayName,
      browserRuntimeId: p.localRuntime.runtimeId
    };
  }
  return out;
}

/**
 * sanitized public profile（/api/public/runtime-profiles 安全返回）
 * 只含公开信息，不含 hidden test / db path / secret / cookie / session。
 */
function sanitizedPublicProfile(id) {
  const p = PROFILES[id];
  if (!p) return null;
  const effectiveStatus = getEffectiveStatus(id);
  const localStatus = overrideStatus.has(id) ? effectiveStatus : p.localRuntime.status;
  return {
    id: p.id,
    language: p.language,
    displayName: p.displayName,
    status: effectiveStatus,
    submissionEnabled: p.submissionEnabled,
    localRuntime: {
      supported: p.localRuntime.supported,
      enabled: p.localRuntime.enabled,
      preview: p.localRuntime.preview,
      technicalValidated: p.localRuntime.technicalValidated,
      engineeringRedistributionReady: p.localRuntime.engineeringRedistributionReady,
      legalReviewRequired: p.localRuntime.legalReviewRequired,
      redistributable: p.localRuntime.redistributable,
      runtimeId: p.localRuntime.runtimeId,
      compiler: p.localRuntime.compiler,
      compilerVersion: p.localRuntime.compilerVersion,
      standard: p.localRuntime.standard,
      target: p.localRuntime.target,
      sysrootVersion: p.localRuntime.sysrootVersion,
      assetHash: p.localRuntime.assetHash,
      pchPolicy: p.localRuntime.pchPolicy,
      status: localStatus
    },
    officialJudge: {
      supported: p.officialJudge.supported,
      referenceStatus: p.officialJudge.referenceStatus,
      compiler: p.officialJudge.compiler,
      compilerVersion: p.officialJudge.compilerVersion,
      standard: p.officialJudge.standard,
      compileFlags: p.officialJudge.compileCommand.filter((a) => !a.startsWith('<') && !a.endsWith('>')),
      runFlags: p.officialJudge.runCommand.filter((a) => !a.startsWith('<') && !a.endsWith('>')),
      timeAdjustment: p.officialJudge.timeAdjustment,
      memoryAdjustment: p.officialJudge.memoryAdjustment,
      os: p.officialJudge.os
    }
  };
}

function allSanitizedPublicProfiles() {
  return PROFILE_ORDER.map(sanitizedPublicProfile).filter(Boolean);
}

/**
 * Admin 启停控制遵循 PENDING → EXPERIMENTAL/LOCAL_PREVIEW → BETA → STABLE/FROZEN。
 * 写入仅内存态（本轮无持久化 DB；重启恢复代码默认值）。
 */
const overrideStatus = new Map();

function setStatus(id, status) {
  if (!PROFILES[id]) return false;
  if (!['PENDING', 'EXPERIMENTAL', 'LOCAL_PREVIEW', 'BETA', 'BETA_FROZEN', 'STABLE', 'FROZEN', 'ENABLED', 'DISABLED'].includes(status)) return false;
  overrideStatus.set(id, status);
  return true;
}
function getEffectiveStatus(id) {
  return overrideStatus.has(id) ? overrideStatus.get(id) : (PROFILES[id] ? PROFILES[id].status : null);
}
function isOfficialEnabled(id) {
  const p = PROFILES[id];
  if (!p) return false;
  return stateAllowsSubmission(getEffectiveStatus(id)) && p.officialJudge.supported && p.submissionEnabled;
}

module.exports = {
  PROFILES,
  PROFILE_ORDER,
  enabledOfficialLanguages,
  legacyLanguageProfiles,
  sanitizedPublicProfile,
  allSanitizedPublicProfiles,
  setStatus,
  getEffectiveStatus,
  isOfficialEnabled,
  profile
};
