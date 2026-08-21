[CmdletBinding()]
param(
  [switch]$Clean,
  [switch]$NoPublish,
  [string]$Out,
  [string]$BuildRoot,
  [string]$PublishDir,
  [int]$Jobs = 0,
  [string]$Image = 'browserjdk-oj-build:emsdk-5.0.2'
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $Out) { $Out = '/work/repository/modern-clang-oj/out' }
if (-not $BuildRoot) { $BuildRoot = '/work/engine/build' }
if (-not $PublishDir) { $PublishDir = '/work/repository/server/public/js/runtime/cpp-modern-engine-v1' }
$Repo = $Root
$ImageId = (docker image inspect $Image --format '{{.Id}}').Trim()
$args = @('/bin/bash','/work/repository/modern-clang-oj/scripts/build-modern-clang.sh')
if ($Clean) { $args += '--clean' }
if ($NoPublish) { $args += '--no-publish' }
$args += @('--out',$Out,'--build-root',$BuildRoot,'--publish',$PublishDir)
if ($Jobs -gt 0) { $args += @('--jobs',$Jobs) }
docker run --rm --init `
  -e "MODERN_CLANG_IMAGE_ID=$ImageId" `
  -e "SRC_DIR=/work/engine/src" `
  -v 'modern-clang-engine-cache:/work/engine' `
  -v "${Repo}:/work/repository" `
  -w /work/repository/modern-clang-oj `
  $Image @args
if ($LASTEXITCODE -ne 0) { throw "Modern Clang build failed with exit code $LASTEXITCODE" }
