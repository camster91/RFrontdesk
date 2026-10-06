# Packs dist\ into the zip you hand to a desk.
#
#   pwsh -File tools/package.ps1
#   pwsh -File tools/package.ps1 -NoSymbols     # leave the .pdb out
#
# Why a zip, when the request was "a nice installable file": the obvious answer
# -- a self-extracting .exe built with iexpress -- is exactly the shape
# SentinelOne and CrowdStrike delete on execution on this machine, so it is the
# one deliverable that cannot work on "any computer". A zip is the same one file
# to carry, and what comes out of it is a folder, which is the shape that is
# allowed through.
#
# The install is inside the app: "Install Front Desk.cmd" in the zip runs
# RotmanFrontDesk.exe --install, which copies the folder to the user's own
# %LOCALAPPDATA%\Programs, adds a Start menu shortcut and an entry in Settings >
# Apps to remove it. No admin rights, and no second exe to sign. Not Program
# Files: the app writes its data beside itself, and that folder is not writable
# without elevation.
#
# The zip contains a top-level "Rotman Front Desk" folder, so extracting it on
# Windows produces one tidy folder rather than scattering seven files into
# Downloads.

[CmdletBinding()]
param(
    # The built folder to pack. Must exist; run host\build.ps1 first.
    [string] $DistDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),

    # Where the zip lands.
    [string] $OutDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),

    # Leave the symbols out of the shipped folder.
    [switch] $NoSymbols = $false,

    # The folder name inside the zip, and what extracting creates.
    [string] $FolderName = 'Rotman Front Desk'
)

$ErrorActionPreference = 'Stop'

