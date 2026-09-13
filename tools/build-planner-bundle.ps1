# Build the self-contained planner runtime bundle (route B) and gate it with a real boot.
#
# Steps:
#   1) precompile lcode/planner (esbuild, single ESM file, bare specifiers external)
#   2) static runtime import-closure analysis over the built DSH CLI + that file
#   3) materialize the bundle into lcode/desktop/resources/planner
#   4) BOOT GATE: copy the bundle to a temp dir, start it with Electron's own Node
#      (ELECTRON_RUN_AS_NODE=1), poll /api/planner/health, then kill it.
#
# The boot gate is not optional decoration: static analysis cannot see native
# binaries pulled in through optionalDependencies (koffi -> @koromix/koffi-*),
# so only a real start proves the closure is complete. Use -SkipBoot only when
# iterating on the scripts themselves.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
[CmdletBinding()]
param(
  [string]$DshRepo = $env:LCORE_DSH_REPO,
  [string]$ElectronExe = '',
  [string]$Out = '',
  [switch]$SkipBoot,
  [int]$BootTimeoutSec = 60
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($DshRepo)) {
  $DshRepo = Join-Path (Split-Path -Parent $root) 'deepseek\deepseek-harness-master'
}
$env:LCORE_DSH_REPO = $DshRepo

if (-not (Test-Path (Join-Path $DshRepo 'apps\cli\lib\bin.js'))) {
  Write-Host "[fail] DSH build output not found: $DshRepo\apps\cli\lib\bin.js" -ForegroundColor Red
  Write-Host "       Build the DSH checkout first (pnpm build), or pass -DshRepo."
  exit 1
}

$bundleDir = Join-Path $PSScriptRoot 'planner-bundle'
if ([string]::IsNullOrWhiteSpace($Out)) {
  $Out = Join-Path $root 'lcode\desktop\resources\planner'
}

Write-Host "== planner bundle build ==" -ForegroundColor Cyan
Write-Host "  dsh    : $DshRepo"
Write-Host "  out    : $Out"

Write-Host "`n[1/4] precompile planner" -ForegroundColor Cyan
& node (Join-Path $bundleDir 'build-planner.mjs')
if ($LASTEXITCODE -ne 0) { Write-Host "[fail] build-planner.mjs" -ForegroundColor Red; exit 1 }

Write-Host "`n[2/4] analyze runtime import closure" -ForegroundColor Cyan
& node (Join-Path $bundleDir 'analyze-imports.mjs')
if ($LASTEXITCODE -ne 0) { Write-Host "[fail] analyze-imports.mjs" -ForegroundColor Red; exit 1 }

Write-Host "`n[3/4] materialize bundle" -ForegroundColor Cyan
& node (Join-Path $bundleDir 'build-bundle.mjs') $Out
if ($LASTEXITCODE -ne 0) {
  Write-Host "[fail] build-bundle.mjs (incomplete closure - see FATAL list above)" -ForegroundColor Red
  exit 1
}

if ($SkipBoot) {
  Write-Host "`n[4/4] boot gate SKIPPED (-SkipBoot)" -ForegroundColor Yellow
  exit 0
}

Write-Host "`n[4/4] boot gate (Electron-as-Node + /api/planner/health)" -ForegroundColor Cyan
if ([string]::IsNullOrWhiteSpace($ElectronExe)) {
  if ($env:ELECTRON_OVERRIDE_DIST_PATH) {
    $ElectronExe = Join-Path $env:ELECTRON_OVERRIDE_DIST_PATH 'electron.exe'
  } else {
    $ElectronExe = Join-Path $root 'lcode\desktop\node_modules\electron\dist\electron.exe'
  }
}
if (-not (Test-Path $ElectronExe)) {
  Write-Host "[fail] electron.exe not found: $ElectronExe (pass -ElectronExe)" -ForegroundColor Red
  exit 1
}

$nodeVersion = & cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$ElectronExe`" -e `"console.log(process.versions.node)`""
Write-Host "  electron node version: $nodeVersion"
$parts = $nodeVersion.Trim().Split('.')
$major = [int]$parts[0]; $minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
  Write-Host "[fail] Electron bundled Node $nodeVersion is too old: DSH needs >=22.19 (Electron >=36.9)." -ForegroundColor Red
  Write-Host "       The bundle would import-fail on node:zlib createZstdDecompress."
  exit 1
}

$tmp = Join-Path $env:TEMP ('planner-boot-gate-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$port = 18999
Write-Host "  staging to $tmp (this copy is what the app does on first run)"
Copy-Item $Out $tmp -Recurse -Force

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = Join-Path $tmp 'home'
$env:LCORE_PLANNER_PORT = [string]$port
$env:LCORE_PLANNER_TOKEN = 'boot-gate'
$env:LCORE_KERNEL_URL = 'http://127.0.0.1:1'
$env:LCORE_KERNEL_TOKEN = 'boot-gate'
$env:LCORE_SESSION_ROOT = Join-Path $tmp 'sessions'
$env:LCORE_CWD = $tmp
# Placeholder, deliberately NOT shaped like a real key: a literal "sk-..." here trips GitHub's
# secret scanning / push protection on the public repo (measured).
$env:DEEPSEEK_API_KEY = 'boot-gate-placeholder-not-a-key'
$env:DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'
Remove-Item Env:LCORE_TRACE -ErrorAction SilentlyContinue

$outLog = Join-Path $tmp 'boot.out'
$errLog = Join-Path $tmp 'boot.err'
$proc = Start-Process -FilePath $ElectronExe `
  -ArgumentList (Join-Path $tmp 'apps\cli\lib\bin.js'), '--profile', 'lcode-planner' `
  -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$ok = $false
$body = ''
for ($i = 0; $i -lt $BootTimeoutSec; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/planner/health" `
      -Headers @{ 'X-Planner-Token' = 'boot-gate' } -TimeoutSec 3 -UseBasicParsing
    $body = $r.Content
    $ok = $true
    break
  } catch { }
}

if (-not $ok) {
  Write-Host "[fail] planner did not answer health within $BootTimeoutSec s" -ForegroundColor Red
  if (Test-Path $errLog) { Get-Content $errLog -Tail 25 }
  if (Test-Path $outLog) { Get-Content $outLog -Tail 10 }
} else {
  Write-Host "[ok] health 200: $body" -ForegroundColor Green
}

if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$tmp*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

if (-not $ok) { exit 1 }
Write-Host "`n[done] bundle ready at $Out" -ForegroundColor Green
