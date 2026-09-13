# ============================================================================
#  publish-release.ps1 -- upload locally built installers to a GitHub Release
#
#  Why local: the "-full" installer bundles an ESP-IDF payload trimmed from YOUR
#  machine (2.4 GB source / 742 MB archive), and mac/linux toolchains are
#  platform-specific. CI builds the plain (base) variants for all three OSes
#  (see .github/workflows/build-installers.yml); the "full" variant and any
#  private component package are built locally and uploaded with this script.
#
#  Usage:
#     powershell -ExecutionPolicy Bypass -File tools\publish-release.ps1 -Tag v0.1.0 -DryRun
#     powershell -ExecutionPolicy Bypass -File tools\publish-release.ps1 -Tag v0.1.0 -Repo me/lcode
#     powershell -ExecutionPolicy Bypass -File tools\publish-release.ps1 -Tag v0.1.0 -Files D:\x\setup-full.exe
#
#  Auth (one of):
#     * GitHub CLI logged in  : gh auth login            (preferred, script uses `gh`)
#     * Personal access token : $env:GH_TOKEN = 'ghp_...' (needs repo scope)
#
#  Safety rails (this script refuses to shoot you in the foot):
#     * files > 2 GiB are rejected (GitHub release asset limit; NSIS also caps at 2 GiB)
#     * .env / *.pem / *.key are rejected
#     * kb-payload* (the closed-source knowledge base) is rejected unless -IncludeKb
#     * installers must never be committed to git -- Releases only (100 MB file limit)
#
#  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI
#  and non-ASCII characters break parsing.
# ============================================================================
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Tag,          # e.g. v0.1.0
    [string]$Repo = '',                                   # owner/name; default: git remote origin
    [string[]]$Files = @(),                               # default: lcode\desktop\dist installers
    [string]$Name = '',                                   # release title
    [string]$Notes = '',                                  # release body (default: auto)
    [switch]$Draft,
    [switch]$Prerelease,
    [switch]$IncludeKb,                                   # allow uploading kb-payload*.zip
    [switch]$DryRun,
    [switch]$Force                                        # skip the confirmation prompt
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $Root 'lcode\desktop\dist'
$MaxAsset = 2GB

function Info([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; exit 1 }

Write-Host '============================================================' -ForegroundColor White
Write-Host " publish release: $Tag" -ForegroundColor White
Write-Host '============================================================' -ForegroundColor White

# ---------------------------------------------------------------- resolve repo
if ($Repo -eq '') {
    try {
        $url = (& git -C $Root remote get-url origin) 2>$null
        if ($url -match 'github\.com[:/](?<r>[^/]+/[^/\.]+)(\.git)?$') {
            $Repo = $Matches['r']
            Ok "repo from git remote: $Repo"
        }
    } catch { }
}
if ($Repo -eq '') {
    Fail "cannot determine the repository. Pass -Repo owner/name (this workspace has no git remote yet)."
}

# ---------------------------------------------------------------- resolve files
$targets = @()
if ($Files.Count -gt 0) {
    foreach ($f in $Files) {
        if (-not (Test-Path -LiteralPath $f)) { Fail "file not found: $f" }
        $targets += (Get-Item -LiteralPath $f)
    }
} else {
    if (-not (Test-Path $DistDir)) { Fail "dist dir not found: $DistDir (run tools\build-installer.ps1 first)" }
    $patterns = @('*.exe', '*.dmg', '*.AppImage', '*.deb', '*.zip')
    foreach ($p in $patterns) {
        Get-ChildItem -Path $DistDir -Filter $p -File -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -notmatch 'uninstaller') { $targets += $_ }
        }
    }
}
if ($targets.Count -eq 0) { Fail "no files to upload (looked in $DistDir)" }

# ---------------------------------------------------------------- safety rails
$problems = @()
foreach ($t in $targets) {
    if ($t.Length -gt $MaxAsset) { $problems += "too large for a GitHub release asset (>2 GiB): $($t.Name)" }
    if ($t.Name -match '^\.env' -or $t.Extension -in @('.pem', '.key')) { $problems += "secret-like file refused: $($t.Name)" }
    if ($t.Name -match '^kb-payload' -and -not $IncludeKb) {
        $problems += "closed-source knowledge base payload refused without -IncludeKb: $($t.Name)"
    }
}
if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host "  [refused] $p" -ForegroundColor Red }
    Fail 'refusing to upload (see above). Nothing was sent.'
}
Ok 'safety checks passed'

