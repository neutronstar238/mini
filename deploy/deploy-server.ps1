# Mini-OJ deployment (PowerShell 7+)
# Exact release archive -> remote staging -> backup -> rsync -> PM2 restart -> health checks.
param(
  [string]$ConfigFile,
  [switch]$ValidateOnly,
  [string]$ServerHost,
  [string]$LocalDir,
  [string]$DomainContest,
  [string]$DomainAdmin,
  [string]$RemoteWebRoot,
  [string]$RemoteBackupRoot,
  [string]$RemoteSecretsDir,
  [string]$RemoteNodeBin,
  [int]$ContestPort,
  [int]$AdminPort,
  [string]$Pm2ContestName,
  [string]$Pm2AdminName,
  [string]$CCompiler,
  [string]$CppCompiler,
  [string]$JavaJavacBin,
  [string]$JavaBin,
  [string]$NginxVhostDir,
  [string]$NginxLogDir,
  [string]$NginxBin,
  [string]$CertbotBin,
  [int]$ComposeHttpPort
)

$ErrorActionPreference = "Stop"
$scriptBoundValues = @{}
foreach ($parameterName in $PSBoundParameters.Keys) {
  $scriptBoundValues[$parameterName] = $PSBoundParameters[$parameterName]
}

$allowedConfigKeys = @(
  "SERVER_HOST", "DOMAIN_CONTEST", "DOMAIN_ADMIN", "LOCAL_DIR",
  "REMOTE_WEB_ROOT", "REMOTE_BACKUP_ROOT", "REMOTE_SECRETS_DIR", "REMOTE_NODE_BIN",
  "CONTEST_PORT", "ADMIN_PORT", "PM2_CONTEST_NAME", "PM2_ADMIN_NAME",
  "C_COMPILER", "CPP_COMPILER", "JAVA_JAVAC_BIN", "JAVA_BIN",
  "NGINX_VHOST_DIR", "NGINX_LOG_DIR", "NGINX_BIN", "CERTBOT_BIN", "COMPOSE_HTTP_PORT"
)

function Read-DeployConfig([string]$Path) {
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $values = @{}
  $lineNumber = 0
  foreach ($rawLine in Get-Content -LiteralPath $resolved) {
    $lineNumber++
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }
    if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
      throw "Invalid deployment config line $lineNumber in $resolved"
    }
    $key = $Matches[1]
    $value = $Matches[2].Trim()
    if ($allowedConfigKeys -notcontains $key) { throw "Unknown deployment config key: $key" }
    if ($values.ContainsKey($key)) { throw "Duplicate deployment config key: $key" }
    $isDoubleQuoted = $value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')
    $isSingleQuoted = $value.Length -ge 2 -and $value.StartsWith("'") -and $value.EndsWith("'")
    if ($isDoubleQuoted -or $isSingleQuoted) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$key] = $value
  }
  return @{ Path = $resolved; Values = $values }
}

$config = @{ Path = $null; Values = @{} }
if ($ConfigFile) { $config = Read-DeployConfig $ConfigFile }

function Resolve-DeployValue([string]$ParameterName, [string]$ConfigKey, $DefaultValue) {
  if ($scriptBoundValues.ContainsKey($ParameterName)) { return $scriptBoundValues[$ParameterName] }
  if ($config.Values.ContainsKey($ConfigKey)) { return $config.Values[$ConfigKey] }
  return $DefaultValue
}

