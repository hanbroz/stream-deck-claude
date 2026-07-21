$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$distDir = Join-Path $projectRoot "dist"
$manifestPath = Join-Path $projectRoot "com.hanbroz.claude-usage.sdPlugin\manifest.json"
$pluginName = "com.hanbroz.claude-usage.streamDeckPlugin"
$pluginPath = Join-Path $distDir $pluginName
$companionInstallerPattern = "Claude Deck Companion Setup *.exe"
$guidePath = Join-Path $projectRoot "docs\INSTALL_WINDOWS_KO.html"
$launcherPath = Join-Path $projectRoot "packaging\windows\Install.cmd"

function Invoke-NpmScript([string]$name) {
  & npm.cmd run $name
  if ($LASTEXITCODE -ne 0) {
    throw "npm run $name failed with exit code $LASTEXITCODE"
  }
}

Push-Location $projectRoot
try {
  Invoke-NpmScript "test"
  Invoke-NpmScript "typecheck"
  Invoke-NpmScript "build"
  Invoke-NpmScript "verify:bridge"
  Invoke-NpmScript "validate"
  Invoke-NpmScript "companion:test"
  Invoke-NpmScript "companion:package"
} finally {
  Pop-Location
}

$companionDist = Join-Path $distDir "companion"
if (-not (Test-Path -LiteralPath $companionDist)) {
  throw "Companion output directory was not found: $companionDist"
}
$companionInstaller = Get-ChildItem -LiteralPath $companionDist -Filter $companionInstallerPattern -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if ($null -eq $companionInstaller) {
  throw "Companion installer was not found under dist\companion."
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$releaseVersion = $manifest.Version -replace "\.0$", ""
$archivePath = Join-Path $distDir "Claude-StreamDeck-$releaseVersion-Windows.zip"
$staging = Join-Path $distDir (".windows-release-" + [guid]::NewGuid().ToString("N"))
$resolvedDist = [IO.Path]::GetFullPath($distDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedStaging = [IO.Path]::GetFullPath($staging)
if (-not $resolvedStaging.StartsWith($resolvedDist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use an unexpected staging directory: $resolvedStaging"
}

New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Copy-Item -LiteralPath $pluginPath -Destination (Join-Path $staging $pluginName)
  Copy-Item -LiteralPath $companionInstaller.FullName -Destination (Join-Path $staging $companionInstaller.Name)
  Copy-Item -LiteralPath $guidePath -Destination (Join-Path $staging "INSTALL_WINDOWS_KO.html")
  Copy-Item -LiteralPath $launcherPath -Destination (Join-Path $staging "Install.cmd")

  $checksumLines = @()
  foreach ($releaseFile in @($pluginPath, $companionInstaller.FullName, $guidePath, $launcherPath)) {
    $releaseHash = Get-FileHash -LiteralPath $releaseFile -Algorithm SHA256
    $checksumLines += "$($releaseHash.Hash)  $([IO.Path]::GetFileName($releaseFile))"
  }
  Set-Content -LiteralPath (Join-Path $staging "SHA256SUMS.txt") -Value $checksumLines -Encoding Ascii

  if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
  }
  Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $archivePath -CompressionLevel Optimal

  $archiveHash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
  Write-Output "Windows release bundle created."
  Write-Output "Path: $archivePath"
  Write-Output "SHA256: $($archiveHash.Hash)"
} finally {
  if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
  }
}
