# ============================================================================
#  upload-release.ps1 -- create a GitHub Release and attach the built installers
#
#  Why this exists: uploading an 800 MB installer through the GitHub web UI is a single
#  slow connection (and on this network github.com itself is blocked, so the browser
#  usually goes through a proxy). uploads.github.com - the asset endpoint - IS directly
#  reachable here and was measured at roughly 10 MB/s. So this script streams the files
#  with curl instead of using the browser.
#
#  Auth: set a token first (classic PAT with `repo`, or fine-grained with Contents:write)
#      $env:GH_TOKEN = 'ghp_...'
#
#  Usage:
#      powershell -ExecutionPolicy Bypass -File tools\upload-release.ps1 -Tag v0.1.0
#      powershell -ExecutionPolicy Bypass -File tools\upload-release.ps1 -Tag v0.1.0 -DryRun
#      powershell -ExecutionPolicy Bypass -File tools\upload-release.ps1 -Tag v0.1.0 -Only setup-full
#
#  Behaviour:
#      * ensures the tag exists on the remote (pushes it) BEFORE creating the release
#        (creating a release for a tag that exists only locally can return HTTP 500)
#      * creates the release if missing, reusing the notes file if given
#      * skips an asset when the remote already has one with the same name AND size
#      * uploads with curl (streaming, progress bar, --retry), then verifies sizes
#
#  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
# ============================================================================
[CmdletBinding()]
param(
    [string]$Tag = 'v0.1.0',
    [string]$Repo = 'neasonli/lcode',
    [string]$Title = '',
    [string]$Dist = '',
    [string]$NotesFile = '',
    [string[]]$Only = @(),
    [switch]$DryRun,
    [switch]$NoTagPush,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Export = Join-Path (Split-Path -Parent $Root) 'lcode-public-export'
if ([string]::IsNullOrWhiteSpace($Dist)) { $Dist = Join-Path $Root 'lcode\desktop\dist' }
if ([string]::IsNullOrWhiteSpace($Title)) { $Title = "LCode $Tag" }
if ([string]::IsNullOrWhiteSpace($NotesFile)) {
    $cand = Join-Path $Root 'docs\release-notes-v0.1.0.md'
    if (Test-Path $cand) { $NotesFile = $cand }
}

function Step([string]$m) { Write-Host ''; Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string]$m) { Write-Host "    [ok] $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "    [warn] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "    [FAIL] $m" -ForegroundColor Red; exit 1 }

Write-Host '============================================================' -ForegroundColor White
Write-Host ' upload installers to a GitHub Release' -ForegroundColor White
Write-Host " repo : $Repo    tag : $Tag" -ForegroundColor White
Write-Host " dist : $Dist" -ForegroundColor White
if ($DryRun) { Write-Host ' mode : DRY RUN' -ForegroundColor Yellow }
Write-Host '============================================================' -ForegroundColor White

$token = $env:GH_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) { $token = $env:GITHUB_TOKEN }
if ([string]::IsNullOrWhiteSpace($token)) { Fail 'no token: set $env:GH_TOKEN (classic PAT with repo scope)' }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'lcode-release' }
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) { Fail 'curl.exe not found (Windows 10 1803+ ships it)' }

function Read-NotesText([string]$path) {
    # Two measured traps on a Chinese-locale Windows PowerShell 5.1:
    #   1) Get-Content -Raw without -Encoding reads a BOM-less UTF-8 file as GBK, so CJK text is
    #      already mangled in memory before it is ever sent (the release body showed as mojibake
    #      even though the JSON itself was valid UTF-8).
    #   2) Invoke-RestMethod -Body <string> then encodes with the ANSI code page again.
    # So: read raw bytes and decode as UTF-8 explicitly; send UTF-8 bytes back.
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    # Drop a UTF-8 BOM if the file happens to have one.
    if ($text.Length -gt 0 -and [int][char]$text[0] -eq 0xFEFF) { $text = $text.Substring(1) }
    # Only the part after the first horizontal rule is the release body (the notes files start
    # with a title plus a short "how to use this file" blockquote).
    if ($text -match '(?s)^.*?\r?\n---\r?\n(.*)$') { $text = $Matches[1] }
    return $text.Trim()
}

# ---------------------------------------------------------------- 1. artifacts
Step '1/5 collecting artifacts'
$files = Get-ChildItem $Dist -File -Filter '*.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*uninstaller*' } | Sort-Object Length -Descending
if ($Only.Count -gt 0) {
    $files = $files | Where-Object { $n = $_.Name; ($Only | Where-Object { $n -like "*$_*" }).Count -gt 0 }
}
if (-not $files) { Fail "no matching *.exe in $Dist" }
$totalMB = ($files | Measure-Object -Property Length -Sum).Sum / 1MB
foreach ($f in $files) { Write-Host ("      {0,-46} {1,8:N1} MB" -f $f.Name, ($f.Length / 1MB)) }
Ok ("{0} file(s), {1:N1} MB total" -f $files.Count, $totalMB)

