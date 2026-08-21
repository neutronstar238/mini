'use strict';
/**
 * SubmissionService —— 正式提交（Phase 4 主链路）
 *
 * 流程（严格顺序）：
 *   1. authenticate（由路由 requireLogin 完成）
 *   2. validate contest（存在 + 已开始 + 未结束）
 *   3. validate problem（存在 + 属于该 contest）
 *   4. validate language（allowlist c11/cpp11/python3）
 *   5. validate source（非空 / UTF-8 / 大小上限）
 *   6. check contest time（server_received_at 权威）
 *   7. check idempotency（UNIQUE(user_id, client_request_id)）
 *   8. rate limit（同用户 1 次/秒）
 *   9. generate server_received_at = server now()
 *  10. INSERT submission（短事务）
 *  11. dispatch judge（异步，事务外）
 *  12. return submissionId
 *
 * 错误码统一走 ApiError（见 middleware/api-error）。
 */
const config = require('../config');
const submissionRepo = require('../store/repositories/submission-repository');
const problemRepo = require('../store/repositories/problem-repository');
const contestRepo = require('../store/repositories/contest-repository');
const userRepo = require('../store/repositories/user-repository');
const judgeService = require('./judge-service');
const docDb = require('../store/db'); // 文档模式：按需补齐关系库用户
const { SUB_STATUS } = require('./submission-state');

/** 统一 API 错误（code 对应规范错误码） */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 校验比赛时间：未开始 / 已结束 拦截 */
function assertContestWindow(contest) {
  const now = Date.now();
  const startAt = contest.start_at ? new Date(contest.start_at).getTime() : 0;
  const endAt = contest.end_at ? new Date(contest.end_at).getTime() : Infinity;
  if (now < startAt) throw new ApiError(403, 'CONTEST_NOT_STARTED', '比赛还未开始');
  if (now > endAt) throw new ApiError(403, 'CONTEST_ENDED', '比赛已结束');
}

/**
 * 正式提交。
 * @param {object} payload { contestId, problemId, language, source, clientRequestId }
 * @param {string} userId
 * @returns {{submission:object, duplicate:boolean}}
 */
function submit(payload, userId) {
  const { contestId, problemId, language, source, clientRequestId } = payload || {};

  // 2. contest
  const contest = contestRepo.findById(contestId);
  if (!contest) throw new ApiError(404, 'CONTEST_NOT_FOUND', '比赛不存在');
  assertContestWindow(contest);

  // 3. problem
  const problem = problemRepo.findById(problemId);
  if (!problem || problem.contest_id !== contestId) throw new ApiError(404, 'PROBLEM_NOT_FOUND', '题目不存在');

  // 4. language allowlist（Runtime Enhancement Phase：同时校验 Admin 启停状态）
  if (!config.languages.includes(language)) {
    // 区分"语言不支持"与"Admin 已禁用"两种错误码
    const lp = require('../language-profiles');
    if (lp.PROFILES[language] && lp.PROFILES[language].submissionEnabled === false) {
      throw new ApiError(
        403,
        'LANGUAGE_PROFILE_PREVIEW_ONLY',
        '该语言当前仅开放 Browser Local Preview，正式提交尚未启用'
      );
    }
    if (lp.PROFILES[language] && lp.getEffectiveStatus(language) === 'DISABLED') {
      throw new ApiError(403, 'LANGUAGE_PROFILE_DISABLED', '该语言已被管理员禁用');
    }
    throw new ApiError(400, 'INVALID_LANGUAGE', '不支持的语言类型');
  }

  // 5. source 校验
  const sourceText = String(source || '');
  if (!sourceText.trim()) throw new ApiError(400, 'SOURCE_TOO_LARGE', '代码不能为空');
  if (config.sourceMaxUtf8 && !isValidUtf8(sourceText)) throw new ApiError(400, 'SOURCE_TOO_LARGE', '代码不是合法 UTF-8');
  if (Buffer.byteLength(sourceText, 'utf8') > config.maxCodeLength) {
    throw new ApiError(400, 'SOURCE_TOO_LARGE', '代码 UTF-8 大小超过 256 KiB 上限');
  }

  // 确保关系库存在该用户（与文档模式种子/注册并存过渡）
  const docUser = docDb.users.byId(userId);
  userRepo.ensureUser(docUser);

  // 7. idempotency（DB 级 UNIQUE 兜底；先查内存级避免多余写入）
  if (clientRequestId) {
    const existing = submissionRepo.findByIdempotent(userId, clientRequestId);
    if (existing) return { submission: existing, duplicate: true };
  }

  // 8. rate limit：同用户 1 次/秒
  const rl = submissionRepo.rateLimitCheck(userId);
  if (!rl.allowed) throw new ApiError(429, 'RATE_LIMITED', '提交过于频繁，请稍后再试');

  // 9. server_received_at 权威（服务器 now）
  const serverReceivedAt = new Date().toISOString();
  const createdAt = payload.clientSubmittedAt || serverReceivedAt; // 客户端时间仅作日志

  // 10. 短事务 INSERT + 幂等
  const inserted = submissionRepo.insert({
    contestId,
    problemId,
    userId,
    language,
    sourceCode: sourceText,
    createdAt,
    serverReceivedAt,
    clientRequestId: clientRequestId || null
  });

  if (inserted.duplicate) return { submission: inserted.submission, duplicate: true };

  const submission = inserted.submission;

  // 11. 异步评测（事务外）
  if (submission.status === SUB_STATUS.QUEUED) {
    judgeService.dispatch(submission);
  }

  return { submission, duplicate: false };
}

function isValidUtf8(text) {
  try {
    // Node 字符串已是 UTF-16；通过 Buffer 往返检测非法代理对/未配对代理
    const buf = Buffer.from(String(text), 'utf8');
    return buf.toString('utf8') === String(text);
  } catch (_) {
    return false;
  }
}

function notFound(id) {
  const s = submissionRepo.findById(id);
  if (!s) throw new ApiError(404, 'SUBMISSION_NOT_FOUND', '提交不存在');
  return s;
}

module.exports = { submit, notFound, ApiError };
