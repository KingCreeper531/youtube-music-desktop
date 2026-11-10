# Builds the app and publishes a GitHub release with:
#   - YouTube-Music-Setup-<version>.exe     (installer, auto-updates)
#   - YouTube-Music-Portable-<version>.exe  (no install needed)
#   - latest.yml + .blockmap                (used by the in-app Update button)
#
# Usage:  npm run release                      -> bumps patch (1.1.0 -> 1.1.1) if needed
#         npm run release -- -Bump minor       -> 1.1.0 -> 1.2.0
#         npm run release -- -Notes "Fixed X"  -> custom release notes
param(
  [ValidateSet('patch', 'minor', 'major')] [string]$Bump = 'patch',
  [string]$Notes = ''
)
# Native tools write progress to stderr; Windows PowerShell 5.1 would treat that
# as fatal under 'Stop'. Failures are caught by exit codes in Run() instead.
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed (exit $LASTEXITCODE)" }
}

$repo = 'KingCreeper531/youtube-music-desktop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

# Only bump if this version was already released.
& gh release view "v$version" --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
  Run npm @('version', $Bump, '--no-git-tag-version')
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
}
Write-Host "Releasing v$version" -ForegroundColor Green

if (Test-Path dist) { Remove-Item -Recurse -Force dist }
Run npx @('electron-builder', '--win', '--publish', 'never')

# Android APK (same version number, read from package.json by Gradle)
Push-Location android
try { Run '.\gradlew.bat' @('assembleRelease', '--no-daemon', '-q') } finally { Pop-Location }
Copy-Item "android\app\build\outputs\apk\release\YouTube-Music-Android-$version.apk" "dist\" -Force

$assets = @(
  "dist\YouTube-Music-Setup-$version.exe",
  "dist\YouTube-Music-Setup-$version.exe.blockmap",
  "dist\YouTube-Music-Portable-$version.exe",
  "dist\YouTube-Music-Android-$version.apk",
  'dist\latest.yml'
)
foreach ($a in $assets) { if (-not (Test-Path $a)) { throw "Missing build output: $a" } }

# Commit and push the source for this version.
Run git @('add', '-A')
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { Run git @('commit', '-m', "Release v$version") }
Run git @('push', 'origin', 'HEAD')

if (-not $Notes) {
  $Notes = @"
## Download
- **YouTube-Music-Setup-$version.exe**: installer (recommended). Updates itself with the green Update button.
- **YouTube-Music-Portable-$version.exe**: runs without installing.
- **YouTube-Music-Android-$version.apk**: Android app. Open it on your phone to install, then use its green Update button for future versions.

Windows may show a SmartScreen warning because the app isn't code-signed. Click **More info**, then **Run anyway**.
"@
}
$ghArgs = @('release', 'create', "v$version", '--repo', $repo, '--target', 'main', '--title', "YouTube Music v$version", '--notes', $Notes) + $assets
Run gh $ghArgs
Write-Host "Published https://github.com/$repo/releases/tag/v$version" -ForegroundColor Green
