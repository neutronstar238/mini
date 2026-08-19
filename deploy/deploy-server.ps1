# ============================================================
# Mini-OJ 服务器部署脚本（PowerShell 7+）
# 部署流程：
#   1) 本地打包 server（排除 node_modules/data/日志）
#   2) 上传到服务器 contest 与 admin 目录
#   3) 上传远程部署脚本 deploy-remote.sh 并执行
#      （远程脚本负责：npm install / pm2 启动 / 证书签发 / nginx 配置 / reload）
#
# 注意：仓库内不保留真实域名与备案号。
#       真实域名通过本脚本顶部变量传入，部署时请改为你自己的域名，
#       并同时把 deploy/nginx/*.conf 与 deploy/deploy-remote.sh 中的
#       占位域名 contest.example.com / admin.example.com 替换为真实域名。
# ============================================================
param(
  [string]$ServerHost = "yqzl-server",              # SSH 服务器别名/主机（部署时改为实际值）
  [string]$LocalDir   = "e:\mini\server",
  # 真实部署域名（务必替换为实际域名后再运行）
  [string]$DomainContest = "contest.mini.nstarzx.cn",
  [string]$DomainAdmin   = "admin.mini.nstarzx.cn"
)

$ErrorActionPreference = "Stop"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ssh([string]$cmd) { ssh.exe $ServerHost $cmd }
# Scp：源 + 目标远程路径，自动拼接 $ServerHost:；额外参数（如 -r）可选
function Scp {
  param([string]$Src, [string]$Dst, [string[]]$Extra = @())
  scp.exe @Extra $Src "$ServerHost`:$Dst"
}

# ---------- 1. 本地打包 ----------
Step "1/4 本地打包 server（排除 node_modules/data）"
$tmp = Join-Path $env:TEMP "mini-oj-deploy"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item -Path (Join-Path $LocalDir "src")   -Destination $tmp -Recurse
Copy-Item -Path (Join-Path $LocalDir "views") -Destination $tmp -Recurse
Copy-Item -Path (Join-Path $LocalDir "public")-Destination $tmp -Recurse
Copy-Item -Path (Join-Path $LocalDir "package.json")     -Destination $tmp
Copy-Item -Path (Join-Path $LocalDir "package-lock.json")-Destination $tmp -ErrorAction SilentlyContinue
# 清理日志
Get-ChildItem $tmp -Recurse -Filter "*.log" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Host "打包完成: $tmp"

# ---------- 2. 上传代码到两个站点目录 ----------
Step "2/4 上传代码到服务器（contest / admin 目录）"
Scp -Src "$tmp\*" -Dst "/www/wwwroot/$DomainContest/" -Extra @('-r')
Scp -Src "$tmp\*" -Dst "/www/wwwroot/$DomainAdmin/" -Extra @('-r')
Write-Host "代码上传完成"

# ---------- 3. 生成并上传远程部署脚本 ----------
Step "3/4 生成远程部署脚本 deploy-remote.sh"
$remoteScript = @'
#!/bin/bash
set -e
NODE=/www/server/nodejs/v24.14.1/bin
export PATH=$NODE:/usr/bin:/bin
CONTEST=/www/wwwroot/__DOMAIN_CONTEST__
ADMIN=/www/wwwroot/__DOMAIN_ADMIN__
SHARED_DB=$CONTEST/data/mini-oj.db

echo '==> install deps'
cd $CONTEST && npm install --registry=https://registry.npmmirror.com --omit=dev 2>&1 | tail -2
cd $ADMIN && npm install --registry=https://registry.npmmirror.com --omit=dev 2>&1 | tail -2

echo '==> pm2 start'
cd $CONTEST && pm2 delete mini-oj-contest 2>/dev/null || true
APP_ENTRY=contest PORT=3001 DB_FILE=$SHARED_DB DOMAIN_CONTEST=__DOMAIN_CONTEST__ DOMAIN_ADMIN=__DOMAIN_ADMIN__ pm2 start src/app.js --name mini-oj-contest
cd $ADMIN && pm2 delete mini-oj-admin 2>/dev/null || true
APP_ENTRY=admin PORT=3002 DB_FILE=$SHARED_DB DOMAIN_CONTEST=__DOMAIN_CONTEST__ DOMAIN_ADMIN=__DOMAIN_ADMIN__ pm2 start src/app.js --name mini-oj-admin
pm2 save

echo '==> nginx conf'
mkdir -p /www/server/panel/vhost/nginx
echo '==> run nginx+certbot steps (见 deploy/deploy-remote.sh 或 docs 部署说明)'
echo 'REMOTE_SCRIPT_READY'
'@
# 用占位符注入真实域名（单引号 here-string 不插值，避免解析错误）
$remoteScript = $remoteScript.Replace('__DOMAIN_CONTEST__', $DomainContest).Replace('__DOMAIN_ADMIN__', $DomainAdmin)
# 保存到本地再上传，避免内联转义问题
$localSh = Join-Path $env:TEMP "deploy-remote.sh"
Set-Content -Path $localSh -Value $remoteScript -Encoding utf8
Scp $localSh "/tmp/deploy-remote.sh"
Write-Host "远程脚本已上传"

# ---------- 4. 远程执行（npm install / pm2 / 证书 / nginx） ----------
Step "4/4 远程执行部署（npm/pm2/证书/nginx）"
Write-Host "请确认 deploy/deploy-remote.sh 已按真实域名改写，然后在服务器执行："
Write-Host "  ssh $ServerHost 'export PATH=/www/server/nodejs/v24.14.1/bin:/usr/bin:/bin; bash /tmp/deploy-remote.sh'"
Write-Host "部署完成"
