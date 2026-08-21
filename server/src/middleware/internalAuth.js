'use strict';
/**
 * :3001 内部管理 API 鉴权
 * - :3002 Admin 服务通过 HTTP 调用 :3001 /internal/admin/*
 * - 使用共享内部密钥（INTERNAL_API_SECRET）鉴权，避免依赖用户 JWT
 * - 生产环境必须通过环境变量注入强密钥
 */
const crypto = require('crypto');
const config = require('../config');

function internalAuth(req, res, next) {
  const secret = config.internalApiSecret;
  // 请求头 X-Internal-Token = HMAC-SHA256(secret, timestamp + path)
  const token = req.headers['x-internal-token'];
  const ts = req.headers['x-internal-ts'];
  if (!token || !ts) return res.status(401).json({ error: '缺少内部鉴权头' });
  const now = Date.now();
  if (Math.abs(now - Number(ts)) > 60 * 1000) return res.status(401).json({ error: '内部令牌时间戳过期' });
  // 注意：router 挂载在 /internal/admin 下时 req.path 是相对路径，需用 originalUrl
  const fullPath = req.originalUrl.split('?')[0];
  const expect = crypto.createHmac('sha256', secret)
    .update(`${ts}:${fullPath}`)
    .digest('hex');
  const a = Buffer.from(token);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: '内部令牌无效' });
  }
  next();
}

module.exports = { internalAuth };
