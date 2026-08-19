'use strict';
/**
 * headless 模式：无 GUI 运行可信 Worker Agent
 * 用于服务器部署/CI/无 WSL 时的协议联调演示
 * 用法：
 *   node judge/headless.js --register OJ-XXXX --server http://<服务器>:3000
 *   node judge/headless.js --server http://<服务器>:3000
 */
const agent = require('../agent/core');

async function main() {
  const argv = process.argv.slice(2);
  const args = { server: null, register: null, name: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--server') args.server = argv[++i];
    else if (argv[i] === '--register') args.register = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
  }
  await agent.run(args, { onStatus: (s) => console.log('[status]', s) });
}

main().catch((e) => { console.error('[fatal]', e.message); process.exit(1); });
