# Mini-OJ deployment (PowerShell 7+)
# Exact release archive -> remote staging -> backup -> rsync -> PM2 restart -> health checks.
param(
  [Parameter(Mandatory = $true)]
  [string]$ServerHost,
  [string]$LocalDir = (Join-Path $PSScriptRoot "..\server"),
  [Parameter(Mandatory = $true)]
  [string]$DomainContest,
  [Parameter(Mandatory = $true)]
  [string]$DomainAdmin,
  [string]$RemoteWebRoot = "/var/www/mini-oj",
  [string]$RemoteBackupRoot = "/var/backups/mini-oj",
  [string]$RemoteSecretsDir = "/etc/mini-oj",
  [string]$RemoteNodeBin = "/usr/local/bin"
)

$ErrorActionPreference = "Stop"
$gitCommand = if ($IsWindows) { "git.exe" } else { "git" }
$tarCommand = if ($IsWindows) { "tar.exe" } else { "tar" }
$scpCommand = if ($IsWindows) { "scp.exe" } else { "scp" }
$sshCommand = if ($IsWindows) { "ssh.exe" } else { "ssh" }

foreach ($domain in @($DomainContest, $DomainAdmin)) {
  if ($domain -notmatch '^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$') {
    throw "Invalid deployment domain: $domain"
  }
}
foreach ($remotePath in @($RemoteWebRoot, $RemoteBackupRoot, $RemoteSecretsDir, $RemoteNodeBin)) {
  if ($remotePath -notmatch '^/[a-zA-Z0-9._/-]+$' -or $remotePath -match '(^|/)\.\.(/|$)') {
    throw "Invalid remote path: $remotePath"
  }
}

function Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

$localRoot = [System.IO.Path]::GetFullPath($LocalDir)
if (-not (Test-Path -LiteralPath (Join-Path $localRoot "src\app.js"))) {
  throw "Local server directory is invalid: $localRoot"
}

$dirtyServerFiles = & $gitCommand -C $localRoot status --porcelain -- .
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the Git worktree" }
if ($dirtyServerFiles) {
  throw "Refusing to deploy uncommitted server files. Commit the release first."
}
$releaseCommit = (& $gitCommand -C $localRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $releaseCommit) { throw "Unable to resolve the release commit" }

$releaseId = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + $releaseCommit
$localArchive = Join-Path ([System.IO.Path]::GetTempPath()) "mini-oj-$releaseId.tar.gz"
$remoteArchive = "/tmp/mini-oj-$releaseId.tar.gz"