$ServerHost = Resolve-DeployValue "ServerHost" "SERVER_HOST" ""
$DomainContest = Resolve-DeployValue "DomainContest" "DOMAIN_CONTEST" ""
$DomainAdmin = Resolve-DeployValue "DomainAdmin" "DOMAIN_ADMIN" ""
$LocalDir = Resolve-DeployValue "LocalDir" "LOCAL_DIR" (Join-Path $PSScriptRoot "..\server")
$RemoteWebRoot = Resolve-DeployValue "RemoteWebRoot" "REMOTE_WEB_ROOT" "/var/www/mini-oj"
$RemoteBackupRoot = Resolve-DeployValue "RemoteBackupRoot" "REMOTE_BACKUP_ROOT" "/var/backups/mini-oj"
$RemoteSecretsDir = Resolve-DeployValue "RemoteSecretsDir" "REMOTE_SECRETS_DIR" "/etc/mini-oj"
$RemoteNodeBin = Resolve-DeployValue "RemoteNodeBin" "REMOTE_NODE_BIN" "/usr/local/bin"
$ContestPort = [int](Resolve-DeployValue "ContestPort" "CONTEST_PORT" 3001)
$AdminPort = [int](Resolve-DeployValue "AdminPort" "ADMIN_PORT" 3002)
$Pm2ContestName = Resolve-DeployValue "Pm2ContestName" "PM2_CONTEST_NAME" "mini-oj-contest"
$Pm2AdminName = Resolve-DeployValue "Pm2AdminName" "PM2_ADMIN_NAME" "mini-oj-admin"
$CCompiler = Resolve-DeployValue "CCompiler" "C_COMPILER" "/usr/bin/gcc-11"
$CppCompiler = Resolve-DeployValue "CppCompiler" "CPP_COMPILER" "/usr/bin/g++-11"
$JavaJavacBin = Resolve-DeployValue "JavaJavacBin" "JAVA_JAVAC_BIN" "/usr/lib/jvm/java-21-openjdk-amd64/bin/javac"
$JavaBin = Resolve-DeployValue "JavaBin" "JAVA_BIN" "/usr/lib/jvm/java-21-openjdk-amd64/bin/java"
$NginxVhostDir = Resolve-DeployValue "NginxVhostDir" "NGINX_VHOST_DIR" "/etc/nginx/conf.d"
$NginxLogDir = Resolve-DeployValue "NginxLogDir" "NGINX_LOG_DIR" "/var/log/nginx"
$NginxBin = Resolve-DeployValue "NginxBin" "NGINX_BIN" "nginx"
$CertbotBin = Resolve-DeployValue "CertbotBin" "CERTBOT_BIN" "certbot"
$ComposeHttpPort = [int](Resolve-DeployValue "ComposeHttpPort" "COMPOSE_HTTP_PORT" 8080)

if (-not $ServerHost -or $ServerHost -notmatch '^[a-zA-Z0-9._@:-]+$' -or $ServerHost.StartsWith('-')) {
  throw "SERVER_HOST is missing or invalid"
}
if ($ServerHost -eq "your-ssh-host") { throw "Replace the SERVER_HOST placeholder before deployment" }
$gitCommand = if ($IsWindows) { "git.exe" } else { "git" }
$tarCommand = if ($IsWindows) { "tar.exe" } else { "tar" }
$scpCommand = if ($IsWindows) { "scp.exe" } else { "scp" }
$sshCommand = if ($IsWindows) { "ssh.exe" } else { "ssh" }

foreach ($domain in @($DomainContest, $DomainAdmin)) {
  if ($domain -notmatch '^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$') {
    throw "Invalid deployment domain: $domain"
  }
  if ($domain.EndsWith(".example.com")) { throw "Replace the example domain before deployment: $domain" }
}
if ($DomainContest -eq $DomainAdmin) { throw "DOMAIN_CONTEST and DOMAIN_ADMIN must be different" }
foreach ($remotePath in @($RemoteWebRoot, $RemoteBackupRoot, $RemoteSecretsDir, $RemoteNodeBin, $NginxVhostDir, $NginxLogDir)) {
  if ($remotePath -notmatch '^/[a-zA-Z0-9._/-]+$' -or $remotePath -match '(^|/)\.\.(/|$)') {
    throw "Invalid remote path: $remotePath"
  }
}
foreach ($binaryPath in @($CCompiler, $CppCompiler, $JavaJavacBin, $JavaBin)) {
  if ($binaryPath -notmatch '^/[a-zA-Z0-9._+/-]+$' -or $binaryPath -match '(^|/)\.\.(/|$)') {
    throw "Invalid remote binary path: $binaryPath"
  }
}
foreach ($commandName in @($NginxBin, $CertbotBin)) {
  if ($commandName -notmatch '^[a-zA-Z0-9._+/-]+$') { throw "Invalid remote command name or path: $commandName" }
}
if ($ContestPort -lt 1 -or $ContestPort -gt 65535 -or $AdminPort -lt 1 -or $AdminPort -gt 65535 -or $ContestPort -eq $AdminPort) {
  throw "CONTEST_PORT and ADMIN_PORT must be distinct values from 1 to 65535"
}
foreach ($processName in @($Pm2ContestName, $Pm2AdminName)) {
  if ($processName -notmatch '^[a-zA-Z0-9._-]+$') { throw "Invalid PM2 process name: $processName" }
}
if ($ComposeHttpPort -lt 1 -or $ComposeHttpPort -gt 65535) {
  throw "COMPOSE_HTTP_PORT must be from 1 to 65535"
}

function Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

$localRoot = if ([System.IO.Path]::IsPathRooted($LocalDir)) {
  [System.IO.Path]::GetFullPath($LocalDir)
} else {
  $localDirBase = if ($config.Path) { Split-Path -Parent $config.Path } else { (Get-Location).Path }
  [System.IO.Path]::GetFullPath((Join-Path $localDirBase $LocalDir))
}
if (-not (Test-Path -LiteralPath (Join-Path $localRoot "src\app.js"))) {
  throw "Local server directory is invalid: $localRoot"
}

