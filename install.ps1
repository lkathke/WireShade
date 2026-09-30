# WireShade CLI installer for Windows (PowerShell) — no Node/npm required.
#
#   irm https://raw.githubusercontent.com/lkathke/WireShade/master/install.ps1 | iex
#
# Downloads the standalone `wireshade` executable (Node embedded) into
# %LOCALAPPDATA%\WireShade and adds it to your user PATH.

$ErrorActionPreference = 'Stop'

$repo = 'lkathke/WireShade'

if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -and -not $env:WIRESHADE_FORCE_X64) {
    Write-Warning "No native Windows ARM64 build yet; installing the x64 build (runs under emulation)."
}
$asset = 'wireshade-win-x64.exe'

$dir = Join-Path $env:LOCALAPPDATA 'WireShade'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'wireshade.exe'

$tag = if ($env:WIRESHADE_VERSION) { "download/$($env:WIRESHADE_VERSION)" } else { 'latest/download' }
$url = "https://github.com/$repo/releases/$tag/$asset"

Write-Host "Downloading $asset ..."
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing

# Add the install dir to the user PATH (persisted) if not already present.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $dir), 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host "Added $dir to your PATH."
}

Write-Host ""
Write-Host "Installed wireshade to $exe"
Write-Host "Open a NEW terminal and run:  wireshade help"
