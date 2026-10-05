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
# Why no installer: the app writes its data beside itself, so installing it to
# Program Files would break it -- that folder is not writable without elevation,
# and the whole point of this app is that it needs none. Unzipping wherever it
# is going to live *is* the install, and it is one step.
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

# Read the signature off the exe rather than assuming, so For IT.txt never
# claims "unsigned" for a signed build (or the reverse).
$sig = Get-AuthenticodeSignature -FilePath $exe
if ($sig.Status -eq 'Valid') {
    $signedLine = "yes -- $($sig.SignerCertificate.Subject)"
    $signedIntro = "This folder is an in-house application, Authenticode-signed by its publisher."
} else {
    $signedLine = 'no'
    $signedIntro = "This folder is an unsigned in-house application."
}
Say "exe signed: $signedLine"

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

Equipment checkout and returns for the front desk. There is nothing to install
and no admin rights are needed: everything the app uses is in this folder.

FIRST RUN
---------
1. Put this folder somewhere it can stay -- the Desktop is fine, a USB stick
   works too. Do not use Program Files: the app keeps its records in a data
   folder beside the exe, and Program Files is not writable without admin
   rights, so it would not be able to save anything.
2. Double-click RotmanFrontDesk.exe.
3. You get a welcome screen. The staff screens are behind the Rotman logo:
   press and hold it for about two seconds.
4. The factory PIN is 1234. CHANGE IT the first time you log in --
   Admin > Settings > PIN.

WHAT IT SAVES
-------------
Everything lives in the data folder beside the app: the records, the backups and
the log. To move the desk to another machine, copy the whole folder -- that is
the entire migration.

A backup is written once a day, on the first launch of the day, and the newest
30 are kept. Backups contain borrower names and phone numbers in readable form,
so treat the backup folder as you would any list of names and numbers.

ON A TABLET (KIOSK)
-------------------
A borrower sees only the welcome screen: they can borrow and ask to return, and
nothing else. To lock a public install down, start the app with the flag
--no-devtools. The simplest way is a shortcut: right-click RotmanFrontDesk.exe,
Send to > Desktop (create shortcut), then add --no-devtools to the end of the
shortcut's Target. Staff still get in with the logo hold.

IF IT WILL NOT START
--------------------
It needs the Microsoft Edge WebView2 Runtime, which is present on nearly every
Windows 10 and 11 machine. If it is missing, the app says so and offers to open
the download page. Nothing else is required.
"@
    Set-Content -Path (Join-Path $root 'START HERE.txt') -Encoding ASCII -Value $startHere

    # Whoever deploys this on a managed machine will meet the endpoint agent, and
    # it is better that they arrive with the answer than that they discover it.
    $forIt = @"
FOR IT -- ENDPOINT SECURITY
===========================

$signedIntro On a managed machine the
endpoint agent will very likely take an interest in it. Two things resolve that,
and the full write-up -- including what was measured rather than assumed -- is
docs\EDR_AND_SIGNING.md in the project folder this was built from.

WHAT THIS IS
------------
RotmanFrontDesk.exe is a 64-bit WinForms window hosting a WebView2 control that
loads the HTML, CSS and JavaScript in web\. It needs the Microsoft Edge WebView2
Runtime, which is already on standard Windows 10 and 11 images.

It installs nothing. It writes no registry keys except one HKCU\...\Run entry,
and only if a user turns on "start with Windows" from the tray menu. It opens no
network listener. It requests asInvoker, so it never prompts for elevation. Its
data -- an IndexedDB database, backups and a log -- lives in data\ beside the exe.

This is deliberately a FOLDER build, not a single-file exe: a self-extracting
single-file build is the shape SentinelOne and CrowdStrike delete on execution,
while this shape is allowed through.

WHAT TO DO -- either one
------------------------
A. Sign it. A code-signing certificate from the University of Toronto Certificate
   Authority is enough, because that root is already trusted on domain machines.
   Ask for: Digital Signature key usage, Extended Key Usage Code Signing
   (1.3.6.1.5.5.7.3.3), delivered as a .pfx including the private key, SHA-256.
   The build signs and verifies its own output, and needs no Windows SDK.

B. Allowlist it in the SentinelOne console as a false positive, and attach the
   exe. Prefer the console route over a per-hash entry: the in-box compiler
   cannot build reproducibly, so every rebuild is a different binary and a hash
   entry is void the next time anyone rebuilds. If a specific hash has to be
   allowlisted, use the one below -- but freeze that build.

THE BINARY IN THIS ZIP
----------------------
File    : RotmanFrontDesk.exe
Version : $fileVersion
SHA-256 : $hash
Signed  : $signedLine
"@
    Set-Content -Path (Join-Path $root 'For IT.txt') -Encoding ASCII -Value $forIt

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
