# ============================================================
# Mini-OJ Runno runtime binary fetcher
#
# The Web IDE C/C++/Python browser runtime needs 5 WASI assets
# (~74MB total). They are excluded from git via .gitignore to keep
# the repo small. On a fresh git clone you must restore them.
#
# These binaries come from the Runno project (@runno/wasi, runno.dev)
# and are not distributed as a stable npm package, so this script
# copies from an existing local copy (most reliable).
#
# Usage (in repo root or anywhere):
#   .\deploy\fetch-runno-runtime.ps1                     # copy from local langs dir
#   .\deploy\fetch-runno-runtime.ps1 -Source "D:\backup"  # copy from a given dir
#   .\deploy\fetch-runno-runtime.ps1 -VerifyOnly          # just verify target
# ============================================================
param(
  [string]$Source = "",
  [string]$Target = "server/public/js/runno/langs",
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$Required = @('clang.wasm','wasm-ld.wasm','clang-fs.tar.gz','python-3.11.3.wasm','python-3.11.3.tar.gz')

function Get-Abs($p) {
  if ([System.IO.Path]::IsPathRooted($p)) { return $p }
  return Join-Path (Get-Location) $p
}

$targetAbs = Get-Abs $Target

# --- determine source dir ---
$srcAbs = ""
if ($Source) {
  $srcAbs = Get-Abs $Source
} else {
  $local = Join-Path (Get-Location) "server\public\js\runno\langs"
  if (Test-Path $local) { $srcAbs = $local }
}
if (-not $srcAbs -or -not (Test-Path $srcAbs)) {
  Write-Host "! Source dir not found. Use -Source to point to a dir containing:" -ForegroundColor Yellow
  $Required | ForEach-Object { Write-Host "    $_" }
  Write-Host "These come from an existing deployed server (server/public/js/runno/langs)" -ForegroundColor Yellow
  Write-Host "or the Runno project (@runno/wasi) WASI release channel." -ForegroundColor Yellow
  exit 1
}

# --- verify source completeness ---
$missing = @()
foreach ($f in $Required) {
  if (-not (Test-Path (Join-Path $srcAbs $f))) { $missing += $f }
}
if ($missing.Count) {
  Write-Host "! Source dir missing:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "    $_" }
  exit 1
}
Write-Host "Source complete: $srcAbs" -ForegroundColor Green

# --- verify or copy ---
if ($VerifyOnly) {
  $tMissing = @()
  foreach ($f in $Required) {
    if (-not (Test-Path (Join-Path $targetAbs $f))) { $tMissing += $f }
  }
  if ($tMissing.Count) {
    Write-Host "! Target $targetAbs missing:" -ForegroundColor Red
    $tMissing | ForEach-Object { Write-Host "    $_" }
    exit 1
  }
  Write-Host "Target complete. Runtime assets present." -ForegroundColor Green
  exit 0
}

New-Item -ItemType Directory -Path $targetAbs -Force | Out-Null
$total = 0
foreach ($f in $Required) {
  Copy-Item (Join-Path $srcAbs $f) (Join-Path $targetAbs $f) -Force
  $size = (Get-Item (Join-Path $targetAbs $f)).Length
  $total += $size
  Write-Host ("  [OK] {0,-24} {1,7:N1} MB" -f $f, ($size/1MB))
}
Write-Host ("Done: {0:N1} MB -> {1}" -f ($total/1MB), $targetAbs) -ForegroundColor Green
