# --- Start-SavageTraveler.ps1 ---
# One-click dev launcher for Savage Traveler on Windows

$ErrorActionPreference = "Stop"

try { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force } catch {}

Set-Location "C:\Users\adam\OneDrive\Desktop\Savage Traveler"

if (Test-Path ".\tools\newbranch.ps1") {
    $createBranch = Read-Host "Create a new git branch now? (Y/N)"
    if ($createBranch -match '^(y|yes)$') {
        $name = Read-Host "Short branch name (e.g., feature-map-popups)"
        if ($name) {
            & .\tools\newbranch.ps1 $name
        }
    }
}

$uvicornCmd = 'uvicorn main:app --reload --host 127.0.0.1 --port 8000'
$venvActivate = ".\venv\Scripts\Activate.ps1"
if (Test-Path $venvActivate) {
    $uvicornCmd = "$([char]34)$venvActivate$([char]34); $uvicornCmd"
}
Start-Process powershell -ArgumentList "-NoLogo -NoExit -Command $uvicornCmd" -WindowStyle Normal

try { Start-Process code -ArgumentList "." } catch { Write-Host "VS Code not found on PATH." -ForegroundColor Yellow }

Start-Process "http://127.0.0.1:8000"

Write-Host "`n? Savage Traveler dev environment started." -ForegroundColor Green
