# ============================================================================
#  publish-kb-wheel.ps1 -- build the CLOSED-SOURCE knowledge base wheel
#  (D:\1_ai_project\lcode-kb) and deliver it to authorised users ONLY.
#
#  Two delivery modes:
#    (default)  private GitHub Release asset in the PRIVATE repo lcode-kb
#    -IndexUrl  upload to a self-hosted index (devpi / pypiserver) with twine
#
#  Usage:
#     powershell -ExecutionPolicy Bypass -File tools\publish-kb-wheel.ps1 -DryRun
#     powershell -ExecutionPolicy Bypass -File tools\publish-kb-wheel.ps1 -Repo me/lcode-kb
#     powershell -ExecutionPolicy Bypass -File tools\publish-kb-wheel.ps1 -Repo me/lcode-kb -Tag kb-v0.1.1
#     powershell -ExecutionPolicy Bypass -File tools\publish-kb-wheel.ps1 -IndexUrl https://devpi.internal/root/lcode/+simple/
#
#  Auth (one of):
#     * GitHub CLI logged in  : gh auth login            (preferred, script uses `gh`)
#     * Personal access token : $env:GH_TOKEN = '...'    (classic: repo ; fine-grained: Contents=read+write)
#     * index mode            : $env:TWINE_USERNAME / $env:TWINE_PASSWORD
#
#  Safety rails (this script refuses to shoot you in the foot):
#     * the target repo MUST report private=true -- a public repo would leak a
#       closed-source asset, so publishing is refused when visibility is unknown
#     * artifacts > 2 GiB are rejected (GitHub release asset limit)
#     * the built wheel is opened and refused if it carries data/rag_store,
#       *.npy, *.pdf, .env, *.pem, *.key or any secrets/ entry
#     * git hygiene: refuses if the vector store / wheel / PDF / secrets are
#       TRACKED by git, or if paths that must stay ignored are not ignored
#     * this script never pushes source code and never uploads to a public index
#
#  Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as
#  ANSI and non-ASCII characters break parsing.
# ============================================================================
[CmdletBinding()]
param(
    [string]$KbDir = 'D:\1_ai_project\lcode-kb',   # the PRIVATE knowledge base repo
    [string]$Repo = '',                            # owner/name ; default: git remote of $KbDir
    [string]$Tag = '',                             # default: kb-v<version>
    [string]$IndexUrl = '',                        # non-empty => twine upload mode
    [switch]$SkipBuild,                            # reuse existing dist/
    [switch]$NoGitTag,                             # do not create a local tag
    [switch]$AllowDirty,                           # allow uncommitted changes in $KbDir
    [switch]$DryRun,
    [switch]$Force                                 # skip the confirmation prompt
)

$ErrorActionPreference = 'Stop'
$MaxAsset = 2GB
$DistDir = Join-Path $KbDir 'dist'

# TLS 1.2 for GitHub REST on older Windows 10 / .NET 4.x defaults.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Info([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn2([string]$m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host "  [FAIL] $m" -ForegroundColor Red; exit 1 }
function Step([string]$m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }

Write-Host '============================================================' -ForegroundColor White
Write-Host ' publish private knowledge base wheel (CLOSED SOURCE)' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor White

# ------------------------------------------------------------ 1. locate source
Step '1/8  locate the private knowledge base repo'
if (-not (Test-Path -LiteralPath $KbDir)) { Fail "KbDir not found: $KbDir" }
$KbDir = (Resolve-Path -LiteralPath $KbDir).Path
$Pyproject = Join-Path $KbDir 'pyproject.toml'
$PkgDir = Join-Path $KbDir 'lcode_kb'
if (-not (Test-Path -LiteralPath $Pyproject)) { Fail "pyproject.toml not found in $KbDir" }
if (-not (Test-Path -LiteralPath $PkgDir)) { Fail "lcode_kb/ package dir not found in $KbDir" }
Ok "KbDir = $KbDir"

# version: read the [project] table only (no TOML parser in PowerShell 5.1)
$Version = ''
$table = ''
foreach ($line in (Get-Content -LiteralPath $Pyproject)) {
    $t = $line.Trim()
    if ($t -match '^\[(.+)\]$') { $table = $Matches[1]; continue }
    if ($table -eq 'project' -and $t -match '^version\s*=\s*"([^"]+)"') { $Version = $Matches[1]; break }
}
if ($Version -eq '') { Fail "cannot read [project] version from $Pyproject" }
if ($Tag -eq '') { $Tag = "kb-v$Version" }
$WheelName = "lcode_kb-$Version-py3-none-any.whl"
$SdistName = "lcode_kb-$Version.tar.gz"
Ok "version = $Version   tag = $Tag"

