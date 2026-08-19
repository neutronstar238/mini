'use strict';
/** 极简 HTTP/HTTPS 客户端（零依赖） */
const https = require('https');
const http = require('http');

function request(method, url, { body, headers = {}, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method,
      headers: Object.assign({
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        'User-Agent': 'mini-oj-worker/1.0'
      }, headers),
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
module.exports = { request };
