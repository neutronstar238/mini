# Mini-OJ yqzl deployment (PowerShell 7+)
# Exact release archive -> remote staging -> backup -> rsync -> PM2 restart -> health checks.
param(
  [string]$ServerHost = "yqzl-server",
  [string]$LocalDir = "E:\mini\server",
  [string]$DomainContest = "contest.mini.nstarzx.cn",
  [string]$DomainAdmin = "admin.mini.nstarzx.cn"
)

$ErrorActionPreference = "Stop"

function Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

$localRoot = [System.IO.Path]::GetFullPath($LocalDir)
if (-not (Test-Path -LiteralPath (Join-Path $localRoot "src\app.js"))) {
  throw "Local server directory is invalid: $localRoot"
}

$releaseId = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
$localArchive = Join-Path ([System.IO.Path]::GetTempPath()) "mini-oj-$releaseId.tar.gz"
$remoteArchive = "/tmp/mini-oj-$releaseId.tar.gz"

try {
  Step "1/4 Build an exact release archive"
  Push-Location $localRoot
  try {
    & tar.exe -czf $localArchive -- src views public package.json package-lock.json
    if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
  $archiveInfo = Get-Item -LiteralPath $localArchive
  Write-Host ("Archive: {0} ({1:N1} MB)" -f $archiveInfo.FullName, ($archiveInfo.Length / 1MB))

  Step "2/4 Upload release archive"
  & scp.exe $localArchive "$ServerHost`:$remoteArchive"
  if ($LASTEXITCODE -ne 0) { throw "scp failed with exit code $LASTEXITCODE" }

  Step "3/4 Stage, back up, and atomically synchronize application files"
  $remoteScript = @'
set -euo pipefail
export PATH=/www/server/nodejs/v24.14.1/bin:/usr/bin:/bin

RELEASE_ID="__RELEASE_ID__"
ARCHIVE="__REMOTE_ARCHIVE__"
STAGE="/tmp/mini-oj-release-$RELEASE_ID"
BACKUP="/www/backups/mini-oj/$RELEASE_ID"
CONTEST="/www/wwwroot/__DOMAIN_CONTEST__"
ADMIN="/www/wwwroot/__DOMAIN_ADMIN__"
SHARED_DB="$CONTEST/data/mini-oj.db"

case "$CONTEST:$ADMIN:$STAGE" in
  /www/wwwroot/*:/www/wwwroot/*:/tmp/mini-oj-release-*) ;;
  *) echo "unsafe deployment target" >&2; exit 2 ;;
esac

test -f "$ARCHIVE"
mkdir -p "$STAGE" "$BACKUP" "$CONTEST/data" "$ADMIN/data"
tar -xzf "$ARCHIVE" -C "$STAGE"
test -f "$STAGE/src/app.js"
test -f "$STAGE/public/js/runno/langs/clang.wasm"
test -f "$STAGE/public/js/pyodide/pyodide.mjs"

if test -f "$CONTEST/src/app.js"; then
  tar --exclude=./data --exclude=./node_modules --exclude=./C: \
    -czf "$BACKUP/contest-code.tar.gz" -C "$CONTEST" .
fi
if test -f "$ADMIN/src/app.js"; then
  tar --exclude=./data --exclude=./node_modules \
    -czf "$BACKUP/admin-code.tar.gz" -C "$ADMIN" .
fi

rsync -a --delete --exclude=/data/ --exclude=/node_modules/ "$STAGE/" "$CONTEST/"
rsync -a --delete --exclude=/data/ --exclude=/node_modules/ "$STAGE/" "$ADMIN/"

cd "$CONTEST"
npm install --omit=dev --no-audit --no-fund
cd "$ADMIN"
npm install --omit=dev --no-audit --no-fund

if pm2 describe mini-oj-contest >/dev/null 2>&1; then
  C_COMPILER=/usr/bin/gcc-11 CPP_COMPILER=/usr/bin/g++-11 \
    pm2 restart mini-oj-contest --update-env >/dev/null
else
  : "${INTERNAL_API_SECRET:?Set INTERNAL_API_SECRET before the first deployment}"
  cd "$CONTEST"
  APP_ENTRY=contest PORT=3001 DB_FILE="$SHARED_DB" \
    C_COMPILER=/usr/bin/gcc-11 CPP_COMPILER=/usr/bin/g++-11 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 start src/app.js --name mini-oj-contest >/dev/null
fi

if pm2 describe mini-oj-admin >/dev/null 2>&1; then
  pm2 restart mini-oj-admin --update-env >/dev/null
else
  cd "$ADMIN"
  APP_ENTRY=admin PORT=3002 DB_FILE="$SHARED_DB" CORE_BASE_URL=http://127.0.0.1:3001 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
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

health_check 3001 "__DOMAIN_CONTEST__" /contest/login
health_check 3002 "__DOMAIN_ADMIN__" /admin/login
pm2 save >/dev/null

rm -rf -- "$STAGE"
rm -f -- "$ARCHIVE"
echo "DEPLOY_OK release=$RELEASE_ID backup=$BACKUP"
'@
  $remoteScript = $remoteScript.Replace('__RELEASE_ID__', $releaseId).
    Replace('__REMOTE_ARCHIVE__', $remoteArchive).
    Replace('__DOMAIN_CONTEST__', $DomainContest).
    Replace('__DOMAIN_ADMIN__', $DomainAdmin)

  $remoteScript | & ssh.exe $ServerHost "bash -s"
  if ($LASTEXITCODE -ne 0) { throw "remote deployment failed with exit code $LASTEXITCODE" }

  Step "4/4 Deployment completed"
  Write-Host "Contest: https://$DomainContest/contest" -ForegroundColor Green
  Write-Host "Admin:   https://$DomainAdmin/admin" -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $localArchive) {
    Remove-Item -LiteralPath $localArchive -Force
  }
}
