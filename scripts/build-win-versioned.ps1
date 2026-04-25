$ErrorActionPreference = "Stop"

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $workspaceRoot "package.json"

if (!(Test-Path $packageJsonPath)) {
  throw "package.json not found at $packageJsonPath"
}

$package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$package.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Version is missing in package.json"
}

$releaseName = "Albion Market Bot v$version"
$outputDir = Join-Path $workspaceRoot "release\$releaseName"
if (!(Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir | Out-Null
}

Write-Host "Building NSIS installer to: $outputDir"
npx electron-builder --win nsis "--config.directories.output=$outputDir"

$archiveDir = Join-Path $workspaceRoot "release\archives"
if (!(Test-Path $archiveDir)) {
  New-Item -ItemType Directory -Path $archiveDir | Out-Null
}

$setupExe = Join-Path $outputDir "SoCaRi-Market-Bot-$version-Setup-x64.exe"
$blockMap = "$setupExe.blockmap"
if (!(Test-Path $setupExe)) {
  throw "Installer not found after build: $setupExe"
}

$archiveBaseName = "Albion Market Bot v$version"
$archiveExeCopy = Join-Path $archiveDir "$archiveBaseName.exe"
$archiveZip = Join-Path $archiveDir "$archiveBaseName.zip"

Copy-Item -Path $setupExe -Destination $archiveExeCopy -Force

$zipInputs = @((Join-Path $outputDir "*"))
if (Test-Path $archiveZip) {
  Remove-Item -Path $archiveZip -Force
}
Compress-Archive -Path $zipInputs -DestinationPath $archiveZip -CompressionLevel Optimal

Write-Host "Archive EXE: $archiveExeCopy"
Write-Host "Archive ZIP: $archiveZip"
