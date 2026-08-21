#!/bin/bash
# Phase 4 参考评测环境部署脚本（在 yqzl-server 上执行）
set -e
export PATH=/www/server/nodejs/v24.14.1/bin:/usr/bin:/bin
cd /www/wwwroot/phase4-e2e/server
echo '==> npm install'
npm install --registry=https://registry.npmmirror.com --omit=dev 2>&1 | tail -5
echo '==> check toolchain'
echo "gcc: $(gcc --version | head -1)"
echo "g++: $(g++ --version | head -1)"
echo "python3: $(python3 --version)"
echo '==> start server (contest entry, port 3011)'
# 清理旧进程
pkill -f 'phase4-e2e/server/src/app.js' 2>/dev/null || true
sleep 1
APP_ENTRY=contest PORT=3011 DB_FILE=/www/wwwroot/phase4-e2e/server/data/oj-main-path.db \
  nohup node src/app.js > /www/wwwroot/phase4-e2e/server/run.out.log 2> /www/wwwroot/phase4-e2e/server/run.err.log &
sleep 3
echo '==> server log tail'
tail -8 /www/wwwroot/phase4-e2e/server/run.out.log
echo '==> stderr (if any)'
cat /www/wwwroot/phase4-e2e/server/run.err.log 2>/dev/null || echo '(no stderr)'
echo 'DEPLOY DONE'
