# Builds RFrontDesk into a folder you can copy anywhere.
#
#   pwsh -File build.ps1              # build into ..\dist
#   pwsh -File build.ps1 -Sign <thumbprint>      # sign with an installed certificate
#   pwsh -File build.ps1 -Pfx .\codesign.pfx     # sign with a .pfx from IT
#
# The build has no -DevTools switch: DevTools are on by default and are turned
# off at run time, on the kiosk machine, with the app's own --no-devtools flag.
# (This line used to advertise -DevTools:$false, which the script rejects -- a
# [CmdletBinding()] script refuses a parameter it does not declare.)
#
# No SDK, no NuGet restore, nothing to install: it uses the C# compiler that
# ships with .NET Framework, and the WebView2 assemblies vendored in lib\.
# Signing needs no SDK either -- see the note above the Sign section.
#
# The output is a folder of assemblies plus a small .exe. That shape is
# deliberate -- a single-file self-extracting build gets deleted on execution
# by SentinelOne and CrowdStrike, while a folder-of-assemblies launcher is
# allowed through.

[CmdletBinding()]
param(
    # Where the runnable app lands.
    [string] $OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist'),

    # Copy web\ next to the exe so the result is self-contained.
    [switch] $NoWeb = $false,

    # Leave the PDB out of the shipped folder.
    [switch] $NoSymbols = $false,

    # Authenticode-sign the exe with the certificate with this thumbprint.
    # See the note at the top of the file: this is the one thing that stops an
    # endpoint agent from treating the build as an unknown binary.
    [string] $Sign = '',

    # Or sign with a .pfx file, which is how a certificate usually arrives from
    # IT. It is imported into the current user's store -- no elevation -- and left
    # there, so later builds can use -Sign with its thumbprint instead.
    [string] $Pfx = '',

    # Password for -Pfx. Omit it and the script asks, without echoing.
    [string] $PfxPassword = '',

    # RFC 3161 timestamp server, used only when signing.
    [string] $TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

function Say($msg)  { Write-Host "  $msg" }

# --- The desk's data, and how it survives a build that stops early ----------
# dist\data is the live desk: the IndexedDB folder, the backups and the log. The
# output directory is cleaned wholesale, so the data is moved aside for the build
# and put back after.
#
# "Put back after" has to mean *every* way out of this script, not only the happy
# one. The restore used to sit at the bottom of the file, past the compile, while
# `Fail` below is `exit 1` -- so a build that stopped on a compile error left the
# front desk's records in a GUID-named folder under %TEMP% and a fresh, empty
# data\ beside the new exe. Nothing printed said where they had gone, and to
# anyone at the desk it reads as "everything is gone".
#
# Hence: the restore is a function, `Fail` calls it, and a `trap` catches the
# paths that are not `Fail` (an unhandled terminating error under
# `$ErrorActionPreference = 'Stop'`).
$dataDir = Join-Path $OutputDir 'data'
$script:stashedData = $null

function Restore-Data {
    if (-not $script:stashedData) { return }
    # Cleared before the move, not after: if the move itself throws, the trap
    # fires, calls this again, and must not try the same thing twice.
    $stash = $script:stashedData
    $script:stashedData = $null
    try {
        Move-Item -LiteralPath $stash -Destination $dataDir -Force
        Say "put $dataDir back"
    } catch {
        # Never lose it silently. Worst case the operator is told exactly where
        # the desk's records are and what to do with them.
        Write-Host "  ERROR: could not put the desk's data back at $dataDir" -ForegroundColor Red
        Write-Host "         Nothing is lost -- it is in: $stash" -ForegroundColor Red
        Write-Host "         Move that folder to $dataDir by hand before running the app." -ForegroundColor Red
    }
}

function Fail($msg) {
    Write-Host "  ERROR: $msg" -ForegroundColor Red
    Restore-Data
    exit 1
}

trap {
    Restore-Data
    Write-Host "  ERROR: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "RFrontDesk - build" -ForegroundColor Magenta
Write-Host ""

# --- Toolchain -------------------------------------------------------------
# The compiler that ships with .NET Framework. Present on every Windows box,
# so this project has no build prerequisites at all.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) { Fail "No C# compiler found. .NET Framework 4.x is required." }
Say "compiler: $csc"

$coreDll = Join-Path $here 'lib\Microsoft.Web.WebView2.Core.dll'
$formsDll = Join-Path $here 'lib\Microsoft.Web.WebView2.WinForms.dll'
$loaderDll = Join-Path $here 'lib\WebView2Loader.dll'
# Microsoft's licence terms for the WebView2 files ship with them.
$wvLicense = Join-Path $here 'lib\LICENSE.txt'
$wvNotice = Join-Path $here 'lib\NOTICE.txt'
foreach ($f in @($coreDll, $formsDll, $loaderDll, $wvLicense, $wvNotice)) {
    if (-not (Test-Path $f)) {
        Fail "Missing $f. Re-run fetch-deps.ps1 to download the WebView2 assemblies."
    }
}

$source = Join-Path $here 'FrontDesk.cs'
$assemblyInfo = Join-Path $here 'AssemblyInfo.cs'
$manifest = Join-Path $here 'app.manifest'
$icon = Join-Path $here 'frontdesk.ico'
$webDir = Join-Path (Split-Path -Parent $here) 'web'
if (-not (Test-Path $webDir)) { Fail "No web folder at $webDir" }
if (-not (Test-Path $assemblyInfo)) { Fail "Missing $assemblyInfo" }
# The exe's icon. Regenerate with tools\make-icon.ps1 rather than editing the
# .ico -- it is drawn from source like everything else here, because this machine
# has no image tooling to edit one with.
if (-not (Test-Path $icon)) {
    Fail "Missing $icon. Run:  pwsh -File tools\make-icon.ps1"
}

# --- Signing certificate ---------------------------------------------------
# Resolved here, before anything expensive, and used further down after the exe
# exists. Two reasons it is split: a wrong thumbprint or a missing .pfx should
# fail in a second rather than after a build that has already moved the live
# data folder aside, and a certificate that cannot sign is worth knowing about
# before the compile rather than after it.
#
# Optional, and the only step in this script that changes how an endpoint agent
# sees the build. An unsigned exe cannot be trusted by reputation, so an agent
# falls back to its own judgement about a small binary that appeared on disk a
# moment ago. A signature from a certificate the organisation owns is what turns
# that into "this is our software".
#
# Two ways in, because the certificate can arrive either way:
#   -Sign <thumbprint>   already installed in CurrentUser\My or LocalMachine\My
#   -Pfx <path>          still a file, as IT usually hands it over
$cert = $null

if ($Pfx) {
    if (-not (Test-Path $Pfx)) { Fail "-Pfx: no file at $Pfx" }
    if ($PfxPassword) {
        $secure = ConvertTo-SecureString $PfxPassword -AsPlainText -Force
    } else {
        $secure = Read-Host -Prompt "  password for $(Split-Path -Leaf $Pfx)" -AsSecureString
    }
    Say "importing $(Split-Path -Leaf $Pfx) into Cert:\CurrentUser\My"
    try {
        $cert = Import-PfxCertificate -FilePath $Pfx -CertStoreLocation 'Cert:\CurrentUser\My' `
                    -Password $secure -ErrorAction Stop
    } catch {
        Fail "Could not import the .pfx: $($_.Exception.Message)"
    }
    Say "imported: $($cert.Subject)"
} elseif ($Sign) {
    foreach ($store in 'Cert:\CurrentUser\My', 'Cert:\LocalMachine\My') {
        $cert = Get-ChildItem $store -ErrorAction SilentlyContinue |
                    Where-Object { $_.Thumbprint -eq $Sign } | Select-Object -First 1
        if ($cert) { break }
    }
    if (-not $cert) {
        Fail "No certificate with thumbprint $Sign in CurrentUser\My or LocalMachine\My. If IT sent a .pfx, use -Pfx instead."
    }
    Say "signing certificate: $($cert.Subject)"
}

if ($cert) {
    # A certificate without its private key can verify a signature but never make
    # one. Failing here is much clearer than a signing error later, and it is what
    # a certificate exported as .cer rather than .pfx looks like.
    if (-not $cert.HasPrivateKey) {
        Fail "Certificate $($cert.Thumbprint) has no private key, so it cannot sign. Ask IT for the .pfx, which carries it."
    }
    $eku = $cert.EnhancedKeyUsageList.ObjectId.Value
    if ($eku -and ($eku -notcontains '1.3.6.1.5.5.7.3.3')) {
        Say "warning: this certificate's key usage is not Code Signing ($($eku -join ', '))"
    }
}

# --- Output ----------------------------------------------------------------
# dist\data is the live desk: the IndexedDB folder, the backups and the log.
# Rebuilding in place used to delete all of it, because the output directory is
# cleaned wholesale -- a rebuild after an update would have taken the front
# desk's records with it. It is moved aside for the build and put back after,
# so a rebuild is always safe to run over a working install.
# (`$dataDir` and the restore live near the top, with `Fail` -- see there.)

# Refuse to build over a running copy, and do it before anything is touched.
# `Remove-Item $OutputDir` cannot delete the exe or the WebView2 DLLs while the
# app holds them, so it throws; and with the data already moved aside, the desk
# would be left with its records in %TEMP% and the old app still running on the
# old files. Asking first costs nothing and turns a half-finished build into one
# sentence the operator can act on.
$runningApp = @(Get-Process -Name 'RFrontDesk' -ErrorAction SilentlyContinue)
if ($runningApp.Length -gt 0) {
    Fail "RFrontDesk is running (PID $($runningApp.Id -join ', ')). Exit it from the tray icon, then build again."
}

if (Test-Path $dataDir) {
    $script:stashedData = Join-Path ([System.IO.Path]::GetTempPath()) ("frontdesk-data-" + [System.Guid]::NewGuid().ToString('N'))
    Say "keeping $dataDir (moving it aside for the build)"
    Move-Item -LiteralPath $dataDir -Destination $script:stashedData -Force
}

if (Test-Path $OutputDir) {
    Say "cleaning $OutputDir"
    Remove-Item $OutputDir -Recurse -Force
}
New-Item -ItemType Directory -Force $OutputDir | Out-Null

$exePath = Join-Path $OutputDir 'RFrontDesk.exe'
$pdbPath = Join-Path $OutputDir 'RFrontDesk.pdb'

# --- Compile ---------------------------------------------------------------
# /langversion:5 is explicit rather than implied: this compiler only does C# 5,
# and saying so turns "I used a newer feature" into a clear error message.
$refs = @(
    $coreDll,
    $formsDll,
    'System.dll',
    'System.Core.dll',
    'System.Drawing.dll',
    'System.Windows.Forms.dll'
)

$cscArgs = @(
    '/nologo'
    '/target:winexe'
    '/platform:x64'
    '/langversion:5'
    '/optimize+'
    "/win32manifest:$manifest"
    "/win32icon:$icon"
    "/out:$exePath"
    '/debug:pdbonly'
)
foreach ($r in $refs) { $cscArgs += "/reference:$r" }
$cscArgs += $source
$cscArgs += $assemblyInfo

Say "compiling..."
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { Fail "Compilation failed with exit code $LASTEXITCODE." }
if (-not (Test-Path $exePath)) { Fail "Compiler reported success but produced no exe." }

# --- Assemble the folder ---------------------------------------------------
Say "copying WebView2 assemblies"
Copy-Item $coreDll  -Destination $OutputDir -Force
Copy-Item $formsDll -Destination $OutputDir -Force
Copy-Item $loaderDll -Destination $OutputDir -Force
$licDir = Join-Path $OutputDir 'licenses'
New-Item -ItemType Directory -Force $licDir | Out-Null
Copy-Item $wvLicense -Destination (Join-Path $licDir 'WebView2 LICENSE.txt') -Force
Copy-Item $wvNotice -Destination (Join-Path $licDir 'WebView2 NOTICE.txt') -Force

if (-not $NoSymbols) {
    # Kept so a crash report from the desk is actionable.
    Say "keeping symbols"
} else {
    Remove-Item $pdbPath -Force -ErrorAction SilentlyContinue
}

if (-not $NoWeb) {
    Say "copying web assets"
    $destWeb = Join-Path $OutputDir 'web'
    New-Item -ItemType Directory -Force $destWeb | Out-Null
    Copy-Item (Join-Path $webDir '*') -Destination $destWeb -Recurse -Force
}

# data\ is where the database, backups and log live. Created here when there is
# none, so the folder belongs to whoever unpacked the app -- which is what keeps
# it writable without elevation. An install that already has one keeps it.
#
# The build is in one piece by this point, so the stash can go back and be
# forgotten; if anything stopped us earlier, `Fail` or the trap already did it.
if ($script:stashedData) {
    Restore-Data
} else {
    New-Item -ItemType Directory -Force $dataDir | Out-Null
    Set-Content -Path (Join-Path $dataDir 'README.txt') -Encoding ASCII -Value @'
This folder holds everything Front Desk saves:

  browser\    the app's database (IndexedDB)
  backups\    one backup per day, written on the first launch of the day,
              newest 30 kept
  frontdesk.log

Copy the whole folder to move the desk to another machine.
'@
}

# --- Sign ------------------------------------------------------------------
# The certificate was resolved near the top of the script; this is the act.
#
# Two ways to do the signing: signtool when the Windows SDK is present, and the
# in-box Set-AuthenticodeSignature when it is not. The fallback is not a lesser
# result -- for a single exe with no page hashes to seal, the cmdlet produces the
# same Authenticode signature. That matters here: this machine has no SDK and no
# signtool, so without the fallback it could not sign at all.
if ($cert) {
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($signtool) {
        Say "signing with signtool, thumbprint $($cert.Thumbprint)"
        & $signtool.Source sign /sha1 $cert.Thumbprint /fd sha256 /tr $TimestampUrl /td sha256 $exePath
        if ($LASTEXITCODE -ne 0) { Fail "Signing failed with exit code $LASTEXITCODE." }
    } else {
        Say "signing with Set-AuthenticodeSignature (no Windows SDK on this machine)"
        try {
            Set-AuthenticodeSignature -FilePath $exePath -Certificate $cert `
                -HashAlgorithm SHA256 -TimestampServer $TimestampUrl -ErrorAction Stop | Out-Null
        } catch {
            Fail "Signing failed: $($_.Exception.Message)"
        }
    }

    $sig = Get-AuthenticodeSignature $exePath
    if ($sig.Status -ne 'Valid') { Fail "Signed, but the signature does not verify: $($sig.Status) $($sig.StatusMessage)" }
    Say "signature: $($sig.SignerCertificate.Subject)"
    # A signature without a timestamp stops verifying the day the certificate
    # expires, and every installed copy starts being flagged again. Worth saying
    # out loud, because the signing step above succeeds either way.
    if ($sig.TimeStamperCertificate) {
        Say "timestamped by: $($sig.TimeStamperCertificate.Subject)"
    } else {
        Say "WARNING: no timestamp came back, so this signature expires with the certificate"
    }
}

# --- Report ----------------------------------------------------------------
$exe = Get-Item $exePath
$total = (Get-ChildItem $OutputDir -Recurse -File | Measure-Object -Property Length -Sum).Sum

Write-Host ""
Write-Host "  built $($exe.Name)  $([math]::Round($exe.Length/1KB,1)) KB" -ForegroundColor Green
Write-Host "  folder: $OutputDir  ($([math]::Round($total/1MB,2)) MB total)"
Write-Host ""
# The hash is here because allowlisting is per-file: this compiler cannot build
# reproducibly, so every rebuild is a new binary. If the security team allows
# this file, they need the hash of the file that was tested -- not of the next
# build. Keep the exe this hash names.
$hash = (Get-FileHash -Path $exePath -Algorithm SHA256).Hash
$sig = Get-AuthenticodeSignature $exePath
Write-Host "  sha256: $hash"
Write-Host "  signed: $($sig.Status)"
if (-not $sig.SignerCertificate) {
    # Not a failure -- an unsigned build runs fine. It is just the thing that
    # decides how an endpoint agent treats it, so it is stated rather than left
    # to be discovered. See docs\EDR_AND_SIGNING.md.
    Write-Host "          unsigned: an endpoint agent has nothing to go on but its own judgement"
    Write-Host "          to sign:  pwsh -File build.ps1 -Sign <thumbprint>   or   -Pfx <file>"
}
Write-Host ""
Write-Host "  Run it:  $exePath"
Write-Host "  Options: --minimized  start in the tray"
Write-Host "           --no-devtools  lock down a kiosk install (--kiosk is the same)"
Write-Host "           --install / --uninstall  set it up for this Windows user"
Write-Host ""
