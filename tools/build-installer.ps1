# ============================================================================
#  build-installer.ps1 -- one-shot installer build for LCode
#
#  Produces Windows installers (NSIS setup + portable):
#     -Variant base  : no ESP-IDF bundled  (for users who already have IDF)
#     -Variant full  : ESP-IDF bundled      (works out of the box)
#     -Variant all   : both
#
#  Usage (from anywhere; or double-click the Chinese-named .bat launcher in the repo root
#  for a numbered menu):
#     powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1 -Variant full
#     powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1 -Variant all -KernelMode light
#
#  Params:
#     -Variant        base | full | all                    (default: full)
#     -KernelMode     auto | light | kb                    (default: auto)
#                     auto = include the private KB when lcode_kb is installed in the
#                            kernel venv (much bigger installer), otherwise light
#                     light = frozen kernel without the KB (stub mode, ~95 MB)
#                     kb    = force include the KB (torch; +1.1 GB, slow)
#     -EspIdfSrc      source ESP-IDF install for staging    (default: D:\esp)
#     -EspIdfTargets  comma separated chip targets          (default: esp32s3)
#     -RebuildKernel  force re-freezing the kernel
#     -RestageEspIdf  force re-staging the ESP-IDF payload
#     -SkipTypecheck  skip desktop typecheck
#
#  What it does (fail-fast at every step):
#     1. checks prerequisites (node_modules, kernel venv, electron-builder)
#     2. freezes the kernel into lcode/desktop/resources/kernel
#     3. stages the ESP-IDF payload into lcode/desktop/resources/esp-idf (full only)
#     4. desktop typecheck + electron-vite build
#     5. electron-builder for the requested variant(s)
#     6. prints an artifact table
#
#  Notes:
#   * Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
#     and non-ASCII characters (Chinese comments, filenames) break parsing.
#   * The ESP-IDF payload (~2.4 GB) and the frozen kernel are build artifacts:
#     they are gitignored and excluded from the public export.
#   * Cross-platform reality: the kernel binary and the ESP-IDF toolchain are
#     OS-specific. Run this on Windows for Windows; macOS/Linux builds need their
#     own runner (see the packaging guide in docs/ sections 2 and 11, plus the one-click doc).
# ============================================================================
[CmdletBinding()]
param(
    [ValidateSet('base', 'full', 'all')]
    [string]$Variant = 'full',
    [ValidateSet('auto', 'light', 'kb')]
    [string]$KernelMode = 'auto',
    [string]$EspIdfSrc = 'D:\esp',
    [string]$EspIdfTargets = 'esp32s3',
    [switch]$RebuildKernel,
    [switch]$RestageEspIdf,
    [switch]$SkipTypecheck
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Desktop = Join-Path $Root 'lcode\desktop'
$Kernel = Join-Path $Root 'lcode\kernel'
$KernelVenvPy = Join-Path $Kernel '.venv\Scripts\python.exe'
$KernelExe = Join-Path $Desktop 'resources\kernel\lcode-kernel.exe'
$EspIdfPayload = Join-Path $Desktop 'resources\esp-idf'
$Dist = Join-Path $Desktop 'dist'

function Step([string]$msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg) { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Warn2([string]$msg) { Write-Host "    [warn] $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "    [FAIL] $msg" -ForegroundColor Red; exit 1 }

Write-Host '============================================================' -ForegroundColor White
Write-Host ' LCode installer build' -ForegroundColor White
Write-Host " variant=$Variant  kernel=$KernelMode  esp-idf-src=$EspIdfSrc" -ForegroundColor White
Write-Host '============================================================' -ForegroundColor White
Write-Host "repo root : $Root"

# ---------------------------------------------------------------- 1. checks
Step '1/6 checking prerequisites'
if (-not (Test-Path (Join-Path $Desktop 'package.json'))) { Fail "desktop package.json not found: $Desktop" }
if (-not (Test-Path (Join-Path $Desktop 'node_modules\electron-builder'))) {
    Fail "electron-builder missing. Run: cd lcode\desktop; npm install"
}
if (-not (Test-Path $KernelVenvPy)) { Fail "kernel venv python not found: $KernelVenvPy (see lcode\kernel\README.md)" }
Ok 'desktop deps + kernel venv present'

# ---------------------------------------------------------------- 2. kernel
Step '2/6 freezing the kernel (PyInstaller)'
$needKernel = $RebuildKernel -or -not (Test-Path $KernelExe)
if (-not $needKernel) {
    $age = (Get-Date) - (Get-Item $KernelExe).LastWriteTime
    Warn2 ("existing frozen kernel kept (built {0:N1} h ago, {1:N0} MB). Use -RebuildKernel to refresh." -f $age.TotalHours, ((Get-Item $KernelExe).Length / 1MB))
}

# decide KB inclusion
$kbInstalled = $false
try {
    & $KernelVenvPy -c "import lcode_kb" 2>$null
    if ($LASTEXITCODE -eq 0) { $kbInstalled = $true }
} catch { $kbInstalled = $false }

$useKb = $false
switch ($KernelMode) {
    'light' { $useKb = $false }
    'kb' { $useKb = $true }
    'auto' { $useKb = $kbInstalled }
}
if ($useKb -and -not $kbInstalled) { Fail "-KernelMode kb requested but lcode_kb is not installed in the kernel venv" }
if (-not $useKb -and $kbInstalled) {
    Warn2 'KB excluded from the frozen kernel (stub mode: datasheet retrieval returns empty). Use -KernelMode kb to include it.'
}

if ($needKernel) {
    $kbArg = @()
    if (-not $useKb) { $kbArg = @('--no-kb') }
    Write-Host "    python $KernelVenvPy scripts\build_kernel.py $($kbArg -join ' ')"
    Push-Location $Kernel
    try {
        & $KernelVenvPy 'scripts\build_kernel.py' @kbArg
        if ($LASTEXITCODE -ne 0) { Fail "kernel build failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
    if (-not (Test-Path $KernelExe)) { Fail "kernel exe still missing after build: $KernelExe" }
    Ok ("kernel frozen: {0:N0} MB" -f ((Get-ChildItem (Split-Path $KernelExe) -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))
} else {
    Ok 'kernel already frozen (reused)'
}

# ---------------------------------------------------------------- 3. esp-idf
if ($Variant -eq 'base') {
    Step '3/6 ESP-IDF payload (skipped: base variant)'
    if (Test-Path $EspIdfPayload) {
        Warn2 "payload exists at resources\esp-idf and WILL NOT be bundled for the base variant (wasted build time only)"
    }
} else {
    Step '3/6 staging the ESP-IDF payload'
    $manifest = Join-Path $EspIdfPayload 'manifest.json'
    if ($RestageEspIdf) { if (Test-Path $EspIdfPayload) { Remove-Item $EspIdfPayload -Recurse -Force } }
    if (Test-Path $manifest) {
        $m = Get-Content $manifest -Raw | ConvertFrom-Json
        Warn2 "existing payload kept: IDF $($m.idf_version), targets $($m.targets -join ','), generated $($m.generated_at). Use -RestageEspIdf to regenerate."
    } else {
        if (-not (Test-Path $EspIdfSrc)) {
            Fail "ESP-IDF source not found: $EspIdfSrc. Install ESP-IDF, or pass -EspIdfSrc <path>, or build the 'base' variant instead."
        }
        Write-Host "    python tools\stage-esp-idf.py --src $EspIdfSrc --targets $EspIdfTargets"
        & $KernelVenvPy (Join-Path $Root 'tools\stage-esp-idf.py') --src $EspIdfSrc --targets $EspIdfTargets
        if ($LASTEXITCODE -ne 0) { Fail "ESP-IDF staging failed (exit $LASTEXITCODE)" }
        if (-not (Test-Path $manifest)) { Fail "payload manifest missing after staging: $manifest" }
        Ok ("payload staged: {0:N0} MB" -f ((Get-ChildItem $EspIdfPayload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB))
    }
}

# ---------------------------------------------------------------- 4. desktop build
Step '4/6 building the desktop app'

# Guard: electron-builder copies resources\kernel; if that exe is locked (antivirus scan or a
# leftover kernel process) it fails with "EBUSY: resource busy or locked, copyfile ..." and the
# message drowns in signing noise (hit this once). Verify an exclusive open first so we do not
# waste a long packaging run.
if (Test-Path $KernelExe) {
    $locked = $true
    for ($i = 1; $i -le 6; $i++) {
        try {
            $fs = [System.IO.File]::Open($KernelExe, 'Open', 'ReadWrite', 'None')
            $fs.Close()
            $locked = $false
            break
        } catch {
            Warn2 "kernel exe is locked (attempt $i/6), waiting 5s ..."
            Start-Sleep -Seconds 5
        }
    }
    if ($locked) {
        Fail "kernel exe is locked by another process: $KernelExe -- close any running LCode/kernel instance (or antivirus scan) and retry"
    }
    Ok 'kernel exe is not locked'
}

Push-Location $Desktop
try {
    if (-not $SkipTypecheck) {
        & npm run typecheck
        if ($LASTEXITCODE -ne 0) { Fail "typecheck failed (exit $LASTEXITCODE)" }
        Ok 'typecheck clean'
    } else { Warn2 'typecheck skipped' }
    & npx electron-vite build
    if ($LASTEXITCODE -ne 0) { Fail "electron-vite build failed (exit $LASTEXITCODE)" }
    Ok 'renderer/main/preload built into out\'
} finally { Pop-Location }

# ---------------------------------------------------------------- 5. installers
function Build-Variant([string]$v, [switch]$KeepDist) {
    $cfgArgs = @()
    if ($v -eq 'full') { $cfgArgs = @('--config', 'electron-builder.full.yml') }
    Step "5/6 electron-builder ($v)"
    # CSC_IDENTITY_AUTO_DISCOVERY=false: with no code-signing certificate, stop probing every
    # small exe for an identity (the ESP-IDF payload has ~1000 exes; that flooded the log and
    # slowed packaging noticeably).
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

    # Clean dist first: overwriting a leftover kernel exe from a previous run can fail with
    # "EBUSY: resource busy or locked" when antivirus/indexer is still scanning that file
    # (hit twice). A fresh destination avoids the overwrite entirely.
    if (-not $KeepDist -and (Test-Path $Dist)) {
        Write-Host "    cleaning $Dist (build output)"
        Remove-Item $Dist -Recurse -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }

    Push-Location $Desktop
    try {
        & npx electron-builder --win @cfgArgs --publish never
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            # One retry: transient EBUSY (antivirus) usually clears within seconds.
            Warn2 "electron-builder failed (exit $code) -- retrying once after 20s (transient file lock?)"
            Start-Sleep -Seconds 20
            & npx electron-builder --win @cfgArgs --publish never
            $code = $LASTEXITCODE
        }
        if ($code -ne 0) { Fail "electron-builder failed for variant '$v' (exit $code)" }
    } finally { Pop-Location }
    Ok "variant '$v' done"
}

if ($Variant -eq 'all') {
    Build-Variant 'base'
    Build-Variant 'full' -KeepDist
} else {
    Build-Variant $Variant
}

# ---------------------------------------------------------------- 6. report
Step '6/6 artifacts'
if (-not (Test-Path $Dist)) { Fail "dist dir not found: $Dist" }
$files = Get-ChildItem $Dist -File -Include '*.exe', '*.blockmap' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*uninstaller*' } |
    Sort-Object Length -Descending
if (-not $files) { Warn2 "no artifacts matched in $Dist" }
foreach ($f in $files) {
    Write-Host ("    {0,-52} {1,9:N1} MB" -f $f.Name, ($f.Length / 1MB)) -ForegroundColor White
}
Write-Host ''
Write-Host 'next steps:' -ForegroundColor Cyan
Write-Host '  * silent install test (admin shell not required):'
Write-Host '      LCode-<ver>-win-x64-setup-full.exe /S /D=D:\tmp\lcode-install'
Write-Host '  * verify checklist: docs (packaging guide) section 9'
Write-Host '  * code signing / notarization: docs (packaging guide) section 5'
