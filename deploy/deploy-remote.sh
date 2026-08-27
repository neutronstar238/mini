#!/bin/bash
# ============================================================
# Mini-OJ 服务器端部署脚本（在服务器上执行）
# 覆盖：npm install → pm2 启动 → nginx 配置 → Let's Encrypt 证书 → reload
#
# 使用：DEPLOY_CONFIG_FILE=/path/to/deploy.env bash deploy/deploy-remote.sh
# 也可将配置文件作为第一个参数传入。配置格式与 deploy.env.example 相同。
# 设置 DEPLOY_VALIDATE_ONLY=1 时仅检查配置，不改动服务器。
# ============================================================
set -euo pipefail

CONFIG_FILE=${DEPLOY_CONFIG_FILE:-${1:-}}
if [[ -z "$CONFIG_FILE" || ! -r "$CONFIG_FILE" ]]; then
  echo 'deployment config is missing; copy deploy.env.example and pass its path' >&2
  exit 2
fi

is_allowed_key() {
  case "$1" in
    SERVER_HOST|DOMAIN_CONTEST|DOMAIN_ADMIN|LOCAL_DIR|REMOTE_WEB_ROOT|REMOTE_BACKUP_ROOT|REMOTE_SECRETS_DIR|REMOTE_NODE_BIN|CONTEST_PORT|ADMIN_PORT|PM2_CONTEST_NAME|PM2_ADMIN_NAME|C_COMPILER|CPP_COMPILER|JAVA_JAVAC_BIN|JAVA_BIN|NGINX_VHOST_DIR|NGINX_LOG_DIR|NGINX_BIN|CERTBOT_BIN|COMPOSE_HTTP_PORT) return 0 ;;
    *) return 1 ;;
  esac
}

