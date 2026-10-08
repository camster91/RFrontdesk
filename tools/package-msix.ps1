<#
.SYNOPSIS
    Pack the signed RFrontDesk folder into an MSIX package.

.DESCRIPTION
    The executable must already carry a valid Authenticode signature. The
    manifest Publisher is read from that certificate, which keeps the package
    identity tied to the binary Windows will run. The package itself is signed
    by the release signer after makeappx; isolated CI signs it with a temporary
    certificate only for install/lifecycle checks.
#>

[CmdletBinding()]
param(
    [string] $DistDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),
    [string] $OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
    [string] $IdentityName = 'CameronAshley.RFrontDesk',
    [string] $PublisherDisplayName = 'Cameron Ashley'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $DistDir 'RFrontDesk.exe'
$template = Join-Path $root 'packaging\msix\AppxManifest.xml.in'
$stage = Join-Path $root 'build\msix-staging'
$assets = Join-Path $stage 'Assets'

function Fail($message) { throw $message }
function Say($message) { Write-Host "  $message" }

if (-not (Test-Path $exePath)) { Fail "No executable at $exePath. Run host\build.ps1 first." }
if (-not (Test-Path $template)) { Fail "Missing manifest template $template." }
if ($IdentityName -notmatch '^[A-Za-z0-9.\-]{3,50}$') { Fail "IdentityName is not a stable MSIX identity: $IdentityName" }

$sig = Get-AuthenticodeSignature -FilePath $exePath
if ($sig.Status -ne 'Valid' -or -not $sig.SignerCertificate) {
    Fail "The executable must have a valid signature before MSIX packaging (status: $($sig.Status))."
}
$publisher = [string]$sig.SignerCertificate.Subject
if (-not $publisher.Trim()) { Fail 'The signed executable has no certificate subject.' }
Say "publisher from signed exe: $publisher"

$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
$fileVersion = [string]$info.FileVersion
if ($fileVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
    Fail "The executable FileVersion must have four numeric parts, got '$fileVersion'."
}
$packageVersion = $fileVersion
$displayVersion = $fileVersion -replace '\.0$', ''
Say "identity $IdentityName version $packageVersion"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage, $assets | Out-Null

# A package must never carry live borrower records from a build workstation.
# Copy every app file except dist\data; package-aware startup creates its own
# writable LocalCache data folder and migrates an existing desk without replace.
Get-ChildItem $DistDir -Force |
    Where-Object { $_.Name -ne 'data' } |
    Copy-Item -Destination $stage -Recurse -Force

& (Join-Path $PSScriptRoot 'make-icon.ps1') -OutFile (Join-Path $root 'host\frontdesk.ico') -PngDir $assets
if ($LASTEXITCODE -ne 0) { Fail 'make-icon.ps1 failed while creating MSIX assets.' }

$escape = { param([string]$value) [System.Security.SecurityElement]::Escape($value) }
$values = @{
    '{{NAME}}' = $IdentityName
    '{{PUBLISHER}}' = (&$escape $publisher)
    '{{VERSION}}' = $packageVersion
    '{{DISPLAY_NAME}}' = 'RFrontDesk'
    '{{PUBLISHER_DISPLAY}}' = (&$escape $PublisherDisplayName)
    '{{EXE}}' = 'RFrontDesk.exe'
}
$manifest = Get-Content $template -Raw
foreach ($key in $values.Keys) { $manifest = $manifest.Replace($key, [string]$values[$key]) }
Set-Content (Join-Path $stage 'AppxManifest.xml') -Value $manifest -Encoding utf8

$makeAppx = Get-Command makeappx.exe -ErrorAction SilentlyContinue
if (-not $makeAppx) {
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $makeAppx = Get-ChildItem $sdk -Filter makeappx.exe -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' } |
        Sort-Object FullName -Descending | Select-Object -First 1
}
if (-not $makeAppx) { Fail 'makeappx.exe was not found; install the Windows SDK.' }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$output = Join-Path $OutDir ("RFrontDesk-$displayVersion.msix")
Get-ChildItem $OutDir -Filter 'RFrontDesk-*.msix' -File -ErrorAction SilentlyContinue | Remove-Item -Force
Say "packing $output"
& $makeAppx.FullName pack /d $stage /p $output /o
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $output)) { Fail 'makeappx failed to create the MSIX.' }

$size = [math]::Round((Get-Item $output).Length / 1MB, 1)
Write-Host "  MSIX: $output ($size MB)" -ForegroundColor Green
Write-Host "    Publisher: $publisher"
Write-Host "    Identity version: $packageVersion"
