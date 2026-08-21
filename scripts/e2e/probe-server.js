'use strict';
const http = require('http');
function probe(host, port, path) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path, timeout: 5000 }, (res) => {
      let n = 0; res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', bytes: 0 }); });
    req.on('error', (e) => resolve({ status: 'ERR:' + e.code, bytes: 0 }));
  });
}
(async () => {
  const r = await probe('localhost', 3001, '/contest/login');
  console.log('HTTP probe:', JSON.stringify(r));
})();