Write-Host ''
Info 'about to upload:'
foreach ($t in $targets) { Write-Host ("  {0,-52} {1,9:N1} MB" -f $t.Name, ($t.Length / 1MB)) -ForegroundColor White }
Info "release : $Repo  tag=$Tag  draft=$([bool]$Draft)  prerelease=$([bool]$Prerelease)"

if ($DryRun) { Info ''; Info '[dry-run] nothing was uploaded.'; exit 0 }
if (-not $Force) {
    $ans = Read-Host 'proceed? [y/N]'
    if ($ans -notmatch '^(y|Y)') { Info 'aborted.'; exit 1 }
}

# ---------------------------------------------------------------- auth
$ghCli = Get-Command gh -ErrorAction SilentlyContinue
$token = $env:GH_TOKEN; if (-not $token) { $token = $env:GITHUB_TOKEN }
$useGh = $false
if ($ghCli) {
    & gh auth status 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $useGh = $true }
}

if ($useGh) {
    Ok 'using GitHub CLI'
    & gh release view $Tag --repo $Repo 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Info "creating release $Tag ..."
        $createArgs = @('release', 'create', $Tag, '--repo', $Repo, '--title', ($(if ($Name) { $Name } else { "LCode $Tag" })))
        if ($Notes) { $createArgs += @('--notes', $Notes) } else { $createArgs += '--generate-notes' }
        if ($Draft) { $createArgs += '--draft' }
        if ($Prerelease) { $createArgs += '--prerelease' }
        & gh @createArgs
        if ($LASTEXITCODE -ne 0) { Fail "gh release create failed (exit $LASTEXITCODE)" }
    } else {
        Info "release $Tag already exists -- assets will be replaced (--clobber)"
    }
    $paths = $targets | ForEach-Object { $_.FullName }
    & gh release upload $Tag @paths --repo $Repo --clobber
    if ($LASTEXITCODE -ne 0) { Fail "gh release upload failed (exit $LASTEXITCODE)" }
    Ok "uploaded: https://github.com/$Repo/releases/tag/$Tag"
    exit 0
}

# --------------------------------------------------- REST fallback (no gh CLI)
if (-not $token) {
    Fail 'no GitHub CLI session and no token. Either run "gh auth login", or set $env:GH_TOKEN to a PAT with repo scope.'
}
Ok 'using GitHub REST API (curl.exe)'
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'lcode-publish' }

# 1) find or create the release
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -Method Get
    Info "release $Tag already exists (id=$($rel.id)) -- uploading into it"
} catch {
    Info "creating release $Tag ..."
    $body = @{
        tag_name         = $Tag
        name             = $(if ($Name) { $Name } else { "LCode $Tag" })
        body             = $(if ($Notes) { $Notes } else { "LCode $Tag release." })
        draft            = [bool]$Draft
        prerelease       = [bool]$Prerelease
    } | ConvertTo-Json
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Method Post -Body $body -ContentType 'application/json'
    if (-not $rel.id) { Fail 'release creation returned no id' }
}
$releaseId = $rel.id

# 2) upload assets (curl streams from disk: safer than loading 750 MB into memory)
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
foreach ($t in $targets) {
    $uploadUrl = "https://uploads.github.com/repos/$Repo/releases/$releaseId/assets?name=$($t.Name)"
    Info "uploading $($t.Name) ..."
    if ($curl) {
        & curl.exe -sS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/octet-stream' `
            --data-binary "@$($t.FullName)" $uploadUrl | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "curl upload failed for $($t.Name) (exit $LASTEXITCODE)" }
    } else {
        Invoke-RestMethod -Uri $uploadUrl -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'lcode-publish' } `
            -Method Post -InFile $t.FullName -ContentType 'application/octet-stream' | Out-Null
    }
    Ok "uploaded $($t.Name)"
}
Ok "done: https://github.com/$Repo/releases/tag/$Tag"
