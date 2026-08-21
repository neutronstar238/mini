'use strict';
const http = require('http');
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: 3001, path: '/contest/login', timeout: 4000 }, (res) => {
      res.resume(); res.on('end', () => resolve('OK:' + res.statusCode));
    });
    req.on('timeout', () => { req.destroy(); resolve('TIMEOUT'); });
    req.on('error', (e) => resolve('ERR:' + e.code));
  });
}
(async () => {
  for (let i = 1; i <= 12; i++) {
    const r = await probe();
    const t = new Date().toISOString().slice(11, 19);
    console.log('#' + i + ' [' + t + '] ' + r);
    await new Promise((res) => setTimeout(res, 5000));
  }
})();
