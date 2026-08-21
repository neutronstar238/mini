#!/bin/bash
# ============================================================
# Mini-OJ 服务器端部署脚本（在服务器上执行）
# 覆盖：npm install → pm2 启动 → nginx 配置 → Let's Encrypt 证书 → reload
#
# 使用前必改：
#   1) 将下方 DOMAIN_CONTEST / DOMAIN_ADMIN 改为真实域名
#   2) 将 server/src/config.js 中 DOMAIN_CONTEST/DOMAIN_ADMIN 注入为同一真实域名
#   3) 将 NODE 路径指向服务器上实际的 node 安装目录
# 仓库内不保留真实域名与备案号，请勿将真实域名提交到仓库。
# ============================================================
set -e

NODE=/www/server/nodejs/v24.14.1/bin
export PATH=$NODE:/usr/bin:/bin

# ====== 部署参数（部署时替换为真实域名） ======
DOMAIN_CONTEST=contest.mini.nstarzx.cn
DOMAIN_ADMIN=admin.mini.nstarzx.cn
# ==============================================

CONTEST=/www/wwwroot/$DOMAIN_CONTEST
ADMIN=/www/wwwroot/$DOMAIN_ADMIN
SHARED_DB=$CONTEST/data/mini-oj.db
NGINX_VHOST=/www/server/panel/vhost/nginx

echo '==> 1/6 安装依赖'
cd $CONTEST && npm install --registry=https://registry.npmmirror.com --omit=dev 2>&1 | tail -3
cd $ADMIN   && npm install --registry=https://registry.npmmirror.com --omit=dev 2>&1 | tail -3

echo '==> 2/6 pm2 启动'
cd $CONTEST && pm2 delete mini-oj-contest 2>/dev/null || true
APP_ENTRY=contest PORT=3001 DB_FILE=$SHARED_DB C_COMPILER=gcc-11 CPP_COMPILER=g++-11 \
  DOMAIN_CONTEST=$DOMAIN_CONTEST DOMAIN_ADMIN=$DOMAIN_ADMIN \
  pm2 start src/app.js --name mini-oj-contest
cd $ADMIN && pm2 delete mini-oj-admin 2>/dev/null || true
APP_ENTRY=admin PORT=3002 DB_FILE=$SHARED_DB \
  DOMAIN_CONTEST=$DOMAIN_CONTEST DOMAIN_ADMIN=$DOMAIN_ADMIN \
  pm2 start src/app.js --name mini-oj-admin
pm2 save

echo '==> 3/6 写 nginx 80 配置（ACME 验证 + 跳转 HTTPS）'
cat > $NGINX_VHOST/${DOMAIN_CONTEST}_80.conf << EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN_CONTEST;
    location ^~ /.well-known/acme-challenge/ {
        root $CONTEST;
        allow all;
        default_type text/plain;
    }
    location / { return 301 https://\$host\$request_uri; }
    access_log  /www/wwwlogs/${DOMAIN_CONTEST}_80.log;
    error_log   /www/wwwlogs/${DOMAIN_CONTEST}_80.error.log;
}
EOF
cat > $NGINX_VHOST/${DOMAIN_ADMIN}_80.conf << EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN_ADMIN;
    location ^~ /.well-known/acme-challenge/ {
        root $ADMIN;
        allow all;
        default_type text/plain;
    }
    location / { return 301 https://\$host\$request_uri; }
    access_log  /www/wwwlogs/${DOMAIN_ADMIN}_80.log;
    error_log   /www/wwwlogs/${DOMAIN_ADMIN}_80.error.log;
}
EOF

echo '==> 4/6 签发 Let''s Encrypt 证书'
certbot certonly --webroot -w $CONTEST -d $DOMAIN_CONTEST \
  --non-interactive --agree-tos --register-unsafely-without-email --renew-by-default 2>&1 | tail -4
certbot certonly --webroot -w $ADMIN -d $DOMAIN_ADMIN \
  --non-interactive --agree-tos --register-unsafely-without-email --renew-by-default 2>&1 | tail -4

echo '==> 5/6 写 nginx 443 配置（反代 + WebSocket/SSE）'
cat > $NGINX_VHOST/${DOMAIN_CONTEST}_443.conf << EOF
server {
    listen 443 ssl;
    http2 on;
    listen [::]:443 ssl;
    server_name $DOMAIN_CONTEST;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN_CONTEST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN_CONTEST/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_comp_level 5;
    gzip_types application/javascript application/wasm application/json text/css text/plain;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection upgrade;
    location ^~ / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
    access_log /www/wwwlogs/${DOMAIN_CONTEST}_443.log;
    error_log  /www/wwwlogs/${DOMAIN_CONTEST}_443.error.log;
}
EOF
cat > $NGINX_VHOST/${DOMAIN_ADMIN}_443.conf << EOF
server {
    listen 443 ssl;
    http2 on;
    listen [::]:443 ssl;
    server_name $DOMAIN_ADMIN;
    ssl_certificate     /etc/letsencrypt/live/$DOMAIN_ADMIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN_ADMIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection upgrade;
    location ^~ / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_connect_timeout 60s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
        proxy_buffering off;
    }
    access_log /www/wwwlogs/${DOMAIN_ADMIN}_443.log;
    error_log  /www/wwwlogs/${DOMAIN_ADMIN}_443.error.log;
}
EOF

echo '==> 6/6 reload nginx'
$NODE/nginx -t 2>&1 | tail -3
/etc/init.d/nginx reload 2>&1 | tail -2
echo 'DEPLOY OK'
