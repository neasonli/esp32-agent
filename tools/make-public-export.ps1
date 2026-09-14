<#
  make-public-export.ps1
  Build a clean, publishable copy of this repository (whitelist based), then run a
  safety scan over the result so nothing sensitive can reach GitHub by accident.

  Why whitelist: the working tree contains a live API key (.env), vendor PDF
  manuals, a private licensing server, an extracted third-party app and personal
  files. Copying only what is public is far safer than trusting a blacklist.

  Usage (from the repo root):
    powershell -ExecutionPolicy Bypass -File tools\make-public-export.ps1
    powershell -ExecutionPolicy Bypass -File tools\make-public-export.ps1 -Out D:\tmp\lcode-public
    powershell -ExecutionPolicy Bypass -File tools\make-public-export.ps1 -IncludeLicensingServer -IncludeStage1

  Default output: <parent-of-repo>\lcode-public-export
  Exit code: 0 = export clean, 1 = safety scan found something (fix before pushing).
#>
[CmdletBinding()]
param(
  [string]$Out = '',
  [switch]$Force,
  [switch]$IncludeLicensingServer,   # lcode/server (license + payment backend) - keep PRIVATE by default
  [switch]$IncludeStage1             # embedded_agent_stage1 (legacy MVP) - excluded by default
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
if ($Out -eq '') { $Out = Join-Path (Split-Path -Parent $Root) 'lcode-public-export' }

# Directory names never published (any depth).
# '_internal' = PyInstaller 6 dependency dir (frozen kernel build output, tens to hundreds of MB);
# no source directory ever uses that name. NOTE: keep every comment in this file ASCII-only,
# Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI and non-ASCII comments break parsing.
$SkipDirNames = @(
  'node_modules', '__pycache__', '.venv', 'venv', 'out', 'dist', '.git', '.tools',
  'ui-ref', 'data', 'outputs', '.pytest_cache', '.mypy_cache', 'htmlcov', '_internal'
)
# File patterns never published (any depth). Last two = frozen kernel binary (win has .exe, mac/linux not)
$SkipFilePatterns = @(
  '*.pem', '*.key', '*.log', '*.db', '*.db-shm', '*.db-wal', '*.npy', '*.pdf',
  '*.pyc', '*.tsbuildinfo', '*.exe', '*.zip', '*.7z', '*.bak', '*.bak-*',
  'lcode-kernel', 'lcode-kernel.*',
  'kb-payload*', 'esp-idf-payload*'
)

$IncludeRootFiles = @('LICENSE', 'NOTICE', 'README.md', '.gitignore', '.gitattributes')
$IncludeDirs = @('lcode', 'docs', 'third_party', 'tools', '.github')
if ($IncludeStage1) { $IncludeDirs += 'embedded_agent_stage1' }

# Repo-relative subtrees that stay private.
$SkipSubPaths = @()
if (-not $IncludeLicensingServer) { $SkipSubPaths += (Join-Path 'lcode' 'server') }
# Build artifacts: PyInstaller work dir / frozen kernel / electron-builder output / planner runtime closure.
# These are rebuilt per machine and must never reach the public repo (measured leak: 145 MB).
$SkipSubPaths += 'lcode\kernel\build'
$SkipSubPaths += 'lcode\kernel\dist'
$SkipSubPaths += 'lcode\desktop\dist'
$SkipSubPaths += 'lcode\desktop\resources\planner\node_modules'
$SkipSubPaths += 'lcode\desktop\resources\planner\dsh-home'
# Self-contained planner runtime (route B) is built by tools/planner-bundle: apps/ holds the
# built DSH CLI, home/ the DSH_HOME skeleton and manifest.json the bundle descriptor. All of
# it is a build artifact produced from DSH sources + lcode/planner, so it never ships in git.
$SkipSubPaths += 'lcode\desktop\resources\planner\apps'
$SkipSubPaths += 'lcode\desktop\resources\planner\home'
$SkipSubPaths += 'lcode\desktop\resources\planner\licenses'
$SkipSubPaths += 'lcode\desktop\resources\esp-idf'
# Installers / payloads / component archives must never be committed: GitHub rejects files
# over 100 MB and the repo would balloon. They belong to GitHub Releases (see
# tools/publish-release.ps1). *.exe and *.zip are already in $SkipFilePatterns; these
# subtrees cover the build output and component dirs.
$SkipSubPaths += 'lcode\desktop\dist'
$SkipSubPaths += 'lcode\desktop\resources\kb'

# Repo-relative single files that stay private: internal release/close-source playbook
# (contains private-repo paths, archived payment-channel notes and machine-specific paths).
#
# NOTE: the file name is Chinese and this script must stay pure ASCII - Windows PowerShell 5.1
# reads a BOM-less .ps1 as ANSI and would corrupt a literal. Build the name from code points.
$InternalDocNames = @(
  (-join [char[]]@(0x5F00, 0x6E90, 0x53D1, 0x5E03, 0x6E05, 0x5355)) + '.md'   # release checklist
  # Private-KB delivery report (wheel hashes, the private package's module list, corpus file
  # names, private repo paths, machine paths): an internal handover doc for the closed-source
  # side, not public documentation. Public-facing KB positioning lives in the one-click
  # packaging doc (section 9.1) and the kernel README's knowledge-base section.
  (-join [char[]]@(0x79C1, 0x6709, 0x77E5, 0x8BC6, 0x5E93, 0x2D, 0x77, 0x68, 0x65, 0x65, 0x6C,
                   0x4E0E, 0x79C1, 0x6709, 0x6E90)) + '.md'
)
$SkipRelFiles = @()
foreach ($n in $InternalDocNames) { $SkipRelFiles += (Join-Path 'docs' $n) }
# Planner bundle descriptor: build artifact (version/stamp), regenerated by tools/planner-bundle.
$SkipRelFiles += 'lcode\desktop\resources\planner\manifest.json'

function Test-SkipDir([string]$name) { return ($SkipDirNames -contains $name) }

function Test-SkipRelFile([string]$relFromRoot) {
  return ($SkipRelFiles -contains ($relFromRoot -replace '/', '\'))
}

function Test-SkipFile([string]$name) {
  if ($name -eq '.env.example') { return $false }   # the example stays; the real .env never does
  if ($name -eq '.env' -or $name -like '.env.*') { return $true }
  foreach ($p in $SkipFilePatterns) { if ($name -like $p) { return $true } }
  return $false
}

function Copy-Whitelisted([string]$srcAbs, [string]$dstAbs, [string]$relFromRoot) {
  if ($SkipSubPaths -contains ($relFromRoot -replace '/', '\')) {
    Write-Host ("  skip private subtree: {0}" -f $relFromRoot) -ForegroundColor DarkYellow
    return
  }
  if (Test-Path -LiteralPath $srcAbs -PathType Container) {
    if (Test-SkipDir (Split-Path $srcAbs -Leaf)) { return }
    New-Item -ItemType Directory -Force -Path $dstAbs | Out-Null
    foreach ($f in Get-ChildItem -LiteralPath $srcAbs -File -Force) {
      if (Test-SkipFile $f.Name) { continue }
      if (Test-SkipRelFile (Join-Path $relFromRoot $f.Name)) {
        Write-Host ("  skip internal file: {0}" -f (Join-Path $relFromRoot $f.Name)) -ForegroundColor DarkYellow
        continue
      }
      Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $dstAbs $f.Name) -Force
    }
    foreach ($d in Get-ChildItem -LiteralPath $srcAbs -Directory -Force) {
      Copy-Whitelisted $d.FullName (Join-Path $dstAbs $d.Name) (Join-Path $relFromRoot $d.Name)
    }
  }
}

Write-Host "repo root  : $Root"
Write-Host "export out : $Out"
# Preserve the export dir's own .git: removing it would silently destroy the repo history once
# this directory is a real clone (measured hazard: a first commit made here was wiped by the
# next re-export). The source repo's .git is never copied - only the target's own is kept.
#
# The whole park/clean/restore sequence is wrapped in try/finally on purpose: the clean-up step
# can fail while a handle is still open (antivirus/indexer - hit for real: "Cannot remove item
# ... because it is being used by another process"), and the earlier version then aborted with
# .git still parked in %TEMP%, leaving an empty directory that looked like lost history.
$gitDir = Join-Path $Out '.git'
$gitTemp = $null
try {
  if ((Test-Path $gitDir) -and (-not $Force)) {
    $gitTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('lcode-export-git-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Move-Item -LiteralPath $gitDir -Destination $gitTemp -Force
    Write-Host '  preserving existing .git (repo history kept)' -ForegroundColor DarkYellow
  }
  if (Test-Path $Out) {
    if ($Force) {
      Write-Host '(-Force: keeping existing out dir, files will be overwritten)' -ForegroundColor Yellow
    } else {
      $cleaned = $false
      for ($try = 1; $try -le 5; $try++) {
        try {
          # Delete the CONTENTS instead of the directory itself. Explorer windows, antivirus and
          # the search indexer routinely hold a handle on a directory; deleting that directory
          # then fails with "being used by another process" - which aborted an export here and
          # left the mirror empty with .git still parked in %TEMP%. Removing children works even
          # while something holds the parent. (.git is already moved aside at this point.)
          Get-ChildItem -LiteralPath $Out -Force | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
          }
          $cleaned = $true
          break
        } catch {
          Write-Host ("  [warn] clean attempt {0}/5 failed: {1}" -f $try, $_.Exception.Message.Split([char]10)[0]) -ForegroundColor Yellow
          Start-Sleep -Seconds 3
        }
      }
      if (-not $cleaned) {
        throw "cannot clean the contents of $Out - a file inside is held by another process (close editors/Explorer on it, or retry)"
      }
    }
  }
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
} finally {
  # Always put the history back, even when the clean-up above threw. The restore itself gets its
  # own catch: if it throws, the earlier version died silently with .git still in %TEMP% and the
  # mirror looking like lost history (measured twice). Never let that be silent again.
  if ($gitTemp -and (Test-Path $gitTemp)) {
    try {
      Move-Item -LiteralPath $gitTemp -Destination $gitDir -Force -ErrorAction Stop
      Write-Host '  .git restored' -ForegroundColor DarkYellow
    } catch {
      Write-Host ''
      Write-Host '  [FATAL] could not restore .git into the export dir!' -ForegroundColor Red
      Write-Host "          history is SAFE here : $gitTemp" -ForegroundColor Yellow
      Write-Host "          restore manually    : Move-Item -LiteralPath '$gitTemp' -Destination '$gitDir' -Force" -ForegroundColor Yellow
      Write-Host "          cause               : $($_.Exception.Message.Split([char]10)[0])" -ForegroundColor Yellow
      throw
    }
  }
}
if ($gitTemp -and -not (Test-Path $gitDir)) {
  throw "export finished without a .git in $Out (parked copy: $gitTemp) - restore it before committing anything"
}
# Self-documenting mirror warning. It lives INSIDE .git (never tracked, never published) because
# everything else in this directory is wiped and regenerated by every export.
if (Test-Path $gitDir) {
  @(
    'THIS DIRECTORY IS A GENERATED MIRROR - DO NOT EDIT FILES HERE.',
    '',
    "source of truth : $Root",
    'regenerated by  : tools\make-public-export.ps1 (wipes everything except .git)',
    'one-command flow: powershell -ExecutionPolicy Bypass -File tools\publish-public.ps1 -Message "..."',
    '',
    'An edit made here is lost on the next export (and, if committed, shows up as a deletion',
    'afterwards). Edit the workspace instead, then re-run the export.'
  ) -join "`r`n" | Set-Content -LiteralPath (Join-Path $gitDir 'EXPORT-MIRROR-README.txt') -Encoding ASCII
}

foreach ($f in $IncludeRootFiles) {
  $p = Join-Path $Root $f
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $Out $f) -Force }
}
foreach ($f in Get-ChildItem -LiteralPath $Root -Filter '*.bat' -File) {
  Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $Out $f.Name) -Force
}
foreach ($d in $IncludeDirs) {
  $p = Join-Path $Root $d
  if (Test-Path -LiteralPath $p) { Copy-Whitelisted $p (Join-Path $Out $d) $d }
}

