$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $PSScriptRoot
Set-Location $workspaceRoot

Write-Host "Bumping patch version..."
npm version patch --no-git-tag-version

Write-Host "Building versioned Windows release..."
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $workspaceRoot "scripts\build-win-versioned.ps1")