declare -A CONFIG_SEEN=()
line_number=0
while IFS= read -r raw_line || [[ -n "$raw_line" ]]; do
  line_number=$((line_number + 1))
  line=${raw_line%$'\r'}
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [[ -z "$line" || "${line:0:1}" == '#' ]] && continue
  if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    echo "invalid deployment config line $line_number" >&2
    exit 2
  fi
  key=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  if ! is_allowed_key "$key"; then
    echo "unknown deployment config key: $key" >&2
    exit 2
  fi
  if [[ -n "${CONFIG_SEEN[$key]:-}" ]]; then
    echo "duplicate deployment config key: $key" >&2
    exit 2
  fi
  CONFIG_SEEN[$key]=1
  if [[ ${#value} -ge 2 && ( ( ${value:0:1} == '"' && ${value: -1} == '"' ) || ( ${value:0:1} == "'" && ${value: -1} == "'" ) ) ]]; then
    value=${value:1:${#value}-2}
  fi
  printf -v "$key" '%s' "$value"
done < "$CONFIG_FILE"

: "${DOMAIN_CONTEST:?DOMAIN_CONTEST is missing from $CONFIG_FILE}"
: "${DOMAIN_ADMIN:?DOMAIN_ADMIN is missing from $CONFIG_FILE}"

for domain in "$DOMAIN_CONTEST" "$DOMAIN_ADMIN"; do
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$ ]] || {
    echo "invalid deployment domain: $domain" >&2
    exit 2
  }
  [[ "$domain" != *.example.com ]] || {
    echo "replace the example domain before deployment: $domain" >&2
    exit 2
  }
done
[[ "$DOMAIN_CONTEST" != "$DOMAIN_ADMIN" ]] || {
  echo 'DOMAIN_CONTEST and DOMAIN_ADMIN must be different' >&2
  exit 2
}

REMOTE_WEB_ROOT=${REMOTE_WEB_ROOT:-/var/www/mini-oj}
REMOTE_BACKUP_ROOT=${REMOTE_BACKUP_ROOT:-/var/backups/mini-oj}
REMOTE_SECRETS_DIR=${REMOTE_SECRETS_DIR:-/etc/mini-oj}
REMOTE_NODE_BIN=${REMOTE_NODE_BIN:-/usr/local/bin}
CONTEST_PORT=${CONTEST_PORT:-3001}
ADMIN_PORT=${ADMIN_PORT:-3002}
PM2_CONTEST_NAME=${PM2_CONTEST_NAME:-mini-oj-contest}
PM2_ADMIN_NAME=${PM2_ADMIN_NAME:-mini-oj-admin}
C_COMPILER=${C_COMPILER:-/usr/bin/gcc-11}
CPP_COMPILER=${CPP_COMPILER:-/usr/bin/g++-11}
JAVA_JAVAC_BIN=${JAVA_JAVAC_BIN:-/usr/lib/jvm/java-21-openjdk-amd64/bin/javac}
JAVA_BIN=${JAVA_BIN:-/usr/lib/jvm/java-21-openjdk-amd64/bin/java}
NGINX_VHOST_DIR=${NGINX_VHOST_DIR:-/etc/nginx/conf.d}
NGINX_LOG_DIR=${NGINX_LOG_DIR:-/var/log/nginx}
NGINX_BIN=${NGINX_BIN:-nginx}
CERTBOT_BIN=${CERTBOT_BIN:-certbot}
COMPOSE_HTTP_PORT=${COMPOSE_HTTP_PORT:-8080}

for remote_path in "$REMOTE_WEB_ROOT" "$REMOTE_BACKUP_ROOT" "$REMOTE_SECRETS_DIR" "$REMOTE_NODE_BIN" "$NGINX_VHOST_DIR" "$NGINX_LOG_DIR"; do
  [[ "$remote_path" =~ ^/[A-Za-z0-9._/-]+$ && "$remote_path" != *'/../'* && "$remote_path" != */.. ]] || {
    echo "invalid remote path: $remote_path" >&2
    exit 2
  }
done
for binary in "$C_COMPILER" "$CPP_COMPILER" "$JAVA_JAVAC_BIN" "$JAVA_BIN" "$NGINX_BIN" "$CERTBOT_BIN"; do
  [[ "$binary" =~ ^[A-Za-z0-9._+/-]+$ ]] || {
    echo "invalid binary name or path: $binary" >&2
    exit 2
  }
done
for process_name in "$PM2_CONTEST_NAME" "$PM2_ADMIN_NAME"; do
  [[ "$process_name" =~ ^[A-Za-z0-9._-]+$ ]] || {
    echo "invalid PM2 process name: $process_name" >&2
    exit 2
  }
done

[[ "$CONTEST_PORT" =~ ^[0-9]+$ && "$ADMIN_PORT" =~ ^[0-9]+$ && "$CONTEST_PORT" -ge 1 && "$CONTEST_PORT" -le 65535 && "$ADMIN_PORT" -ge 1 && "$ADMIN_PORT" -le 65535 && "$CONTEST_PORT" != "$ADMIN_PORT" ]] || {
  echo 'CONTEST_PORT and ADMIN_PORT must be distinct values from 1 to 65535' >&2
  exit 2
}
[[ "$COMPOSE_HTTP_PORT" =~ ^[0-9]+$ && "$COMPOSE_HTTP_PORT" -ge 1 && "$COMPOSE_HTTP_PORT" -le 65535 ]] || {
  echo 'COMPOSE_HTTP_PORT must be from 1 to 65535' >&2
  exit 2
}

if [[ "${DEPLOY_VALIDATE_ONLY:-0}" == 1 ]]; then
  printf 'Deployment configuration: PASS\n  Contest: https://%s (%s)\n  Admin:   https://%s (%s)\n' \
    "$DOMAIN_CONTEST" "$CONTEST_PORT" "$DOMAIN_ADMIN" "$ADMIN_PORT"
  exit 0
fi

export PATH="$REMOTE_NODE_BIN:/usr/bin:/bin"

WEB_ROOT=$REMOTE_WEB_ROOT
CONTEST="$WEB_ROOT/$DOMAIN_CONTEST"
ADMIN="$WEB_ROOT/$DOMAIN_ADMIN"
SHARED_DB="$CONTEST/data/mini-oj.db"
SECRETS_FILE="$REMOTE_SECRETS_DIR/mini-oj.env"

install -d -m 700 "$REMOTE_SECRETS_DIR"
if [[ ! -s "$SECRETS_FILE" ]]; then
  umask 077
  {
    printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'HMAC_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'INTERNAL_API_SECRET=%s\n' "$(openssl rand -hex 32)"
  } > "$SECRETS_FILE"
fi
chmod 600 "$SECRETS_FILE"
set -a
. "$SECRETS_FILE"
set +a
: "${JWT_SECRET:?JWT_SECRET is missing from $SECRETS_FILE}"
: "${HMAC_SECRET:?HMAC_SECRET is missing from $SECRETS_FILE}"
: "${INTERNAL_API_SECRET:?INTERNAL_API_SECRET is missing from $SECRETS_FILE}"

echo '==> 1/6 安装依赖'
cd "$CONTEST" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3
cd "$ADMIN" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3

echo '==> 2/6 pm2 启动'
cd "$CONTEST" && pm2 delete "$PM2_CONTEST_NAME" 2>/dev/null || true
NODE_ENV=production APP_ENTRY=contest PORT="$CONTEST_PORT" DB_FILE="$SHARED_DB" C_COMPILER="$C_COMPILER" CPP_COMPILER="$CPP_COMPILER" \
  JAVA_JAVAC_BIN="$JAVA_JAVAC_BIN" JAVA_BIN="$JAVA_BIN" \
  JUDGE_SANDBOX_MODE=systemd JUDGE_SANDBOX_REQUIRED=1 \
  JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
  DOMAIN_CONTEST="$DOMAIN_CONTEST" DOMAIN_ADMIN="$DOMAIN_ADMIN" \
  pm2 start src/app.js --name "$PM2_CONTEST_NAME"
cd "$ADMIN" && pm2 delete "$PM2_ADMIN_NAME" 2>/dev/null || true
NODE_ENV=production APP_ENTRY=admin PORT="$ADMIN_PORT" DB_FILE="$SHARED_DB" CORE_BASE_URL="http://127.0.0.1:$CONTEST_PORT" \
  JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
  DOMAIN_CONTEST="$DOMAIN_CONTEST" DOMAIN_ADMIN="$DOMAIN_ADMIN" \
  pm2 start src/app.js --name "$PM2_ADMIN_NAME"
pm2 save

echo '==> 3/6 写 nginx 80 配置（ACME 验证 + 跳转 HTTPS）'
cat > "$NGINX_VHOST_DIR/${DOMAIN_CONTEST}_80.conf" << EOF
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
    access_log  $NGINX_LOG_DIR/${DOMAIN_CONTEST}_80.log;
    error_log   $NGINX_LOG_DIR/${DOMAIN_CONTEST}_80.error.log;
}
EOF
cat > "$NGINX_VHOST_DIR/${DOMAIN_ADMIN}_80.conf" << EOF
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
    access_log  $NGINX_LOG_DIR/${DOMAIN_ADMIN}_80.log;
    error_log   $NGINX_LOG_DIR/${DOMAIN_ADMIN}_80.error.log;
}
EOF

echo '==> 4/6 签发 Let''s Encrypt 证书'
"$CERTBOT_BIN" certonly --webroot -w "$CONTEST" -d "$DOMAIN_CONTEST" \
  --non-interactive --agree-tos --register-unsafely-without-email --renew-by-default 2>&1 | tail -4
"$CERTBOT_BIN" certonly --webroot -w "$ADMIN" -d "$DOMAIN_ADMIN" \
  --non-interactive --agree-tos --register-unsafely-without-email --renew-by-default 2>&1 | tail -4

echo '==> 5/6 写 nginx 443 配置（反代 + WebSocket/SSE）'
cat > "$NGINX_VHOST_DIR/${DOMAIN_CONTEST}_443.conf" << EOF
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
        proxy_pass http://127.0.0.1:$CONTEST_PORT;
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
    access_log $NGINX_LOG_DIR/${DOMAIN_CONTEST}_443.log;
    error_log  $NGINX_LOG_DIR/${DOMAIN_CONTEST}_443.error.log;
}
EOF
cat > "$NGINX_VHOST_DIR/${DOMAIN_ADMIN}_443.conf" << EOF
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
        proxy_pass http://127.0.0.1:$ADMIN_PORT;
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
    access_log $NGINX_LOG_DIR/${DOMAIN_ADMIN}_443.log;
    error_log  $NGINX_LOG_DIR/${DOMAIN_ADMIN}_443.error.log;
}
EOF

echo '==> 6/6 reload nginx'
$NGINX_BIN -t
systemctl reload nginx
echo 'DEPLOY OK'