# ---------------- safety scan ----------------
Write-Host ''
Write-Host '--- safety scan ---' -ForegroundColor Cyan
$findings = @()
# Hard guarantee: private subtrees must not exist in the export at all.
foreach ($s in $SkipSubPaths) {
  if (Test-Path -LiteralPath (Join-Path $Out $s)) { $findings += "PRIVATE SUBTREE LEAKED: $s" }
}
# .git (the export dir's own repo, preserved above) is not part of the published tree:
# exclude it from the scan and the counters, or the reported file count is inflated by git objects.
$scanFiles = Get-ChildItem -LiteralPath $Out -Recurse -File -Force |
  Where-Object { $_.FullName -notlike (Join-Path $Out '.git\*') }
foreach ($f in $scanFiles) {
  $rel = $f.FullName.Substring($Out.Length).TrimStart('\')
  if (($f.Name -eq '.env' -or $f.Name -like '.env.*') -and $f.Name -ne '.env.example') { $findings += "ENV FILE: $rel" }
  foreach ($p in @('*.pem', '*.key', '*.db', '*.db-shm', '*.db-wal', '*.npy', '*.pdf')) {
    if ($f.Name -like $p) { $findings += "SENSITIVE FILE: $rel" }
  }
  if ($rel -match 'ui-ref|workbuddy') { $findings += "THIRD-PARTY APP: $rel" }
  # Size tripwire: a source repo must not contain any file >20 MB
  # (build outputs / models / vector stores / installers all fall in that class -> something leaked).
  if ($f.Length -gt 20MB) { $findings += ("LARGE FILE (>20MB): {0} ({1:N1} MB)" -f $rel, ($f.Length / 1MB)) }
  if ($f.Extension -in @('.ts', '.tsx', '.js', '.json', '.py', '.md', '.txt', '.yml', '.yaml', '.ps1', '.bat', '.example') -and $f.Length -lt 2MB) {
    $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($text -match 'sk-[A-Za-z0-9]{20,}') { $findings += "HARDCODED API KEY: $rel" }
    if ($text -match 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY') { $findings += "PRIVATE KEY BLOCK: $rel" }
  }
}

$files = $scanFiles
$sum = ($files | Measure-Object -Property Length -Sum).Sum
Write-Host ("files: {0}   size: {1} MB" -f $files.Count, [math]::Round(($sum / 1MB), 2))
Get-ChildItem -LiteralPath $Out -Force | Where-Object { $_.Name -ne '.git' } | Sort-Object Name | ForEach-Object {
  $n = if ($_.PSIsContainer) { (Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue).Count } else { 1 }
  Write-Host ("  {0,-24} {1,6} files" -f $_.Name, $n)
}
Write-Host ''
if ($findings.Count -eq 0) {
  Write-Host 'OK: no .env, private keys, vendor PDFs, third-party app dumps or hardcoded API keys.' -ForegroundColor Green
  Write-Host "REMINDER: $Out is a GENERATED MIRROR - edit files in $Root, never there." -ForegroundColor DarkYellow
  Write-Host 'Next: powershell -ExecutionPolicy Bypass -File tools\publish-public.ps1 -Message "..."  (export + audit + commit + push)' -ForegroundColor Green
  exit 0
}
Write-Host 'FOUND ISSUES (do not push before fixing):' -ForegroundColor Red
$findings | Sort-Object -Unique | ForEach-Object { Write-Host ("  - {0}" -f $_) -ForegroundColor Red }
exit 1
