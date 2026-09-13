# ============================================================================
#  publish-public.ps1 -- sync the workspace into the public export and push it
#
#  Use this whenever you changed something under D:\1_ai_project\mcu_ai_agent and want
#  it on GitHub (neasonli/lcode).
#
#  The workspace is the source of truth; the export dir is a generated mirror.
#  NEVER edit files inside the export dir - the next export overwrites them.
#
#  Pipeline (fail-fast at every step):
#     1. tools\make-public-export.ps1   workspace -> <parent>\lcode-public-export (whitelist + secret scan)
#     2. tools\audit-public-export.py   independent second-opinion audit (must print PASS)
#     3. git status                     show what actually changed
#     4. git commit                     with -Message (or an auto message)
#     5. git push origin main           over SSH (see ~/.ssh/config: github.com -> ssh.github.com:443)
#
#  Usage:
#     powershell -ExecutionPolicy Bypass -File tools\publish-public.ps1 -Message "feat: xxx"
#     powershell -ExecutionPolicy Bypass -File tools\publish-public.ps1 -DryRun          # preview only
#     powershell -ExecutionPolicy Bypass -File tools\publish-public.ps1 -NoPush          # commit locally only
#
#  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# ============================================================================
[CmdletBinding()]
param(
    [string]$Message = '',
    [string]$Repo = 'neasonli/lcode',
    [switch]$DryRun,
    [switch]$NoPush,
    [switch]$SkipAudit
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Export = Join-Path (Split-Path -Parent $Root) 'lcode-public-export'
$Python = 'python'

function Step([string]$m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "    [warn] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "    [FAIL] $m" -ForegroundColor Red; exit 1 }

Write-Host '============================================================' -ForegroundColor White
Write-Host ' publish workspace -> public repo' -ForegroundColor White
Write-Host " workspace : $Root" -ForegroundColor White
Write-Host " export    : $Export" -ForegroundColor White
if ($DryRun) { Write-Host ' mode      : DRY RUN (nothing is committed or pushed)' -ForegroundColor Yellow }
Write-Host '============================================================' -ForegroundColor White

if (-not (Test-Path $Export)) { Fail "export dir not found: $Export (run tools\make-public-export.ps1 once)" }
if (-not (Test-Path (Join-Path $Export '.git'))) {
    Fail "no .git in $Export - one-time setup: cd `"$Export`"; git init -b main; git remote add origin git@github.com:$Repo.git"
}

# ---------------------------------------------------------------- 1. export
Step '1/5 exporting the public tree (whitelist + secret scan)'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'make-public-export.ps1')
if ($LASTEXITCODE -ne 0) { Fail 'make-public-export.ps1 reported problems (read the output above; it refuses to publish on a hit)' }
Ok 'export finished'

# ---------------------------------------------------------------- 2. audit
if (-not $SkipAudit) {
    Step '2/5 independent audit (second opinion)'
    & $Python (Join-Path $PSScriptRoot 'audit-public-export.py') $Export
    if ($LASTEXITCODE -ne 0) { Fail 'audit found hard hits - do NOT push before fixing them' }
    Ok 'audit PASS'
} else {
    Warn2 'audit skipped (-SkipAudit)'
}

# ---------------------------------------------------------------- 3. status
Step '3/5 what changed'
Push-Location $Export
try {
    $changed = @(git status --porcelain)
    if ($changed.Count -eq 0) {
        Ok 'nothing to commit - the public tree already matches the workspace'
        if ($LASTEXITCODE -eq 0 -and -not $NoPush) {
            $ahead = @(git log --oneline "origin/main..HEAD" 2>$null)
            if ($ahead.Count -gt 0) {
                Warn2 "$($ahead.Count) local commit(s) not pushed yet"
            } else {
                Write-Host ''
                Write-Host 'all good: no local changes, nothing to push.' -ForegroundColor Green
                exit 0
            }
        } else {
            exit 0
        }
    } else {
        $changed | ForEach-Object { Write-Host "      $_" }
        Ok "$($changed.Count) path(s) changed"
    }

    # ------------------------------------------------------------ 4. commit
    Step '4/5 commit'
    if ([string]::IsNullOrWhiteSpace($Message)) {
        $Message = 'chore: sync workspace changes (' + (Get-Date -Format 'yyyy-MM-dd HH:mm') + ')'
    }
    Write-Host "    message: $Message"
    if ($DryRun) {
        Warn2 'dry run: skipped git add/commit'
        $ahead0 = @(git log --oneline "origin/main..HEAD" 2>$null)
        Write-Host ''
        Write-Host "[dry-run] would commit $($changed.Count) path(s)$(if ($ahead0.Count -gt 0) { " and push $($ahead0.Count) commit(s)" })" -ForegroundColor Yellow
        exit 0
    }
    git add -A
    if ($LASTEXITCODE -ne 0) { Fail 'git add failed' }
    git commit -q -m $Message
    if ($LASTEXITCODE -ne 0) { Fail 'git commit failed (nothing staged?)' }
    Ok ('committed ' + (git rev-parse --short HEAD))

    # ------------------------------------------------------------ 5. push
    if ($NoPush) {
        Warn2 '-NoPush: committed locally only'
        exit 0
    }
    Step "5/5 push to $Repo"
    git push origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Host '    hint: if this is a network error (github.com:443 is blocked on this network),' -ForegroundColor Yellow
        Write-Host '          make sure ~/.ssh/config maps github.com -> ssh.github.com:443 (already configured once).' -ForegroundColor Yellow
        Fail 'git push failed'
    }
    Ok ('pushed ' + (git rev-parse --short HEAD) + ' -> https://github.com/' + $Repo)
} finally {
    Pop-Location
}

Write-Host ''
Write-Host 'done.' -ForegroundColor Green
