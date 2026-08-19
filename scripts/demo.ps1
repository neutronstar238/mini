# ============================================================
# Mini-OJ 一键演示脚本
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\demo.ps1
# 作用：启动 server → 注册并启动本地评测机 → 提交示例 → 打开浏览器
# ============================================================
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root     = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Server   = Join-Path $Root "server"
$Local    = Join-Path $Root "local"
$BaseUrl  = "http://localhost:3000"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---- 0. 环境预检 ----
Step "环境预检（本机需已有 Node.js 与 g++/python，缺失时请先运行 local/bootstrap.ps1）"
node -v
try { g++ --version | Select-Object -First 1 } catch { Write-Warning "g++ 不可用，将跳过 C++ 示例" }
try { python --version } catch { Write-Warning "python 不可用，将跳过 Python 示例" }

# ---- 1. 启动 server ----
Step "启动服务端 $BaseUrl"
Push-Location $Server
if (-not (Test-Path "node_modules")) {
    npm install --registry=https://registry.npmmirror.com
}
Start-Process -FilePath "node" -ArgumentList "src/app.js" -WorkingDirectory $Server -WindowStyle Hidden
Pop-Location
Start-Sleep 2

# 健康检查
$ok = $false
foreach ($i in 1..10) {
    try { Invoke-WebRequest -Uri "$BaseUrl/api/problems" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true; break }
    catch { Start-Sleep 1 }
}
if (-not $ok) { Write-Error "server 启动失败"; exit 1 }
Write-Host "server 就绪" -ForegroundColor Green

# ---- 2. 生成注册码并启动本地评测机 ----
Step "注册并启动本地评测机"
$admin = Invoke-RestMethod -Uri "$BaseUrl/api/auth/login" -Method Post -ContentType "application/json" `
    -Body '{"username":"admin","password":"admin123"}'
$H = @{ Authorization = "Bearer $($admin.token)" }
$code = Invoke-RestMethod -Uri "$BaseUrl/api/devices/register-codes" -Method Post -Headers $H

Push-Location $Local
if (Test-Path "device.json") {
    Write-Host "复用已注册设备 device.json" -ForegroundColor DarkCyan
} else {
    node index.js --register $($code.code.code) --server $BaseUrl --name DEMO | Out-Host
}
Pop-Location
Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $Local -WindowStyle Hidden
Start-Sleep 5
Write-Host "评测机已启动" -ForegroundColor Green

# ---- 3. 提交演示样例 ----
Step "提交示例代码（AC / WA / TLE）"
$user = Invoke-RestMethod -Uri "$BaseUrl/api/auth/login" -Method Post -ContentType "application/json" `
    -Body '{"username":"user1","password":"user123"}'
$U = @{ Authorization = "Bearer $($user.token)" }
$probs = Invoke-RestMethod -Uri "$BaseUrl/api/problems" -Headers $U
$ab = ($probs.problems | Where-Object { $_.title -like "A + B*" })[0]
$loop = ($probs.problems | Where-Object { $_.title -like "*循环*" })[0]

$subs = @()
$subs += Invoke-RestMethod -Uri "$BaseUrl/api/submissions" -Method Post -ContentType "application/json" -Headers $U `
    -Body (@{problemId=$ab.id; language="cpp"; code="#include <iostream>`nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b;}" } | ConvertTo-Json)
$subs += Invoke-RestMethod -Uri "$BaseUrl/api/submissions" -Method Post -ContentType "application/json" -Headers $U `
    -Body (@{problemId=$ab.id; language="cpp"; code="#include <iostream>`nint main(){int a,b;std::cin>>a>>b;std::cout<<a-b;}" } | ConvertTo-Json)
$subs += Invoke-RestMethod -Uri "$BaseUrl/api/submissions" -Method Post -ContentType "application/json" -Headers $U `
    -Body (@{problemId=$loop.id; language="python"; code="n=int(input())`ns=0`nfor i in range(1,n+1): s+=i`nprint(s)"} | ConvertTo-Json)
Write-Host "已提交 $($subs.Count) 份，等待本地评测机评测…" -ForegroundColor DarkCyan

Start-Sleep 20
Step "评测结果"
$recs = Invoke-RestMethod -Uri "$BaseUrl/api/submissions?pageSize=3" -Headers $U
foreach ($s in $recs.submissions) {
    Write-Host ("  {0} [{1}] {2} => {3}" -f $s.id.Substring(0,8), $s.problemTitle, $s.language, $s.status) `
        -ForegroundColor $(if ($s.status -eq "AC") { "Green" } elseif ($s.status -eq "WA") { "Red" } else { "Yellow" })
}

# ---- 4. 打开浏览器 ----
Step "打开演示页面"
Start-Process "$BaseUrl/login"
Write-Host @"
演示入口：
  题目列表   $BaseUrl/problems        （选手 user1/user123）
  评测记录   $BaseUrl/submissions     （实时状态刷新）
  管理后台   $BaseUrl/admin           （admin/admin123）
  设备监控   $BaseUrl/admin/devices   （SSE 实时事件流）
  队列大屏   $BaseUrl/queue-screen
"@ -ForegroundColor Green