function Say($msg)  { Write-Host "  $msg" }
function Fail($msg) { Write-Host "  ERROR: $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Rotman Front Desk - package" -ForegroundColor Magenta
Write-Host ""

$exe = Join-Path $DistDir 'RotmanFrontDesk.exe'
if (-not (Test-Path $exe)) { Fail "No build at $DistDir. Run host\build.ps1 first." }

# The version comes off the exe rather than out of AssemblyInfo.cs, so the zip is
# named after the binary that is actually inside it.
$info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
$fileVersion = $info.FileVersion
if (-not $fileVersion) { $fileVersion = '0.0.0.0' }
# For the file name, drop a trailing ".0": AssemblyVersion is four parts, but
# nobody writes 1.0.0.0 on a download. The exe's real FileVersion is left alone
# in For IT.txt, where it should be exact.
$version = $fileVersion -replace '\.0$', ''
$product = if ($info.ProductName) { $info.ProductName } else { 'Rotman Front Desk' }
Say "packing $product $fileVersion"

$hash = (Get-FileHash -Path $exe -Algorithm SHA256).Hash
Say "exe sha256 $hash"

# Read off the exe, so For IT.txt says what is true of this build. It used to
# say "Signed: no" whatever the build was.
$sig = Get-AuthenticodeSignature $exe
# Signed means a signature is there; Valid also needs the machine to trust its
# root. (An Azure Artifact Signing certificate is trusted everywhere; one from
# the University's own CA only on its domain machines.)
$signed = [bool]$sig.SignerCertificate
if ($signed) {
    $signedLine = "yes, by $($sig.SignerCertificate.Subject)"
    if ($sig.TimeStamperCertificate) { $signedLine += ", timestamped" }
    if ($sig.Status -ne 'Valid') { $signedLine += " (shown as $($sig.Status) on the build machine)" }
} else {
    $signedLine = "no ($($sig.Status))"
}
Say "signed: $signedLine"

# --- Stage -----------------------------------------------------------------
# Built in a temp folder rather than in the project, so the project never holds
# a second copy of the app that can drift from dist\.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("frontdesk-pack-" + [System.Guid]::NewGuid().ToString('N'))
$root = Join-Path $stage $FolderName
New-Item -ItemType Directory -Force $root | Out-Null

try {
    Copy-Item (Join-Path $DistDir '*') -Destination $root -Recurse -Force
    if ($NoSymbols) { Remove-Item (Join-Path $root 'RotmanFrontDesk.pdb') -Force -ErrorAction SilentlyContinue }

    # The data folder ships empty -- a README and nothing else. If a build ever
    # carries records, backups or a log into a package, that is a desk's borrower
    # names and phone numbers going out with the installer, so it is checked
    # rather than assumed. (It can happen: dist\ is a live install on the machine
    # that builds it.)
    $dataDir = Join-Path $root 'data'
    if (-not (Test-Path $dataDir)) { Fail "The build has no data folder; the app expects one." }
    $leftovers = Get-ChildItem $dataDir -Recurse -Force | Where-Object { $_.Name -ne 'README.txt' }
    if ($leftovers) {
        Fail ("data\ is not a clean install -- refusing to package it. It holds: " +
              (($leftovers | ForEach-Object { $_.FullName.Replace("$root\", '') }) -join ', '))
    }
    Say "data\ is a clean install"

    # ASCII, not UTF-8: these are read on whatever machine the zip reaches, and
    # the build script that writes data\README.txt makes the same choice.
    $startHere = @"
$product
$('=' * $product.Length)

Equipment checkout and returns for the front desk.

INSTALL
-------
1. Right-click the zip and choose Extract All. (Running it from inside the
   zip does not work.)
2. In the folder that makes, double-click "Install Front Desk".
3. Pick your options and click Install. No admin rights are needed.
   On a public tablet, tick "This is a public tablet: lock it down".

It is installed for you only, with a Start menu shortcut. To update, install a
newer zip the same way: the records are kept.

FIRST RUN
---------
- The staff screens are behind the Rotman logo: press and hold it for about
  two seconds.
- The PIN starts as 1234. Change it the first time you sign in:
  Settings > PIN.

UNINSTALL
---------
Windows Settings > Apps > Installed apps > Rotman Front Desk > Uninstall.
The desk's records are kept unless you tick the box to delete them too.

WITHOUT INSTALLING
------------------
You can also run RotmanFrontDesk.exe straight from this folder, for example
from a USB stick. It keeps its records in the data folder beside it. Do not
put it in Program Files: it could not save anything there.

WHAT IT SAVES
-------------
Everything lives in the data folder beside the app: the records, the backups
and the log. A backup is written once a day and the newest 30 are kept.
Backups contain borrower names and phone numbers in readable form, so treat
the backup folder as you would any list of names and numbers.

IF IT WILL NOT START
--------------------
It needs the Microsoft Edge WebView2 Runtime, which is on nearly every
Windows 10 and 11 machine. If it is missing, the app says so and offers to
open the download page.
"@
    Set-Content -Path (Join-Path $root 'START HERE.txt') -Encoding ASCII -Value $startHere

    # Whoever deploys this on a managed machine will meet the endpoint agent, and
    # it is better that they arrive with the answer than that they discover it.
    $signedIntro = if ($signed) {
        "This folder is a signed in-house application ($signedLine)."
    } else {
        "This folder is an UNSIGNED in-house application. On a managed machine the`r`nendpoint agent will very likely take an interest in it; see WHAT TO DO below."
    }
    $forIt = @"
FOR IT
======

$signedIntro

The full write-up on endpoint security is docs\EDR_AND_SIGNING.md in the
project this was built from.

WHAT THIS IS
------------
RotmanFrontDesk.exe is a 64-bit WinForms window hosting a WebView2 control that
loads the HTML, CSS and JavaScript in web\. It needs the Microsoft Edge WebView2
Runtime, which is already on standard Windows 10 and 11 images. It opens no
network listener and requests asInvoker, so it never asks for elevation.

INSTALLING
----------
Install and uninstall are built into the same exe; there is no separate setup
program. Everything is per-user, with no admin rights:

  %LOCALAPPDATA%\Programs\Rotman Front Desk\   the app, and its data\ folder
  Start menu shortcut (and a desktop one, unless turned off)
  HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RotmanFrontDesk
  HKCU\Software\Microsoft\Windows\CurrentVersion\Run  only if "start with
                                                      Windows" is chosen

Silent install, from the unzipped folder:
  RotmanFrontDesk.exe --install --quiet [--kiosk] [--autostart] [--no-desktop]

Silent uninstall (keeps the records unless --delete-data is added):
  "%LOCALAPPDATA%\Programs\Rotman Front Desk\RotmanFrontDesk.exe" --uninstall --quiet

Exit codes: 0 done, 1 cancelled, 2 failed, 3 removed but some files were in use.

--kiosk locks a public tablet: full screen, no way out of the app, no DevTools.

This is deliberately a FOLDER build, not a single-file exe: a self-extracting
single-file build is the shape SentinelOne and CrowdStrike delete on execution,
while this shape is allowed through.

WHAT TO DO IF IT IS FLAGGED -- either one
-----------------------------------------
A. Sign it. A code-signing certificate from the University of Toronto Certificate
   Authority is enough, because that root is already trusted on domain machines.
   Ask for: Digital Signature key usage, Extended Key Usage Code Signing
   (1.3.6.1.5.5.7.3.3), delivered as a .pfx including the private key, SHA-256.
   (The GitHub build signs with Azure Artifact Signing instead, once it is set
   up: see docs\code-signing.md.)

B. Allowlist it in the SentinelOne console as a false positive, and attach the
   exe. Prefer the console route over a per-hash entry: every build is a
   different binary, so a hash entry is void the next time it is rebuilt. If a
   specific hash has to be allowlisted, use the one below.

THE BINARY IN THIS ZIP
----------------------
File    : RotmanFrontDesk.exe
Version : $fileVersion
SHA-256 : $hash
Signed  : $signedLine

Third-party licences are in the licenses\ folder.
"@
    Set-Content -Path (Join-Path $root 'For IT.txt') -Encoding ASCII -Value $forIt

    # The one thing a person double-clicks to install. A .cmd rather than a
    # script, so no execution policy gets in the way; all it does is start the
    # app's own installer, after checking the zip was extracted first.
    Set-Content -Path (Join-Path $root 'Install Front Desk.cmd') -Encoding ASCII -Value @(
        '@echo off',
        'rem Installs Rotman Front Desk for this Windows user. No admin rights needed.',
        'if not exist "%~dp0RotmanFrontDesk.exe" goto notextracted',
        'if not exist "%~dp0Microsoft.Web.WebView2.Core.dll" goto notextracted',
        'start "" "%~dp0RotmanFrontDesk.exe" --install',
        'exit /b 0',
        ':notextracted',
        'echo.',
        'echo   Extract the zip first: close this, right-click the zip, choose Extract All,',
        'echo   then run "Install Front Desk" from the folder that makes.',
        'echo.',
        'pause',
        'exit /b 1'
    )

    # --- Zip ---------------------------------------------------------------
    New-Item -ItemType Directory -Force $OutDir | Out-Null
    $zip = Join-Path $OutDir ("Rotman-Front-Desk-$version.zip")
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Say "compressing..."
    Compress-Archive -Path $root -DestinationPath $zip -CompressionLevel Optimal
    if (-not (Test-Path $zip)) { Fail "Compress-Archive produced no file." }

    # --- Verify the zip, not the staging folder ----------------------------
    # What matters is what comes back out of the archive, so it is extracted
    # somewhere else and inspected there. A zip that lists the right names but
    # unpacks a truncated exe would otherwise ship.
    $check = Join-Path ([System.IO.Path]::GetTempPath()) ("frontdesk-check-" + [System.Guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -Path $zip -DestinationPath $check
        $unpacked = Join-Path $check $FolderName
        if (-not (Test-Path $unpacked)) { Fail "The zip does not contain a '$FolderName' folder." }

        $unpackedExe = Join-Path $unpacked 'RotmanFrontDesk.exe'
        if (-not (Test-Path $unpackedExe)) { Fail "No exe in the unpacked folder." }
        foreach ($need in @('Install Front Desk.cmd', 'START HERE.txt', 'For IT.txt',
                            'licenses\WebView2 LICENSE.txt', 'licenses\WebView2 NOTICE.txt')) {
            if (-not (Test-Path (Join-Path $unpacked $need))) { Fail "The zip is missing $need." }
        }
        $unpackedSig = Get-AuthenticodeSignature $unpackedExe
        if ($signed -and $unpackedSig.Status -ne $sig.Status) { Fail "The exe's signature did not survive the zip: $($unpackedSig.Status)" }

        # Byte-for-byte, because the exe is the thing that gets allowlisted and
        # the hash in For IT.txt has to describe it.
        $roundTrip = (Get-FileHash -Path $unpackedExe -Algorithm SHA256).Hash
        if ($roundTrip -ne $hash) { Fail "The exe changed on the way through the zip ($roundTrip)." }

        # The icon and the version resource are what make the file legible to a
        # person and to an endpoint agent. Both are easy to lose silently in a
        # build change, so the package checks they are still there.
        $packed = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($unpackedExe)
        if (-not $packed.FileDescription) { Fail "The packaged exe has no version resource." }
        Add-Type -AssemblyName System.Drawing
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($unpackedExe)
        if (-not $icon) { Fail "The packaged exe has no icon." }
        $iconSize = "$($icon.Width)x$($icon.Height)"
        $icon.Dispose()

        $files = Get-ChildItem $unpacked -Recurse -File
        $bytes = ($files | Measure-Object Length -Sum).Sum

        Write-Host ""
        Write-Host "  packaged $([System.IO.Path]::GetFileName($zip))" -ForegroundColor Green
        Write-Host "  $([math]::Round((Get-Item $zip).Length/1MB, 2)) MB zipped, $([math]::Round($bytes/1MB, 2)) MB unpacked, $($files.Count) files"
        Write-Host "  contents (verified by unpacking it again):"
        foreach ($f in ($files | Sort-Object FullName)) {
            Write-Host ("    {0,-42} {1,9:N1} KB" -f $f.FullName.Replace("$unpacked\", ''), ($f.Length / 1KB))
        }
        Write-Host ""
        Write-Host "  exe  $($packed.FileDescription) $($packed.FileVersion), icon $iconSize, sha256 matches"
        Write-Host "  zip  $zip"
        Write-Host ""
        Write-Host "  To check it runs from the zip: extract it somewhere new and start the exe there."
        Write-Host ""
    } finally {
        Remove-Item $check -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