# ------------------------------------------------------------ 2. python
Step '2/8  python + build backend'
$python = 'python'
$pyVer = (& $python --version) 2>&1
if ($LASTEXITCODE -ne 0) { Fail "python not found on PATH ($pyVer)" }
Ok "python: $pyVer"

# ------------------------------------------------------------ 3. git hygiene
Step '3/8  git hygiene (red lines)'
$GitDir = Join-Path $KbDir '.git'
if (-not (Test-Path -LiteralPath $GitDir)) { Fail "$KbDir is not a git repository (run: git init)" }

# 3a. things that MUST be ignored -- vector store, build output, corpus, secrets
$mustIgnore = @(
    'data/rag_store/meta.json',
    'data/rag_store/vectors.npy',
    'dist/lcode_kb-0.1.0-py3-none-any.whl',
    'corpus/datasheet.pdf',
    '.env',
    'secrets/license.pem'
)
$notIgnored = @()
foreach ($p in $mustIgnore) {
    # --no-index: test the .gitignore RULE itself, regardless of whether the path is tracked
    & git -C $KbDir check-ignore -q --no-index -- $p
    if ($LASTEXITCODE -ne 0) { $notIgnored += $p }
}
if ($notIgnored.Count -gt 0) {
    foreach ($p in $notIgnored) { Write-Host "  [refused] .gitignore does not cover: $p" -ForegroundColor Red }
    Fail 'refusing to publish: the vector store or secrets could be committed (fix .gitignore first).'
}
Ok 'vector store / dist / corpus / secrets are all git-ignored'

# 3b. nothing forbidden may be TRACKED
$forbiddenTracked = 'rag_store|\.npy$|\.whl$|\.tar\.gz$|\.pdf$|\.egg-info/|(^|/)\.env|\.pem$|\.key$|(^|/)secrets/'
$tracked = & git -C $KbDir ls-files
$bad = @($tracked | Where-Object { $_ -match $forbiddenTracked })
if ($bad.Count -gt 0) {
    foreach ($p in $bad) { Write-Host "  [refused] tracked in git: $p" -ForegroundColor Red }
    Fail 'refusing to publish: the vector store / wheel / a PDF / a secret is committed in git.'
}
Ok "git index is clean ($(@($tracked).Count) tracked files, none forbidden)"

# 3c. provenance: warn on a dirty tree
$dirty = @(& git -C $KbDir status --porcelain)
$head = (& git -C $KbDir rev-parse --short HEAD) 2>$null
if ($dirty.Count -gt 0) {
    Warn2 "working tree has $($dirty.Count) uncommitted path(s); published artifact would not match HEAD $head"
    if (-not $DryRun -and -not $AllowDirty) {
        Fail 'refusing to publish a wheel built from an uncommitted tree (commit first, or pass -AllowDirty).'
    }
} else {
    Ok "working tree clean at HEAD $head"
}

# ------------------------------------------------------------ 4. build
Step '4/8  build sdist + wheel'
$needBuild = $true
if ($SkipBuild) {
    if ((Test-Path (Join-Path $DistDir $WheelName)) -and (Test-Path (Join-Path $DistDir $SdistName))) {
        $needBuild = $false
        Ok "-SkipBuild: reusing $DistDir"
    } else {
        Warn2 '-SkipBuild given but the expected artifacts are missing -- building anyway'
    }
}
if ($needBuild) {
    if ($DryRun) {
        Info "  [dry-run] would run: python -m build      (in $KbDir)"
    } else {
        & $python -c 'import build' 2>$null
        if ($LASTEXITCODE -ne 0) {
            Warn2 'build backend missing -- installing (python -m pip install build)'
            & $python -m pip install --disable-pip-version-check build
            if ($LASTEXITCODE -ne 0) { Fail 'python -m pip install build failed' }
        }
        Info "  running: python -m build   (isolated env; needs network for setuptools/wheel)"
        Push-Location $KbDir
        try {
            & $python -m build
            if ($LASTEXITCODE -ne 0) { Fail "python -m build failed (exit $LASTEXITCODE)" }
        } finally { Pop-Location }
        Ok 'build finished'
    }
}

