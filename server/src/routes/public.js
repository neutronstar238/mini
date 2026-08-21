'use strict';
/**
 * routes/public.js —— 公开免鉴权 Runtime/Compiler 信息 API（Runtime Enhancement Phase）
 *
 * 设计目标：
 *  - 安全：仅返回 sanitized 数据，不含 hidden test path / db path / secret / cookie / session / 命令注入细节。
 *  - 缓存：公共信息（编译器版本、命令格式），允许 HTTP 短缓存。
 *  - 一致性：与 FAQ 页、Runtime Info 页共用同一数据源（language-profiles.js）。
 *
 * 端点：
 *  GET /api/public/runtime-profiles           → 全量 language profiles（sanitized）
 *  GET /api/public/runtime-profiles/:id       → 单个 profile（id 非法 → 404）
 *  GET /api/public/faq                        → FAQ 数据（从 profiles 派生；与页同源）
 */
const express = require('express');
const lp = require('../language-profiles');

const router = express.Router();

/* 短缓存：公共信息，10s 边缘 + 60s 共享（FAQ / Runtime Info 页反复读） */
const PUBLIC_CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=10, s-maxage=60, stale-while-revalidate=300'
};

/**
 * GET /api/public/runtime-profiles
 * 返回所有 language profiles（sanitized，公开安全）。
 */
router.get('/runtime-profiles', (_req, res) => {
  res.set(PUBLIC_CACHE_HEADERS).json({
    profiles: lp.allSanitizedPublicProfiles(),
    generatedAt: new Date().toISOString()
  });
});

/**
 * GET /api/public/runtime-profiles/:id
 * 单个 profile（id 需存在于 PROFILE_ORDER）。
 */
router.get('/runtime-profiles/:id', (req, res) => {
  const id = req.params.id;
  const prof = lp.sanitizedPublicProfile(id);
  if (!prof) return res.status(404).json({ error: 'PROFILE_NOT_FOUND', message: `未找到 language profile: ${id}` });
  res.set(PUBLIC_CACHE_HEADERS).json({ profile: prof });
});

/**
 * GET /api/public/faq
 * FAQ 数据（与 Runtime Info 页同源）。当前项目原本没有 FAQ 内容（已审计确认），
 * 这里把"编译器版本与编译运行参数"一节与 language-profiles 统一渲染，避免双源维护。
 */
router.get('/faq', (_req, res) => {
  const profiles = lp.allSanitizedPublicProfiles();
  const faq = buildFaq(profiles);
  res.set(PUBLIC_CACHE_HEADERS).json({ faq, generatedAt: new Date().toISOString() });
});

/**
 * 由 profiles 派生 FAQ 内容。结构稳定，UI 直接消费。
 * 安全：命令经过 sanitizePublicCommand（去除 <src>/<out>/<in>/<configured> 等占位符）。
 */
function buildFaq(profiles) {
  const items = [];
  // 通用条目
  items.push({
    id: 'why-clang-browser',
    category: '架构',
    question: '为什么浏览器本地运行时使用 Clang 而不是 GCC？',
    answer:
      'Clang 本身主要使用 C++ 实现，但浏览器内运行的并非 Clang 源码，而是预先编译好的 clang.wasm。' +
      '本项目选择 Clang 是基于 WebAssembly 工程实现：LLVM/Clang 模块化程度高，Frontend/Linker/Target Backend 容易拆分，' +
      '且 WebAssembly/WASI 工具链生态成熟，能构建 Browser-hosted Compiler。Official Judge 不要求与 Browser 使用同一个编译器，' +
      '故服务器正式评测继续使用 GCC/G++ + Linux。两者通过 Compatibility Matrix 做行为验证。'
  });
  items.push({
    id: 'local-vs-official',
    category: '信任边界',
    question: '本地运行结果与正式评测结果为什么可能不一致？',
    answer:
      '本地运行仅用于"快速零安装自检"（自定义输入/公开样例/CE/RE/本地耗时），由浏览器 WebAssembly 运行时执行；' +
      '正式评测使用服务器 GCC/OpenJDK + Linux，对隐藏测试点生成唯一有效的 Official Verdict。' +
      '本地与正式编译器不同是合理设计，最终结果以服务器评测为准。'
  });
  items.push({
    id: 'source-privacy',
    category: '隐私',
    question: '本地运行会上传源码吗？',
    answer:
      '首次使用可能从服务器下载并缓存静态运行环境；Runtime Ready 后，本地运行过程中源码、自定义输入及本地执行结果不发送至判题服务器。' +
      '仅当用户点击"正式提交"时，源码才会发送至服务器进行隐藏测试评测。'
  });

  // 每个语言一条 FAQ（FAQ 动态化，与 language-profiles 同源）
  for (const p of profiles) {
    const local = p.localRuntime;
    const off = p.officialJudge;
    if (off.supported) {
      items.push({
        id: `lang-${p.id}-official`,
        category: '编译运行参数',
        question: `${p.displayName} 正式评测使用什么编译器？编译参数是什么？`,
        answer:
          `正式评测环境：${off.compiler || '-'} ${off.compilerVersion || '-'}（${off.os || '-'}）。\n` +
          `编译标准：${off.standard || '-'}。\n` +
          `编译 flags：${formatFlags(off.compileFlags)}。\n` +
          `运行 flags：${formatFlags(off.runFlags)}。\n` +
          `本数据由 Language Profile 单一数据源渲染，Admin 修改正式评测 Profile 后会自动反映。`
      });
    }
    if (local.supported) {
      items.push({
        id: `lang-${p.id}-local`,
        category: '编译运行参数',
        question: `${p.displayName} 本地浏览器运行时是什么？`,
        answer:
          `本地运行时：${local.compiler || '-'} ${local.compilerVersion || '-'}，Target=${local.target || '-'}，` +
          `PCH 策略=${local.pchPolicy || '-'}，Runtime ID=${local.runtimeId || '-'}。\n` +
          `Browser Local 与 Official Judge 并非同一编译器，仅作快速零安装自检，正式结果以服务器评测为准。`
      });
    } else {
      items.push({
        id: `lang-${p.id}-local`,
        category: '编译运行参数',
        question: `${p.displayName} 本地浏览器运行时是否可用？`,
        answer: `当前状态：${p.status}。Browser Local Runtime 暂未启用或正在评估，正式评测仍由服务器 ${off.compiler || ''} 完成。`
      });
    }
  }

  return items;
}

function formatFlags(flags) {
  if (!flags || !flags.length) return '（无）';
  return flags.join(' ');
}

module.exports = router;