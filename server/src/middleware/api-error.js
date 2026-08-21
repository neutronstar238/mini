'use strict';
/**
 * 统一 API 错误处理（Phase 4 主链路）
 * 所有 route 抛出的 ApiError / 未知错误 → { error: { code, message } }
 * 不向前端返回 SQLite stack / 内部实现细节。
 */
const { ApiError } = require('../services/submission-service');

function apiErrorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error('[api-error]', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
}

/** 404 兜底 */
function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
}

module.exports = { apiErrorHandler, notFoundHandler };