# ---------------------------------------------------------------- 2. tag
Step '2/5 ensure the tag exists on the remote'
$remoteTag = & git -C $Export ls-remote --tags origin "refs/tags/$Tag" 2>$null
if ($remoteTag) {
    Ok "remote already has tag $Tag"
} elseif ($NoTagPush) {
    Warn2 "-NoTagPush: remote tag $Tag missing, the API will create it (may 500)"
} else {
    $localTag = & git -C $Export tag --list $Tag
    if (-not $localTag) {
        if ($DryRun) {
            Warn2 "dry run: would create and push tag $Tag"
        } else {
            & git -C $Export tag -a $Tag -m "LCode $Tag"
            if ($LASTEXITCODE -ne 0) { Fail "git tag failed" }
        }
    }
    if ($DryRun) {
        Warn2 "dry run: would push tag $Tag"
    } else {
        & git -C $Export push origin $Tag
        if ($LASTEXITCODE -ne 0) { Fail "git push of tag $Tag failed" }
        Ok "pushed tag $Tag"
    }
}

# ---------------------------------------------------------------- 3. release
Step '3/5 ensure the release exists'
$notesText = ''
if ($NotesFile -and (Test-Path $NotesFile)) {
    $notesText = Read-NotesText $NotesFile
    Write-Host ("    notes: {0} ({1:N1} KB)" -f $NotesFile, ($notesText.Length / 1KB))
    if ($notesText -notmatch '[^\x00-\x7F]') { Warn2 'the notes text looks pure ASCII - did the file really load as UTF-8?' }
}
$rel = $null
try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -Method Get
    Ok "release $Tag exists (id=$($rel.id))"
    # Repair the body when it differs from the (correctly decoded) notes file. This is how a
    # previously mojibake body gets fixed: re-run the script and it PATCHes the description.
    if ($notesText -and ([string]$rel.body).Trim() -ne $notesText) {
        Write-Host '    body differs from the notes file -> updating the description'
        if ($DryRun) {
            Warn2 'dry run: would PATCH the release body'
        } else {
            $patchJson = @{ body = $notesText } | ConvertTo-Json -Depth 5
            $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/$($rel.id)" -Headers $headers `
                -Method Patch -Body ([System.Text.Encoding]::UTF8.GetBytes($patchJson)) `
                -ContentType 'application/json; charset=utf-8'
            Ok 'release description updated'
        }
    }
} catch {
    if ($DryRun) {
        Warn2 "dry run: would create release $Tag (title '$Title')"
        $rel = [pscustomobject]@{ id = 0; assets = @() }
    } else {
        $body = @{ tag_name = $Tag; name = $Title; draft = $false; prerelease = $false }
        if ($notesText) { $body.body = $notesText }
        # Non-ASCII must be sent as UTF-8 *bytes*: a string body is encoded with the ANSI code
        # page (GBK here) and the API answers 400 "Problems parsing JSON".
        $json = $body | ConvertTo-Json -Depth 5
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Method Post `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8'
        if (-not $rel.id) { Fail 'release creation returned no id' }
        Ok "created release $Tag (id=$($rel.id))"
    }
}
$existing = @{}
foreach ($a in @($rel.assets)) { $existing[$a.name] = $a }

# ---------------------------------------------------------------- 4. upload
Step '4/5 uploading'
foreach ($f in $files) {
    $have = $existing[$f.Name]
    if ($have -and [int64]$have.size -eq [int64]$f.Length) {
        Ok "$($f.Name) already uploaded (same size), skipping"
        continue
    }
    if ($have) {
        Warn2 "$($f.Name) exists with a different size -> replacing"
        if (-not $DryRun) {
            Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/assets/$($have.id)" -Headers $headers -Method Delete | Out-Null
        }
    }
    if ($DryRun) { Warn2 "dry run: would upload $($f.Name)"; continue }
    $url = "https://uploads.github.com/repos/$Repo/releases/$($rel.id)/assets?name=$($f.Name)"
    Write-Host "    uploading $($f.Name) ($([math]::Round($f.Length/1MB,1)) MB) ..." -ForegroundColor White
    # No -s: curl then prints a progress bar on stderr, which matters for an 818 MB upload
    # (otherwise it looks frozen for minutes). --fail makes HTTP errors non-zero.
    & curl.exe -S --fail --progress-bar --retry 3 --retry-delay 5 --retry-connrefused `
        -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/octet-stream' `
        -H 'Expect:' --data-binary "@$($f.FullName)" $url | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "curl upload failed for $($f.Name) (exit $LASTEXITCODE)" }
    Ok "uploaded $($f.Name)"
}

# ---------------------------------------------------------------- 5. verify
if ($NoVerify -or $DryRun) {
    if ($DryRun) { Write-Host ''; Write-Host '[dry-run] nothing was created or uploaded.' -ForegroundColor Yellow }
    exit 0
}
Step '5/5 verifying the remote assets'
$rel2 = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -Method Get
$byName = @{}
foreach ($a in @($rel2.assets)) { $byName[$a.name] = $a }
$bad = 0
foreach ($f in $files) {
    $a = $byName[$f.Name]
    if (-not $a) { Write-Host "    [X] $($f.Name) MISSING on the remote" -ForegroundColor Red; $bad++; continue }
    $okSize = [int64]$a.size -eq [int64]$f.Length
    Write-Host ("    {0} {1,-46} {2,8:N1} MB  state={3}" -f $(if ($okSize) { '[ok]' } else { '[X] ' }), $a.name, ($a.size / 1MB), $a.state) -ForegroundColor $(if ($okSize) { 'Green' } else { 'Red' })
    if (-not $okSize) { $bad++ }
}
Write-Host ''
Write-Host "release page: $($rel2.html_url)" -ForegroundColor Cyan
if ($bad -gt 0) { Fail "$bad asset(s) failed verification" }
Ok 'all assets verified (name + size)'