if ($ValidateOnly) {
  Write-Host "Deployment configuration: PASS" -ForegroundColor Green
  Write-Host "  Config:  $($config.Path ?? '<command line>')"
  Write-Host "  Contest: https://$DomainContest ($ContestPort)"
  Write-Host "  Admin:   https://$DomainAdmin ($AdminPort)"
  Write-Host "  Source:  $localRoot"
  exit 0
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
CONTEST_PORT="__CONTEST_PORT__"
ADMIN_PORT="__ADMIN_PORT__"
PM2_CONTEST_NAME="__PM2_CONTEST_NAME__"
PM2_ADMIN_NAME="__PM2_ADMIN_NAME__"
C_COMPILER="__C_COMPILER__"
CPP_COMPILER="__CPP_COMPILER__"
JAVA_JAVAC_BIN="__JAVA_JAVAC_BIN__"
JAVA_BIN="__JAVA_BIN__"

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

if pm2 describe "$PM2_CONTEST_NAME" >/dev/null 2>&1; then
  NODE_ENV=production APP_ENTRY=contest PORT="$CONTEST_PORT" DB_FILE="$SHARED_DB" \
    C_COMPILER="$C_COMPILER" CPP_COMPILER="$CPP_COMPILER" \
    JAVA_JAVAC_BIN="$JAVA_JAVAC_BIN" JAVA_BIN="$JAVA_BIN" \
    JUDGE_SANDBOX_MODE=systemd JUDGE_SANDBOX_REQUIRED=1 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 restart "$PM2_CONTEST_NAME" --update-env >/dev/null
else
  cd "$CONTEST"
  NODE_ENV=production APP_ENTRY=contest PORT="$CONTEST_PORT" DB_FILE="$SHARED_DB" \
    C_COMPILER="$C_COMPILER" CPP_COMPILER="$CPP_COMPILER" \
    JAVA_JAVAC_BIN="$JAVA_JAVAC_BIN" JAVA_BIN="$JAVA_BIN" \
    JUDGE_SANDBOX_MODE=systemd JUDGE_SANDBOX_REQUIRED=1 \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 start src/app.js --name "$PM2_CONTEST_NAME" >/dev/null
fi

if pm2 describe "$PM2_ADMIN_NAME" >/dev/null 2>&1; then
  NODE_ENV=production APP_ENTRY=admin PORT="$ADMIN_PORT" DB_FILE="$SHARED_DB" \
    CORE_BASE_URL="http://127.0.0.1:$CONTEST_PORT" \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 restart "$PM2_ADMIN_NAME" --update-env >/dev/null
else
  cd "$ADMIN"
  NODE_ENV=production APP_ENTRY=admin PORT="$ADMIN_PORT" DB_FILE="$SHARED_DB" CORE_BASE_URL="http://127.0.0.1:$CONTEST_PORT" \
    DOMAIN_CONTEST="__DOMAIN_CONTEST__" DOMAIN_ADMIN="__DOMAIN_ADMIN__" \
    JWT_SECRET="$JWT_SECRET" HMAC_SECRET="$HMAC_SECRET" INTERNAL_API_SECRET="$INTERNAL_API_SECRET" \
    pm2 start src/app.js --name "$PM2_ADMIN_NAME" >/dev/null
fi

health_check() {
  local port="$1" host="$2" path="$3"
  for _ in $(seq 1 15); do
    if curl -fs -H "Host: $host" "http://127.0.0.1:$port$path" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

health_check "$CONTEST_PORT" "__DOMAIN_CONTEST__" /healthz
health_check "$CONTEST_PORT" "__DOMAIN_CONTEST__" /readyz
health_check "$ADMIN_PORT" "__DOMAIN_ADMIN__" /healthz
health_check "$ADMIN_PORT" "__DOMAIN_ADMIN__" /readyz
health_check "$CONTEST_PORT" "__DOMAIN_CONTEST__" /api/public/runtime-profiles
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
    Replace('__NODE_BIN__', $RemoteNodeBin.TrimEnd('/')).
    Replace('__CONTEST_PORT__', [string]$ContestPort).
    Replace('__ADMIN_PORT__', [string]$AdminPort).
    Replace('__PM2_CONTEST_NAME__', $Pm2ContestName).
    Replace('__PM2_ADMIN_NAME__', $Pm2AdminName).
    Replace('__C_COMPILER__', $CCompiler).
    Replace('__CPP_COMPILER__', $CppCompiler).
    Replace('__JAVA_JAVAC_BIN__', $JavaJavacBin).
    Replace('__JAVA_BIN__', $JavaBin)

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