# ------------------------------------------------------------ 5. artifacts
Step '5/8  artifact discovery + size guard'
if (-not (Test-Path -LiteralPath $DistDir)) {
    if ($DryRun) {
        Warn2 "dist/ does not exist yet -- run without -DryRun to build $WheelName"
        $targets = @()
    } else {
        Fail "no dist dir at $DistDir"
    }
} else {
    $targets = @(Get-ChildItem -LiteralPath $DistDir -File | Where-Object { $_.Extension -in @('.whl', '.gz') })
}
if ($targets.Count -eq 0 -and -not $DryRun) { Fail "no .whl/.tar.gz in $DistDir (build failed?)" }

$problems = @()
foreach ($t in $targets) {
    if ($t.Length -gt $MaxAsset) { $problems += "over 2 GiB (GitHub release asset limit): $($t.Name)" }
    if ($t.Name -match '^\.env' -or $t.Extension -in @('.pem', '.key')) { $problems += "secret-like file refused: $($t.Name)" }
    if ($t.Name -match 'rag_store|vectors|meta\.json') { $problems += "vector store data refused: $($t.Name)" }
}
if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Write-Host "  [refused] $p" -ForegroundColor Red }
    Fail 'refusing to publish (see above). Nothing was sent.'
}
$total = 0
foreach ($t in $targets) {
    $total += $t.Length
    $sha = (Get-FileHash -LiteralPath $t.FullName -Algorithm SHA256).Hash.ToLower()
    Write-Host ("  {0,-40} {1,10:N1} KiB  sha256={2}" -f $t.Name, ($t.Length / 1KB), $sha) -ForegroundColor White
}
Ok "safety checks passed ($($targets.Count) artifact(s), $(('{0:N2}' -f ($total / 1MB))) MiB total)"

# ------------------------------------------------------------ 6. wheel content scan
Step '6/8  wheel content scan (no corpus, no vector store, no secrets)'
$wheel = $targets | Where-Object { $_.Extension -eq '.whl' } | Select-Object -First 1
if ($null -eq $wheel) {
    if ($DryRun) { Warn2 'no wheel present yet -- content scan would run after the build' }
    else { Fail 'no wheel to scan' }
} else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($wheel.FullName)
    try {
        $entries = @($zip.Entries | ForEach-Object { $_.FullName })
    } finally { $zip.Dispose() }
    $leaks = @($entries | Where-Object { $_ -match 'rag_store|\.npy$|\.pdf$|(^|/)\.env|\.pem$|\.key$|(^|/)secrets/|license' })
    if ($leaks.Count -gt 0) {
        foreach ($l in $leaks) { Write-Host "  [refused] wheel entry: $l" -ForegroundColor Red }
        Fail 'refusing to publish: the wheel carries corpus / vector store / secret files.'
    }
    Ok "wheel has $($entries.Count) entries, none forbidden:"
    foreach ($e in $entries) { Write-Host "      $e" }
}

# ------------------------------------------------------------ 7. auth + destination
Step '7/8  destination + auth'
$mode = 'release'
if ($IndexUrl -ne '') { $mode = 'index' }

if ($mode -eq 'index') {
    Info "  mode      : self-hosted index"
    Info "  index-url : $IndexUrl"
    if ($IndexUrl -match '^https?://(pypi\.org|files\.pythonhosted\.org|test\.pypi\.org)') {
        Fail 'refusing: that is a PUBLIC index. This asset is closed source.'
    }
    $twineUser = $env:TWINE_USERNAME
    if (-not $twineUser) { $twineUser = $env:TWINE_USER }
    $twinePass = $env:TWINE_PASSWORD
    if (-not $twinePass) { $twinePass = $env:TWINE_PASS }
    if ($twineUser) { Ok "  twine user: $twineUser" } else { Warn2 '  TWINE_USERNAME/TWINE_USER not set' }
    if ($twinePass) { Ok '  twine password: set' } else { Warn2 '  TWINE_PASSWORD/TWINE_PASS not set' }
    if (-not $DryRun) {
        & $python -c 'import twine' 2>$null
        if ($LASTEXITCODE -ne 0) { Fail 'twine not installed. Run: python -m pip install twine' }
    }
} else {
    Info '  mode      : private GitHub Release asset'
    if ($Repo -eq '') {
        try {
            $url = (& git -C $KbDir remote get-url origin) 2>$null
            if ($url -match 'github\.com[:/](?<r>[^/]+/[^/\.]+?)(\.git)?$') { $Repo = $Matches['r'] }
        } catch { }
    }
    if ($Repo -eq '') {
        if ($DryRun) {
            Warn2 'no git remote and no -Repo: pass -Repo owner/name (the private repo has no remote yet)'
        } else {
            Fail 'cannot determine the repository. Pass -Repo owner/name.'
        }
    } else {
        Ok "  repo: $Repo"
    }
    if ($Repo -match '^[^/]+/(mcu_ai_agent|deepseek-harness)$') {
        Warn2 "  $Repo looks like a PUBLIC repository -- double check before publishing closed-source assets"
    }
}

