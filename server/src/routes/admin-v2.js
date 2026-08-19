'use strict';
/**
 * 管理端（admin）API —— 运行于 :3002
 * 不直连 SQLite、不创建 Scheduler、不维护 Worker SSE。
 * 所有管理操作通过 HTTP 调用 :3001 的 internal admin API（/internal/admin/*）。
 * 用户 JWT 仅用于判定管理员身份；:3001 侧用 INTERNAL_API_SECRET 鉴权。
 */
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { requireLogin, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireRole('admin'));

/** 调用 :3001 internal API（HMAC 内部鉴权） */
async function callCore(method, path, body) {
  const ts = String(Date.now());
  const token = crypto.createHmac('sha256', config.internalApiSecret)
    .update(`${ts}:${path}`)
    .digest('hex');
  const res = await fetch(config.coreBaseUrl + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': token,
      'X-Internal-Ts': ts
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** 包装：统一错误处理 */
function wrap(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      res.status(502).json({ error: '管理操作失败（OJ Core 不可达?）: ' + err.message });
    });
  };
}

router.get('/overview', wrap(async (_req, res) => {
  const r = await callCore('GET', '/internal/admin/overview');
  res.status(r.status).json(r.data);
}));

router.get('/nodes', wrap(async (_req, res) => {
  const r = await callCore('GET', '/internal/admin/nodes');
  res.status(r.status).json(r.data);
}));
router.post('/nodes/:id/tier', wrap(async (req, res) => {
  const r = await callCore('POST', `/internal/admin/nodes/${req.params.id}/tier`, req.body);
  res.status(r.status).json(r.data);
}));
router.post('/nodes/:id/approve', wrap(async (req, res) => {
  const r = await callCore('POST', `/internal/admin/nodes/${req.params.id}/approve`, req.body);
  res.status(r.status).json(r.data);
}));
router.post('/nodes/:id/suspend', wrap(async (req, res) => {
  const r = await callCore('POST', `/internal/admin/nodes/${req.params.id}/suspend`, req.body);
  res.status(r.status).json(r.data);
}));

router.get('/certs', wrap(async (_req, res) => {
  const r = await callCore('GET', '/internal/admin/certs');
  res.status(r.status).json(r.data);
}));
router.post('/certs', wrap(async (_req, res) => {
  const r = await callCore('POST', '/internal/admin/certs');
  res.status(r.status).json(r.data);
}));

router.get('/queue', wrap(async (_req, res) => {
  const r = await callCore('GET', '/internal/admin/queue');
  res.status(r.status).json(r.data);
}));
router.get('/audit', wrap(async (_req, res) => {
  const r = await callCore('GET', '/internal/admin/audit');
  res.status(r.status).json(r.data);
}));

router.get('/problems', wrap(async (_req, res) => {
  const r = await callCore('GET', '/internal/admin/problems');
  res.status(r.status).json(r.data);
}));
router.get('/problems/:id', wrap(async (req, res) => {
  const r = await callCore('GET', `/internal/admin/problems/${req.params.id}`);
  res.status(r.status).json(r.data);
}));
router.post('/problems', wrap(async (req, res) => {
  const r = await callCore('POST', '/internal/admin/problems', req.body);
  res.status(r.status).json(r.data);
}));
router.put('/problems/:id', wrap(async (req, res) => {
  const r = await callCore('PUT', `/internal/admin/problems/${req.params.id}`, req.body);
  res.status(r.status).json(r.data);
}));
router.delete('/problems/:id', wrap(async (req, res) => {
  const r = await callCore('DELETE', `/internal/admin/problems/${req.params.id}`);
  res.status(r.status).json(r.data);
}));

// 重判：必须调用 :3001 internal API（由 :3001 创建新 attempt 并调度）
router.post('/rejudge', wrap(async (req, res) => {
  const { submissionId } = req.body || {};
  if (!submissionId) return res.status(400).json({ error: '缺少 submissionId' });
  const r = await callCore('POST', `/internal/admin/rejudge/${submissionId}`);
  res.status(r.status).json(r.data);
}));

router.post('/spotcheck', wrap(async (req, res) => {
  const { submissionId } = req.body || {};
  if (!submissionId) return res.status(400).json({ error: '缺少 submissionId' });
  const r = await callCore('POST', `/internal/admin/spotcheck/${submissionId}`);
  res.status(r.status).json(r.data);
}));

/* ================= 管理端 SSE 监控（桥接 :3001 internal 事件流） ================= */
// :3002 连接 :3001 的 internal SSE，转发给 admin 浏览器（fan-out）
const coreEventClients = new Set();
let coreSse = null;

function connectCoreEvents() {
  if (coreSse) return;
  const path = '/internal/admin/events';
  const ts = String(Date.now());
  const token = crypto.createHmac('sha256', config.internalApiSecret).update(`${ts}:${path}`).digest('hex');
  const url = `${config.coreBaseUrl}${path}?token=${token}&ts=${ts}`;
  const es = new (require('events').EventEmitter)();
  coreSse = es;

  // 简单 SSE 客户端（基于 http）
  const http = require(config.coreBaseUrl.startsWith('https') ? 'https' : 'http');
  const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    let buf = '', event = 'message';
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const lines = block.split('\n');
        const dataLines = [];
        for (const l of lines) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          else if (l.startsWith('data: ')) dataLines.push(l.slice(6));
        }
        if (dataLines.length) {
          let data = null; try { data = JSON.parse(dataLines.join('\n')); } catch (_) {}
          for (const c of coreEventClients) {
            try { c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
          }
        }
        event = 'message';
      }
    });
    res.on('end', () => { coreSse = null; setTimeout(connectCoreEvents, 5000); });
    res.on('error', () => { coreSse = null; setTimeout(connectCoreEvents, 5000); });
  });
  req.on('error', () => { coreSse = null; setTimeout(connectCoreEvents, 5000); });
}

router.get('/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  coreEventClients.add(res);
  connectCoreEvents();
  res.on('close', () => coreEventClients.delete(res));
});

module.exports = router;