try {
  Step "1/4 Build an exact release archive"
  Push-Location $localRoot
  try {
    & $tarCommand -czf $localArchive -- src views public package.json package-lock.json
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $archiveInfo = Get-Item -LiteralPath $localArchive
  Write-Host ("Archive: {0} ({1:N1} MB)" -f $archiveInfo.FullName, ($archiveInfo.Length / 1MB))

  Step "2/4 Upload release archive"
  & $scpCommand $localArchive "$ServerHost`:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }

  Step "3/4 Stage, back up, and atomically synchronize application files"
  $remoteScript = @'
set -euo pipefail
export PATH="__NODE_BIN__:/usr/local/bin:/usr/bin:/bin"

RELEASE_ID="__RELEASE_ID__"
ARCHIVE="__REMOTE_ARCHIVE__"
STAGE="/tmp/mini-oj-release-$RELEASE_ID"
WEB_ROOT="__WEB_ROOT__"
BACKUP_ROOT="__BACKUP_ROOT__"
BACKUP="$BACKUP_ROOT/$RELEASE_ID"
CONTEST="$WEB_ROOT/__DOMAIN_CONTEST__"
ADMIN="$WEB_ROOT/__DOMAIN_ADMIN__"
SHARED_DB="$CONTEST/data/mini-oj.db"
OJ_DB="$CONTEST/data/oj-main-path.db"
SECRETS_DIR="__SECRETS_DIR__"
SECRETS_FILE="$SECRETS_DIR/mini-oj.env"

case "$CONTEST" in "$WEB_ROOT"/*) ;; *) echo "unsafe contest target" >&2; exit 2 ;; esac
case "$ADMIN" in "$WEB_ROOT"/*) ;; *) echo "unsafe admin target" >&2; exit 2 ;; esac
case "$BACKUP" in "$BACKUP_ROOT"/*) ;; *) echo "unsafe backup target" >&2; exit 2 ;; esac
case "$STAGE" in /tmp/mini-oj-release-*) ;; *) echo "unsafe staging target" >&2; exit 2 ;; esac

test -f "$ARCHIVE"
mkdir -p "$STAGE" "$BACKUP" "$CONTEST/data" "$ADMIN/data"
tar -xzf "$ARCHIVE" -C "$STAGE"
  test -f "$STAGE/src/app.js"
  test -f "$STAGE/public/js/runno/langs/clang.wasm"
  test -f "$STAGE/public/js/pyodide/pyodide.mjs"
  test -f "$STAGE/public/js/runtime/java21-browserjdk-compat-v2/runtime-manifest.json"
  test -f "$STAGE/public/js/runtime/cpp-modern-engine-v2/runtime-manifest.json"
  test -f "$STAGE/public/js/runtime/cpp-modern-engine-v2/ext/pb_ds/assoc_container.hpp"

if test -f "$SHARED_DB"; then
  command -v sqlite3 >/dev/null
  sqlite3 "$SHARED_DB" ".backup '$BACKUP/mini-oj.db'"
fi
if test -f "$OJ_DB"; then
  command -v sqlite3 >/dev/null
  sqlite3 "$OJ_DB" ".backup '$BACKUP/oj-main-path.db'"
fi

if test -f "$CONTEST/src/app.js"; then
  tar --exclude=./data --exclude=./node_modules --exclude=./.env --exclude=./C: \
    -czf "$BACKUP/contest-code.tar.gz" -C "$CONTEST" .
fi
if test -f "$ADMIN/src/app.js"; then
  tar --exclude=./data --exclude=./node_modules --exclude=./.env \
    -czf "$BACKUP/admin-code.tar.gz" -C "$ADMIN" .
fi

rsync -a --delete --exclude=/data/ --exclude=/node_modules/ --exclude=/.env "$STAGE/" "$CONTEST/"
rsync -a --delete --exclude=/data/ --exclude=/node_modules/ --exclude=/.env "$STAGE/" "$ADMIN/"

install -d -m 700 "$SECRETS_DIR"
if ! test -s "$SECRETS_FILE"; then
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

cd "$CONTEST"
npm ci --omit=dev --no-audit --no-fund
cd "$ADMIN"
npm ci --omit=dev --no-audit --no-fund

if pm2 describe mini-oj-contest >/dev/null 2>&1; then
  NODE_ENV=production APP_ENTRY=contest PORT=3001 DB_FILE="$SHARED_DB" \
    C_COMPILER=/usr/bin/gcc-11 CPP_COMPILER=/usr/bin/g++-11 \
    JAVA_JAVAC_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/javac \
    JAVA_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/java \
    JUDGE_SANDBOX_MODE=systemd JUDGE_SANDBOX_REQUIRED=1 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 restart mini-oj-contest --update-env >/dev/null
else
  cd "$CONTEST"
  NODE_ENV=production APP_ENTRY=contest PORT=3001 DB_FILE="$SHARED_DB" \
    C_COMPILER=/usr/bin/gcc-11 CPP_COMPILER=/usr/bin/g++-11 \
    JAVA_JAVAC_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/javac \
    JAVA_BIN=/usr/lib/jvm/java-21-openjdk-amd64/bin/java \
    JUDGE_SANDBOX_MODE=systemd JUDGE_SANDBOX_REQUIRED=1 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 start src/app.js --name mini-oj-contest >/dev/null
fi

if pm2 describe mini-oj-admin >/dev/null 2>&1; then
  NODE_ENV=production APP_ENTRY=admin PORT=3002 DB_FILE="$SHARED_DB" \
    CORE_BASE_URL=http://127.0.0.1:3001 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 restart mini-oj-admin --update-env >/dev/null
else
  cd "$ADMIN"
  NODE_ENV=production APP_ENTRY=admin PORT=3002 DB_FILE="$SHARED_DB" CORE_BASE_URL=http://127.0.0.1:3001 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 start src/app.js --name mini-oj-admin >/dev/null
fi

health_check() {
  local port="$1" host="$2" path="$3"
  for _ in $(seq 1 15); do
    if curl -fs -H "Host: $host" "http://127.0.0.1:$port$path" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

health_check 3001 "__DOMAIN_CONTEST__" /healthz
health_check 3001 "__DOMAIN_CONTEST__" /readyz
health_check 3002 "__DOMAIN_ADMIN__" /healthz
health_check 3002 "__DOMAIN_ADMIN__" /readyz
health_check 3001 "__DOMAIN_CONTEST__" /api/public/runtime-profiles
pm2 save >/dev/null

rm -rf -- "$STAGE"
rm -f -- "$ARCHIVE"
echo "DEPLOY_OK release=$RELEASE_ID backup=$BACKUP"
'@
  $remoteScript = $remoteScript.Replace('__RELEASE_ID__', $releaseId).
    Replace('__REMOTE_ARCHIVE__', $remoteArchive).
    Replace('__DOMAIN_CONTEST__', $DomainContest).
    Replace('__DOMAIN_ADMIN__', $DomainAdmin).
    Replace('__WEB_ROOT__', $RemoteWebRoot.TrimEnd('/')).
    Replace('__BACKUP_ROOT__', $RemoteBackupRoot.TrimEnd('/')).
    Replace('__SECRETS_DIR__', $RemoteSecretsDir.TrimEnd('/')).
    Replace('__NODE_BIN__', $RemoteNodeBin.TrimEnd('/'))

  $remoteScript | & $sshCommand $ServerHost "bash -s"
  if ($LASTEXITCODE -ne 0) { throw "remote deployment failed with exit code $LASTEXITCODE" }

  Step "4/4 Deployment completed"
  Write-Host "Contest: https://$DomainContest/contest" -ForegroundColor Green
  Write-Host "Admin:   https://$DomainAdmin/admin" -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $localArchive) {
    Remove-Item -LiteralPath $localArchive -Force
  }
}
