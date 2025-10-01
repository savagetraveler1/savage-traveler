# Test-Anchors.ps1  — minimal sanity check
$ErrorActionPreference = "Stop"

$htmlPath = ".\index.html"
$jsPath   = ".\static\app.js"

# Backups
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $htmlPath "$htmlPath.$ts.bak" -ErrorAction SilentlyContinue
Copy-Item $jsPath   "$jsPath.$ts.bak"   -ErrorAction SilentlyContinue

function Add-AnchorBefore([string]$File,[string]$Pattern,[string]$Anchor){
  $t = Get-Content $File -Raw
  if ($t -like "*$Anchor*"){ Write-Host "✓ already: $Anchor"; return }
  $n = [regex]::Replace($t,$Pattern, { param($m) "$Anchor`r`n$($m.Value)" }, 1,
    [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if ($n -ne $t) { Set-Content -Path $File -Value $n -NoNewline; Write-Host "→ inserted: $Anchor" }
  else { Write-Warning "Pattern not found in $File: $Pattern" }
}

# Drop one anchor in each file
Add-AnchorBefore -File $htmlPath -Pattern '<body>' -Anchor '<!-- TODO [HTML_TEST] -->'
Add-AnchorBefore -File $jsPath   -Pattern 'mapboxgl\.accessToken' -Anchor '// TODO [JS_TEST]'
