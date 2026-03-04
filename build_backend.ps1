# Build the Flask backend into a standalone executable using PyInstaller.
# PowerShell equivalent of build_backend.sh for Windows CI.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Auto-activate the venv if it exists and we're not already in one
if (-not $env:VIRTUAL_ENV -and (Test-Path "$ScriptDir\venv\Scripts\Activate.ps1")) {
    Write-Host "==> Activating venv..."
    & "$ScriptDir\venv\Scripts\Activate.ps1"
}

Write-Host "==> Cleaning previous build artifacts..."
if (Test-Path "build\needlework-backend") { Remove-Item -Recurse -Force "build\needlework-backend" }
if (Test-Path "dist\needlework-backend")  { Remove-Item -Recurse -Force "dist\needlework-backend" }

Write-Host "==> Running PyInstaller..."
python -m PyInstaller needlework.spec --noconfirm

# Verify output
$Binary = "dist\needlework-backend\needlework-backend.exe"
if (Test-Path $Binary) {
    $Size = (Get-Item $Binary).Length / 1MB
    Write-Host ("==> Build succeeded: $Binary")
    Write-Host ("    Size: {0:N1} MB" -f $Size)
} else {
    Write-Host "==> ERROR: Expected binary not found at $Binary" -ForegroundColor Red
    exit 1
}
