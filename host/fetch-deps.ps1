# Fetches the WebView2 assemblies this project compiles against.
#
#   pwsh -File fetch-deps.ps1
#
# They are vendored into lib\ rather than restored through NuGet so the build
# needs no package manager and no network. Run this once, or again to move to a
# newer WebView2 SDK.

[CmdletBinding()]
param(
    [string] $Version = '1.0.4191.47'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$lib = Join-Path $here 'lib'
$nupkg = Join-Path $here 'webview2.nupkg'
$extract = Join-Path $here '.webview2-extract'

$url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"

Write-Host ""
Write-Host "Fetching WebView2 SDK $Version" -ForegroundColor Magenta
Write-Host "  $url"

try {
    Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing
} catch {
    Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Check the network, then try again. Nothing was changed."
    exit 1
}

if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $nupkg -DestinationPath $extract -Force
New-Item -ItemType Directory -Force $lib | Out-Null

$copies = @(
    @{ From = "lib\net462\Microsoft.Web.WebView2.Core.dll";          To = 'Microsoft.Web.WebView2.Core.dll' }
    @{ From = "lib\net462\Microsoft.Web.WebView2.WinForms.dll";      To = 'Microsoft.Web.WebView2.WinForms.dll' }
    @{ From = "runtimes\win-x64\native\WebView2Loader.dll";          To = 'WebView2Loader.dll' }
)

foreach ($c in $copies) {
    $src = Join-Path $extract $c.From
    if (-not (Test-Path $src)) { Write-Host "  Missing $($c.From)" -ForegroundColor Red; exit 1 }
    Copy-Item $src -Destination (Join-Path $lib $c.To) -Force
    Write-Host "  lib\$($c.To)"
}

Remove-Item $nupkg -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  Done. Now run: pwsh -File build.ps1" -ForegroundColor Green
Write-Host ""
