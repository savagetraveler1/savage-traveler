param([string]$name)

if (-not $name) { Write-Host "? Usage: .\tools\newbranch.ps1 <branch-name>"; exit 1 }

# jump to repo root (parent of /tools)
Set-Location (Split-Path $PSScriptRoot -Parent)

# safety: ensure we’re in a git repo
git rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host "? Not a git repo here."; exit 1 }

git checkout -b $name
if ($LASTEXITCODE -ne 0) { exit 1 }

git push -u origin $name
Write-Host "? Created and switched to new branch: $name"