# auth resolution (needed for real runs in both modes)
$token = $env:GH_TOKEN
if (-not $token) { $token = $env:GITHUB_TOKEN }
$useGh = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh auth status 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $useGh = $true }
}
if ($mode -eq 'release') {
    if ($useGh) { Ok '  auth: GitHub CLI session' }
    elseif ($token) { Ok '  auth: token from GH_TOKEN/GITHUB_TOKEN' }
    else { Warn2 '  auth: none (gh auth login, or set $env:GH_TOKEN)' }
}

# PRIVACY GATE: never upload closed-source assets without confirming private=true
if ($mode -eq 'release' -and $Repo -ne '') {
    $isPrivate = $null
    if ($useGh) {
        $val = (& gh api "repos/$Repo" --jq '.private' 2>$null)
        if ($val -match '^(true|false)$') { $isPrivate = [bool]::Parse($val) }
    }
    if ($null -eq $isPrivate) {
        # anonymous read works for public repos, which is exactly the leak we must catch
        $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'lcode-kb-publish' }
        if ($token) { $headers['Authorization'] = "Bearer $token" }
        try {
            $meta = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo" -Headers $headers -Method Get
            $isPrivate = [bool]$meta.private
        } catch { $isPrivate = $null }
    }
    if ($isPrivate -eq $true) {
        Ok "  privacy gate: $Repo reports private=true"
    } elseif ($isPrivate -eq $false) {
        Fail "refusing: $Repo is PUBLIC. A closed-source wheel must never be published there."
    } else {
        if ($DryRun) {
            Warn2 '  privacy gate: cannot confirm private=true without credentials (dry-run continues)'
        } else {
            Fail 'refusing: cannot confirm the repo is private (no gh session / token). Closed-source asset.'
        }
    }
}

# ------------------------------------------------------------ 8. publish
Step '8/8  plan'
Info '  about to publish:'
foreach ($t in $targets) { Write-Host ("    {0,-44} {1,10:N1} KiB" -f $t.Name, ($t.Length / 1KB)) -ForegroundColor White }
if ($mode -eq 'index') { Info "    -> twine upload --repository-url $IndexUrl" }
elseif ($Repo -ne '') { Info "    -> https://github.com/$Repo/releases/tag/$Tag" }
else { Info '    -> <private repo not set: pass -Repo owner/name>' }
if (-not $NoGitTag) { Info "    -> local git tag $Tag in $KbDir (NOT pushed)" }
Info '  never pushed: source code, data/rag_store, corpus PDFs, .env, secrets'

if ($DryRun) { Info ''; Info '[dry-run] nothing was built, tagged or uploaded.'; exit 0 }
if ($targets.Count -eq 0) { Fail 'nothing to publish' }
if (-not $Force) {
    $ans = Read-Host 'proceed? [y/N]'
    if ($ans -notmatch '^(y|Y)') { Info 'aborted.'; exit 1 }
}

