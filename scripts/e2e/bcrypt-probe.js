'use strict';
// 测 bcryptjs compareSync 是否卡死（独立进程，不连服务器）
const bcrypt = require('bcryptjs');
// 从数据库取一个真实 hash，或直接生成
const t0 = Date.now();
console.log('start bcrypt probe');
const hash = bcrypt.hashSync('user123', 10);
console.log('hash ok', (Date.now() - t0) + 'ms');
const t1 = Date.now();
const ok = bcrypt.compareSync('user123', hash);
console.log('compareSync ok=', ok, (Date.now() - t1) + 'ms');
// 连做 10 次，看是否逐渐变慢
for (let i = 0; i < 10; i++) {
  const s = Date.now();
  bcrypt.compareSync('user123', hash);
  console.log('iter' + i, (Date.now() - s) + 'ms');
}
console.log('DONE');
