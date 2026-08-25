[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Contest1075,

  [Parameter(Mandatory = $true)]
  [string]$Contest1077,

  [ValidateSet('c', 'cpp', 'python', 'java')]
  [string[]]$Languages = @('c', 'cpp', 'python', 'java'),

  [string]$Report = 'output\contest-1075-1077-browser-compat.json',

  [string]$Stream = 'output\contest-1075-1077-browser-compat.jsonl',

  [switch]$Resume,

  [switch]$InventoryOnly,

  [string[]]$RetryCoverage = @(),

  [int]$MaxSubmissions = 0,

  [int]$RunTimeoutMs = 360000
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')
$runner = Join-Path $PSScriptRoot 'contest-archive-browser-compat.mjs'
$contest1075Path = (Resolve-Path -LiteralPath $Contest1075).Path
$contest1077Path = (Resolve-Path -LiteralPath $Contest1077).Path
$reportPath = if ([IO.Path]::IsPathRooted($Report)) { $Report } else { Join-Path $repoRoot $Report }
$streamPath = if ([IO.Path]::IsPathRooted($Stream)) { $Stream } else { Join-Path $repoRoot $Stream }

$runnerArgs = @(
  $runner,
  '--archive', $contest1075Path,
  '--archive', $contest1077Path,
  '--languages', ($Languages -join ','),
  '--report', $reportPath,
  '--stream', $streamPath,
  '--run-timeout-ms', [string]$RunTimeoutMs
)

if ($Resume) { $runnerArgs += '--resume' }
$effectiveRetryCoverage = @($RetryCoverage)
if ($Resume -and $effectiveRetryCoverage.Count -eq 0) {
  $effectiveRetryCoverage = @('environment_gap', 'compatibility_runtime_failure')
}
if ($effectiveRetryCoverage.Count -gt 0) {
  $runnerArgs += @('--retry-coverage', ($effectiveRetryCoverage -join ','))
}
if ($InventoryOnly) { $runnerArgs += '--inventory-only' }
if ($MaxSubmissions -gt 0) { $runnerArgs += @('--max-submissions', [string]$MaxSubmissions) }

Write-Host "[contest-replay] repository: $repoRoot"
Write-Host "[contest-replay] languages: $($Languages -join ',')"
Write-Host "[contest-replay] report: $reportPath"
Write-Host "[contest-replay] stream: $streamPath"
Write-Host '[contest-replay] press Ctrl+C once to stop safely; rerun with -Resume to continue'

Push-Location $repoRoot
try {
  & node @runnerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "contest browser replay exited with code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