# 8a. local tag only -- this script never runs `git push`
if (-not $NoGitTag) {
    & git -C $KbDir rev-parse -q --verify "refs/tags/$Tag" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Warn2 "tag $Tag already exists locally -- left untouched"
    } else {
        & git -C $KbDir tag -a $Tag -m "private knowledge base wheel $Version"
        if ($LASTEXITCODE -ne 0) { Fail "git tag $Tag failed" }
        Ok "tagged $Tag locally. Push it yourself when a remote exists: git -C `"$KbDir`" push origin $Tag"
    }
}

# 8b. index mode
if ($mode -eq 'index') {
    $paths = $targets | ForEach-Object { $_.FullName }
    Info 'uploading with twine ...'
    & $python -m twine upload --repository-url $IndexUrl --non-interactive @paths
    if ($LASTEXITCODE -ne 0) { Fail "twine upload failed (exit $LASTEXITCODE)" }
    Ok "uploaded to $IndexUrl"
} else {
    # 8c. private GitHub Release (gh CLI preferred, REST fallback)
    if ($useGh) {
        Ok 'uploading with GitHub CLI'
        & gh release view $Tag --repo $Repo 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Info "creating release $Tag ..."
            & gh release create $Tag --repo $Repo --title "lcode-kb $Version (private)" --notes "Closed-source knowledge base wheel $Version. Private: do not redistribute."
            if ($LASTEXITCODE -ne 0) { Fail "gh release create failed (exit $LASTEXITCODE)" }
        } else {
            Info "release $Tag already exists -- assets replaced (--clobber)"
        }
        $paths = $targets | ForEach-Object { $_.FullName }
        & gh release upload $Tag @paths --repo $Repo --clobber
        if ($LASTEXITCODE -ne 0) { Fail "gh release upload failed (exit $LASTEXITCODE)" }
    } else {
        if (-not $token) { Fail 'no gh session and no token: run `gh auth login` or set $env:GH_TOKEN' }
        Ok 'uploading with the GitHub REST API'
        $headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'lcode-kb-publish' }
        $rel = $null
        try {
            $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -Method Get
            Info "release $Tag already exists (id=$($rel.id))"
        } catch {
            # Creating a release for a tag that does NOT exist on the remote can come back as
            # HTTP 500 from the API (measured: "POST /releases -> 500" while the tag only existed
            # locally). Push the tag first, then create the release against it.
            $hasRemote = $false
            try { $hasRemote = @(& git -C $KbDir remote).Count -gt 0 } catch { }
            if ($hasRemote) {
                Info "pushing tag $Tag before creating the release (avoids the API 500 on a missing tag) ..."
                & git -C $KbDir push origin $Tag 2>&1 | ForEach-Object { Write-Host "      $_" }
                if ($LASTEXITCODE -ne 0) { Warn2 "git push of tag $Tag failed -- the release may still be created by the API" }
            } else {
                Warn2 "no git remote in ${KbDir} - the API will have to create tag $Tag itself (may 500)"
            }
            $body = @{
                tag_name   = $Tag
                name       = "lcode-kb $Version (private)"
                body       = "Closed-source knowledge base wheel $Version. Private: do not redistribute."
                draft      = $false
                prerelease = $false
            } | ConvertTo-Json
            $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Method Post -Body $body -ContentType 'application/json'
            if (-not $rel.id) { Fail 'release creation returned no id' }
        }
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        foreach ($t in $targets) {
            $uploadUrl = "https://uploads.github.com/repos/$Repo/releases/$($rel.id)/assets?name=$($t.Name)"
            Info "uploading $($t.Name) ..."
            if ($curl) {
                & curl.exe -sS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/octet-stream' --data-binary "@$($t.FullName)" $uploadUrl | Out-Null
                if ($LASTEXITCODE -ne 0) { Fail "curl upload failed for $($t.Name)" }
            } else {
                Invoke-RestMethod -Uri $uploadUrl -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'lcode-kb-publish' } -Method Post -InFile $t.FullName -ContentType 'application/octet-stream' | Out-Null
            }
            Ok "uploaded $($t.Name)"
        }
    }
    Ok "release: https://github.com/$Repo/releases/tag/$Tag"
}

# ------------------------------------------------------------ hand-off
Write-Host ''
Write-Host '------------------------------------------------------------' -ForegroundColor White
Write-Host ' Tell authorised users to install like this (PowerShell):' -ForegroundColor White
Write-Host '------------------------------------------------------------' -ForegroundColor White
$d = '$'
Write-Host ""
Write-Host "  # 0) credentials (classic PAT: repo ; fine-grained: Contents=Read)"
Write-Host "  $d env:GH_TOKEN = 'github_pat_...'"
Write-Host ''
Write-Host "  # 1) authenticated download of the private release asset"
Write-Host "  gh release download $Tag --repo $Repo --pattern '*$Version*.whl' --dir .\kb-wheel"
Write-Host ''
Write-Host "  # 2) install the wheel (torch is heavy: reuse an existing env if you have one)"
Write-Host "  pip install .\kb-wheel\$WheelName"
Write-Host ''
Write-Host "  # 3) point the kernel at the vector store (NOT shipped inside the wheel)"
Write-Host "  $d env:LCODE_KB_STORE_DIR = 'C:\path\to\rag_store'"
Write-Host "  python -c `"import lcode_kb; print(lcode_kb.info())`""
Write-Host ''
Info 'done. The desktop app does NOT use this wheel -- it uses the component zip'
Info '(tools\stage-kb-payload.py -> kb-payload.zip). See docs for details.'
