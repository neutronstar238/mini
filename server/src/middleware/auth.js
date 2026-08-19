'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * JWT 解析中间件：从 Authorization: Bearer 或 cookie 中提取用户
 */
function authOptional(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (req.cookies && req.cookies.token);
  if (!token) return next();
  try {
    req.user = jwt.verify(token, config.jwtSecret);
  } catch (_) { /* 无效 token 视为未登录 */ }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  next();
}

/**
 * 角色守卫：requireRole('admin') / requireRole('admin', 'user')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

module.exports = { authOptional, requireLogin, requireRole };
