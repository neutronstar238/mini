# ============================================================
# Mini-OJ Runno runtime binary fetcher
#
# The Web IDE C/C++ browser runtime needs 3 WASI assets
# (~50MB total). They are excluded from git via .gitignore to keep
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

$Required = [ordered]@{
  'clang.wasm'      = '2A466F0E990329D3230B869D04FC20803EAE96A7FEB3A3F6C93E25A77B8AED1D'
  'wasm-ld.wasm'    = '36419ED202011765222098D7701218378B67F634D50F0A4625059AE2C9860F48'
  'clang-fs.tar.gz' = 'B2E4B0F28A2C56B80CA43B61DC1CA2B62B8263B582735504E6C376FED4B1F363'
}

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
  $Required.Keys | ForEach-Object { Write-Host "    $_" }
  Write-Host "These come from an existing deployed server (server/public/js/runno/langs)" -ForegroundColor Yellow
  Write-Host "or the Runno project (@runno/wasi) WASI release channel." -ForegroundColor Yellow
  exit 1
}

# --- verify source completeness ---
$missing = @()
foreach ($f in $Required.Keys) {
  if (-not (Test-Path (Join-Path $srcAbs $f))) { $missing += $f }
}
if ($missing.Count) {
  Write-Host "! Source dir missing:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "    $_" }
  exit 1
}
Write-Host "Source complete: $srcAbs" -ForegroundColor Green

foreach ($f in $Required.Keys) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $srcAbs $f)).Hash
  if ($actual -ne $Required[$f]) {
    Write-Host "! Source hash mismatch: $f" -ForegroundColor Red
    Write-Host "  expected $($Required[$f])"
    Write-Host "  actual   $actual"
    exit 1
  }
}
Write-Host "Source hashes verified." -ForegroundColor Green

# --- verify or copy ---
if ($VerifyOnly) {
  $tMissing = @()
  foreach ($f in $Required.Keys) {
    if (-not (Test-Path (Join-Path $targetAbs $f))) { $tMissing += $f }
  }
  if ($tMissing.Count) {
    Write-Host "! Target $targetAbs missing:" -ForegroundColor Red
    $tMissing | ForEach-Object { Write-Host "    $_" }
    exit 1
  }
  foreach ($f in $Required.Keys) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $targetAbs $f)).Hash
    if ($actual -ne $Required[$f]) {
      Write-Host "! Target hash mismatch: $f" -ForegroundColor Red
      exit 1
    }
  }
  Write-Host "Target complete. Runtime asset hashes verified." -ForegroundColor Green
  exit 0
}

New-Item -ItemType Directory -Path $targetAbs -Force | Out-Null
$total = 0
foreach ($f in $Required.Keys) {
  $sourceFile = Join-Path $srcAbs $f
  $targetFile = Join-Path $targetAbs $f
  if ([System.IO.Path]::GetFullPath($sourceFile) -ne [System.IO.Path]::GetFullPath($targetFile)) {
    Copy-Item -LiteralPath $sourceFile -Destination $targetFile -Force
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $targetFile).Hash
  if ($actual -ne $Required[$f]) { throw "Copied asset hash mismatch: $f" }
  $size = (Get-Item -LiteralPath $targetFile).Length
  $total += $size
  Write-Host ("  [OK] {0,-24} {1,7:N1} MB" -f $f, ($size/1MB))
}
Write-Host ("Done: {0:N1} MB -> {1}" -f ($total/1MB), $targetAbs) -ForegroundColor Green
