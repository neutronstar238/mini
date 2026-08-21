<#
=============================================================
fetch-modern-clang.ps1 — 拉取 Modern Clang 浏览器运行时资产
=============================================================
 状态 (2026-08-21) : PENDING — Modern Clang browser-runnable binary 不可获取
   - binji/wasm-clang 是唯一 browser-runnable Clang WASM（Clang ~8 alpha）
   - WASI SDK 27 是 native 工具链，不是 browser-runnable
   - 自建 llvm-project wasm-emscripten port 待 Linux 构建机执行
   本脚本为占位：下载源待 self-build 完成 + 上游 commit 锁定后填实。
   哈希校验模式沿用 fetch-runno-runtime.ps1（SHA-256 + 多源 fallback）。
=============================================================
#>

[CmdletBinding()]
param(
    [string]$OutputDir = (Join-Path $PSScriptRoot '..\server\public\js\runtime\cpp-modern-v1'),
    [string]$UpstreamCommit = '',  # 自建 llvm-project 完成后填实
    [switch]$VerifyOnly,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# 资产清单（待 self-build commit 锁定后填实真实 URL）
$assets = @(
    @{
        Name = 'clang.wasm'
        UrlCandidates = @(
            # self-built llvm-project wasm-emscripten port
            # 'https://github.com/mini-oj/cpp-modern-v1-build/releases/download/v1-build-{0}/clang.wasm' -f $UpstreamCommit
        )
        ExpectedSha256 = 'PENDING_SELF_BUILD'
        Note = '待 self-build 完成后填入真实上游 URL + SHA-256'
    },
    @{
        Name = 'lld.wasm'
        UrlCandidates = @()
        ExpectedSha256 = 'PENDING_SELF_BUILD'
        Note = 'wasm-ld.wasm — 自建产物'
    },
    @{
        Name = 'libc++.a'
        UrlCandidates = @()
        ExpectedSha256 = 'PENDING_SELF_BUILD'
        Note = 'libc++19.a — 自建产物'
    },
    @{
        Name = 'libc++abi.a'
        UrlCandidates = @()
        ExpectedSha256 = 'PENDING_SELF_BUILD'
        Note = 'libc++abi19.a — 自建产物'
    },
    @{
        Name = 'wasi-sysroot.tar'
        UrlCandidates = @(
            'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-27/wasi-sdk-27.0-x86_64-linux.tar.gz'
            'https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-26/wasi-sdk-26.0-x86_64-linux.tar.gz'
        )
        ExpectedSha256 = 'PENDING_SELF_BUILD'
        Note = 'WASI sysroot — 从 wasi-sdk release 抽取'
    },
    @{
        Name = 'loader.mjs'
        UrlCandidates = @()
        ExpectedSha256 = 'PENDING_SELF_BUILD'
        Note = 'Mini-OJ worker adapter — 独立实现，不复用 binji'
    }
)

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Write-Host "[fetch-modern-clang] PENDING — assets 不可下载" -ForegroundColor Yellow
Write-Host "[fetch-modern-clang] 当前唯一参考 binji/wasm-clang 是 Clang ~8 alpha demo（无 memfs.tar 不可直接用）" -ForegroundColor Yellow
Write-Host "[fetch-modern-clang] WASI SDK 27 是 native 工具链，不是 browser-runnable" -ForegroundColor Yellow
Write-Host "[fetch-modern-clang] 自建 llvm-project wasm-emscripten port 待 Linux 构建机执行" -ForegroundColor Yellow
Write-Host ""
Write-Host "[fetch-modern-clang] 本脚本提供 SHA-256 + 多源 fallback 的下载模板" -ForegroundColor Cyan
Write-Host "[fetch-modern-clang] 待 self-build commit 锁定后填实 -UpstreamCommit 与各资产 ExpectedSha256 字段" -ForegroundColor Cyan
Write-Host ""

if ($VerifyOnly) {
    Write-Host "[fetch-modern-clang] verify-only: 跳过下载，仅校验 OutputDir 当前文件"
    foreach ($a in $assets) {
        $p = Join-Path $OutputDir $a.Name
        if (Test-Path $p) {
            $h = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
            Write-Host "  $($a.Name): $h  size=$((Get-Item $p).Length)"
        } else {
            Write-Host "  $($a.Name): MISSING"
        }
    }
    exit 0
}

# 实际下载（占位 —— 当前所有资产 ExpectedSha256=PENDING_SELF_BUILD，禁止下载错误版本）
foreach ($a in $assets) {
    $p = Join-Path $OutputDir $a.Name
    if ((Test-Path $p) -and (-not $Force)) {
        Write-Host "[fetch-modern-clang] skip $($a.Name): already exists (-Force to overwrite)"
        continue
    }
    if ($a.UrlCandidates.Count -eq 0) {
        Write-Host "[fetch-modern-clang] skip $($a.Name): no upstream URL (PENDING self-build)"
        continue
    }
    Write-Host "[fetch-modern-clang] fetching $($a.Name)..."
    $downloaded = $false
    foreach ($u in $a.UrlCandidates) {
        try {
            Write-Host "  trying $u"
            Invoke-WebRequest -Uri $u -OutFile $p -UseBasicParsing -ErrorAction Stop
            $h = (Get-FileHash $p -Algorithm SHA256).Hash.ToLower()
            if ($a.ExpectedSha256 -ne 'PENDING_SELF_BUILD' -and $h -ne $a.ExpectedSha256.ToLower()) {
                Write-Host "  HASH MISMATCH: expected $($a.ExpectedSha256) got $h" -ForegroundColor Red
                Remove-Item $p -Force
                continue
            }
            Write-Host "  OK: $h"
            $downloaded = $true
            break
        } catch {
            Write-Host "  failed: $_"
            continue
        }
    }
    if (-not $downloaded) {
        Write-Host "[fetch-modern-clang] FAIL: cannot download $($a.Name)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "[fetch-modern-clang] done"