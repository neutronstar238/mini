# Restore the frozen Pyodide 0.26.4 browser runtime and verify every asset.
# Usage:
#   .\deploy\fetch-pyodide-runtime.ps1
#   .\deploy\fetch-pyodide-runtime.ps1 -VerifyOnly
param(
  [string]$Target = "server/public/js/pyodide",
  [string]$BaseUrl = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full",
  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"

$Assets = [ordered]@{
  "pyodide-lock.json" = "cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0"
  "pyodide.js" = "c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7"
  "pyodide.mjs" = "7f24c6655a79eacf0061d3d4e6a60dc0b1938812d15c52d7ff8b37d9e0689e51"
  "pyodide.asm.js" = "919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed"
  "pyodide.asm.wasm" = "b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94"
  "python_stdlib.zip" = "72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336"
}

function Resolve-TargetPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
  return Join-Path (Get-Location) $Path
}

function Assert-Asset([string]$Path, [string]$ExpectedHash) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Missing runtime asset: $Path"
  }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedHash) {
    throw "SHA-256 mismatch for $Path`nexpected: $ExpectedHash`nactual:   $actual"
  }
}

$targetAbs = Resolve-TargetPath $Target
if (-not $VerifyOnly) {
  New-Item -ItemType Directory -Path $targetAbs -Force | Out-Null
}

foreach ($entry in $Assets.GetEnumerator()) {
  $name = $entry.Key
  $expectedHash = $entry.Value
  $destination = Join-Path $targetAbs $name

  if (-not $VerifyOnly) {
    $partial = "$destination.part"
    try {
      Invoke-WebRequest -Uri "$BaseUrl/$name" -OutFile $partial -UseBasicParsing
      Assert-Asset $partial $expectedHash
      Move-Item -LiteralPath $partial -Destination $destination -Force
    } finally {
      if (Test-Path -LiteralPath $partial) {
        Remove-Item -LiteralPath $partial -Force
      }
    }
  }

  Assert-Asset $destination $expectedHash
  $sizeMb = (Get-Item -LiteralPath $destination).Length / 1MB
  Write-Host ("  [OK] {0,-20} {1,6:N1} MB" -f $name, $sizeMb) -ForegroundColor Green
}

Write-Host "Pyodide 0.26.4 runtime verified: $targetAbs" -ForegroundColor Green
