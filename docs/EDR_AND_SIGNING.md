# Why the endpoint agent flags this, and what stops it

Written 2026-09-21, after SentinelOne flagged a **different** build
(another in-house app, a PyInstaller folder build) twice as *Suspicious
Activity / Detected suspicious file* with `QUARANTINED FILES 0`. The question
that prompted this was whether Front Desk would do the same.

Short answer: it can, and the only things that reliably stop it are a code
signature from a certificate the organisation owns, or an explicit allowlist
entry naming this file. Everything else is mitigation, not a fix.

## If you read nothing else

1. **Email ITS this request.** One paragraph, copy-paste ready — see
   *Option A* below. Ask for a **code-signing certificate from the
   organisation's own certificate authority, delivered as a `.pfx` with the
   private key.** Domain machines already trust that CA, so nothing has to be
   bought.
2. **In the same email, ask them to allowlist the app in the SentinelOne console**
   as a false positive, and attach `RFrontDesk.exe`. The console route works
   against the binary's reputation rather than one hash, so it survives rebuilds.
3. **Until one of those lands, do not rebuild.** Every rebuild is a new binary
   with a new hash, and this compiler cannot reproduce a build. Whatever hash gets
   allowlisted must be the hash of the build that ships.
4. **Nothing else needs installing.** `signtool` and the Windows SDK are *not*
   required — the in-box `Set-AuthenticodeSignature` does the job, and this has
   been verified end to end on this machine, not assumed.

## Where Front Desk stands right now

| | |
|---|---|
| Signed | **No** — `Get-AuthenticodeSignature` returns `NotSigned` |
| Version resource | Filled in (see below) |
| Icon | Embedded, seven sizes (16–256) — see `tools/make-icon.ps1` |
| Ships as | `release\RFrontDesk-*.zip` containing a **folder** build, not a single-file exe |
| Code-signing certificate on this machine | **None** in `Cert:\CurrentUser\My` or `Cert:\LocalMachine\My` |
| A trustworthy CA to issue one | **Usually** — an organisation's own CA is normally in the trusted root store of its domain machines |
| `signtool.exe` on this machine | Not installed — and **not needed**, see below |
| Build reproducibility | **No** — the in-box `csc.exe` has no `/deterministic`, so every rebuild is a different binary |
| SHA-256 of the current build | printed by `host/build.ps1` on every run — **ask the build, not this table** |

Two rows carry the whole answer.

**The hash is not stable.** It has changed on every rebuild this project has done
— `5940B6…`, then `120B21…`, then `8CB9AA…`, `0A1046…` for the 2026-09-21 build
that carries the Phase 7 fixes, and `D43099…` for the build that added the icon —
because the compiler on this box cannot build reproducibly. An allowlist entry is
per-file, so **an allowlist entry made today is void the moment anyone rebuilds.**
If a hash gets allowlisted, that build is the build that ships; do not rebuild
over it. This is the single strongest argument for signing instead, which keeps
working across rebuilds.

**Signing needs no SDK and no install.** `Set-AuthenticodeSignature` ships in
`Microsoft.PowerShell.Security`, is present on this machine, and takes
`-Certificate`, `-HashAlgorithm SHA256` and `-TimestampServer`. For a single exe
with no page hashes to seal, it produces the same Authenticode signature
`signtool` would. `build.ps1` now uses `signtool` when it finds it and falls back
to the cmdlet when it does not, so a machine with no Windows SDK can still ship a
signed build. The earlier note in this document saying signtool had to be
installed was wrong, and is corrected above.

## What was already done, and why it is only mitigation

An endpoint agent that has no reputation data for a file falls back to its own
judgement, and the profile it is most suspicious of is *a small, unsigned binary
that appeared on disk a moment ago, describing itself as nothing*. Four things
have been changed to move this build away from that profile.

**1. It is a folder, not a single file.** This is the biggest one, and it is
already proven on this machine: a single-file self-extracting build gets
*deleted on execution*, while the folder build of the same app is left alone
even when the launcher itself is flagged. Front Desk ships as a folder —
`RFrontDesk.exe` plus the WebView2 assemblies beside it — and must keep
shipping that way. Do not "improve" it into a single-file exe.

This is also why the deliverable is a **zip** and not an installer. `iexpress`
would produce exactly the shape that gets deleted, so it cannot be the "one file
you carry" answer, and an MSI would install to `Program Files`, where the app
cannot write its own data folder without elevation. `tools/package.ps1` builds
the zip and prints the exe's hash into the `For IT.txt` it puts inside it.

Re-verified after the icon build: with both SentinelOne (`SentinelAgent`,
`SentinelStaticEngineScanner`) and CrowdStrike (`CSFalconService`) running on this
machine, the exe survived repeated execution from three different folders with its
hash unchanged — `D4309943…`, not quarantined, not deleted. The folder build
holding up is measured, not assumed.

**2. The exe now describes itself.** `host/AssemblyInfo.cs` compiles a Win32
version resource in:

```
FileDescription : RFrontDesk
ProductName     : RFrontDesk
CompanyName     : RFrontDesk
FileVersion     : 1.0.0.0
```

Without this the resource is blank and the file reports `0.0.0.0`, which is
indistinguishable from a dropper. This does not make the file *trusted*; it makes
it legible.

**3. There is nothing in it that looks like evasion.** For the record, and worth
saying to whoever reviews it: plain C# against the in-box .NET Framework, no
packer, no obfuscation, no reflection-emitted code, no process injection, no
network listener, no persistence beyond a `HKCU\...\Run` key that is only ever
written when a user clicks the tray's start-with-Windows toggle. `app.manifest`
requests `asInvoker` — the app never asks for elevation, which is why it installs
into the user's own folder without a UAC prompt. The full source is in the
`host/` and `web/` folders beside this document, and can be handed over as-is.

**4. The build writes its own hash out.** `host/build.ps1` prints the SHA-256 and
the signature status at the end of every build, so the value IT needs is never
guesswork.

None of that is a guarantee. An agent can still decide an unsigned in-house
binary is worth a look, and no amount of metadata prevents that.

## What actually stops it — pick one

### Option A: sign it with a certificate the organisation owns (the real fix)

A valid Authenticode signature from a certificate chaining to a CA the machine
trusts turns "unknown binary" into "signed by us", and unlike hash
allowlisting **it keeps working across rebuilds** — which matters enormously here,
because this build cannot be reproduced byte-for-byte.

**An organisation's own CA is usually enough.** If its root is in the domain
machines' trusted root store (check `Cert:\LocalMachine\Root`), no commercial
certificate has to be bought: IT issues one from that CA, and every
domain-joined desk machine already trusts it, because the root is pushed by
policy.

**What to ask ITS for, specifically:**

> A **code-signing certificate** issued by *our certificate authority*, for
> signing an in-house front-desk application.
> — Key usage: **Digital Signature**; Extended Key Usage: **Code Signing
> (`1.3.6.1.5.5.7.3.3`)**.
> — Delivered as a **`.pfx` including the private key** (a `.cer` alone cannot
> sign — the build will say so and stop).
> — Key must be **exportable** or installable into the user profile of the
> standard (non-admin) account that runs the build.
> — SHA-256.

Then, either install it and build by thumbprint:

```powershell
# find the thumbprint after installing
Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -like '*Front*' } | Select-Object Subject, Thumbprint

pwsh -File host\build.ps1 -Sign <thumbprint>
```

…or hand the `.pfx` straight to the build, which imports it into the current
user's store (no elevation) and leaves it there for later builds:

```powershell
pwsh -File host\build.ps1 -Pfx .\codesign.pfx
```

The build signs with SHA-256, timestamps it, and **verifies its own output** —
it fails if the signature does not come back `Valid`, so a silently-broken
signature cannot ship. It also warns if no timestamp came back, because a
signature without one stops verifying the day the certificate expires and every
installed copy starts being flagged again.

**A caveat worth knowing before choosing this route.** An internal-CA signature
is trusted by machines that trust that root — which is exactly the population
that matters here, the desk machines. It is *not* a commercial certificate, so it
does not build SmartScreen reputation for machines outside the organisation. For
an endpoint agent running under the organisation's policy it is the right answer; if this app
is ever installed on a non-domain machine, a commercial certificate would be
needed for that machine.

**This route is verified to work on this machine, not assumed.** A throwaway
self-signed code-signing certificate was created in `CurrentUser\My` and used to
sign a *copy* of the exe with the in-box cmdlet:

```
cmdlet returned: Status=UnknownError  Signer=CN=Front Desk signing dry run
timestamped by : CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1
signature present : True  (SignatureType=Authenticode)
```

An `Authenticode` signature was produced, and the timestamp server was reached
from this machine — so the mechanism, the store access and the network path are
all known to work. `UnknownError` is the correct status for a self-signed
certificate: nothing trusts the root. A certificate from a CA the machine trusts returns
`Valid`, which is the exact condition the build checks before it will report
success. The test certificate and the signed copy were both deleted afterwards;
the shipped exe was never signed with it.

### Signing on GitHub

The GitHub build signs on `main` with **Azure Artifact Signing**, a publicly
trusted certificate, so it needs no certificate from IT. Setup is in
[`code-signing.md`](code-signing.md). An IT certificate still works for a
local build with `host\build.ps1 -Pfx`.

### Option B: allowlist this file (works today, needs IT)

Give IT the path and the hash **printed by the build that is actually going to
ship** — do not copy the value out of this document, because it is stale by
design. Run the build, take the last two lines, and send those:

```
C:\Users\<you>\RFrontDesk\dist\RFrontDesk.exe
SHA-256 <the hash the build just printed>
```

The folder shape helps here too — if the agent flags by hash, the WebView2
assemblies beside the exe are Microsoft-signed already and need nothing.

Two caveats, both real:

- **This allows exactly this binary.** Any rebuild produces a different hash and
  a different verdict. Freeze this build, or re-submit after every rebuild.
- **It is per-machine-class.** An allowlist entry made for this machine's agent
  policy may not apply to the desk machines unless it is made at the policy level.

The alternative that avoids the rebuild problem entirely is submitting the file
to SentinelOne as a **false-positive / allowlist request through the console**,
which files it against the binary's reputation rather than one hash. That is an
IT action; there is no local equivalent.

### Option C: do nothing

Worth stating plainly, because the calendar case is evidence: the flag was
`QUARANTINED FILES 0`. A "Detected suspicious file" entry means the agent looked
at it; zero quarantined means it did not remove it. Front Desk's folder build is
the same shape, so the likely outcome of doing nothing is a detection entry in
the console and an app that keeps working — annoying for whoever reads the
console, not fatal for the desk. That is a judgement for whoever owns the
machine, not a guarantee.

## What not to do

- **Do not rebuild and expect the previous allowlist entry to cover it.** The
  compiler on this box cannot produce a reproducible build.
- **Do not convert it to a single-file exe** for tidiness. That is the shape that
  gets deleted here.
- **Do not self-sign** and treat it as done. An untrusted signature is not
  better than no signature.
- **Do not chase this by making the binary look different** — renaming,
  restamping, or shipping a differently-shaped launcher. An agent that has a
  detection for this app will keep having one, and the changes that actually help
  are signing and allowlisting.

## Behaviour changed so the app looks less like malware (2026-10-06)

A review against what CrowdStrike and SentinelOne score found four things the
app did that are also things malware does. All four are gone:

- **Uninstall no longer moves its own exe into Temp.** A running exe cannot
  delete itself, and the old trick (rename it into `%TEMP%`, delete it on the
  next launch) is a textbook evasion pattern. Uninstall now removes everything
  else and says that one file is left and safe to delete.
- **The zip has no install script.** `Install Front Desk.cmd` is gone: a script
  inside a downloaded zip is a phishing shape that mail filters and agents
  block. Opening `RFrontDesk.exe` from the unzipped folder offers *Install* or
  *Run from this folder* instead.
- **The start-with-Windows entry changes only when someone asks.** It used to be
  rewritten silently at every launch when it looked out of date, which is what
  persistence looks like. Now Settings shows an out-of-date entry with a
  **Fix it** button.
- **The file's company name is "Cameron Ashley"**, the same name as on the
  signing certificate, and so is the Publisher in Settings > Apps. A file that
  claims one maker and is signed by another is one more thing to score.

What is left needs IT, not code: an allowlist by **publisher** (the signer),
not by hash, in the CrowdStrike and SentinelOne consoles, and in AppLocker or
WDAC if the machines use them. A publisher rule survives every new build.

## For the record: the build change that was not about the agent

While editing `build.ps1` for the above, a separate footgun was found and fixed.
The script cleans its output directory wholesale before compiling — and the
output directory *is* the live desk, because `dist\data\` holds the IndexedDB
folder, the backups and the log. A rebuild after an update would have deleted the
front desk's records, its backup history, and its log, with no warning and no
error. The build now moves `dist\data` aside for the duration and puts it back
afterwards, so a rebuild is safe to run over a working install.

Verified: a rebuild leaves `dist\data\browser`, `dist\data\backups` and
`frontdesk.log` intact, and the app launches clean afterwards
(`... start: version=1.0.0 runtime=153.0.4234.48 ... portable=True`, no errors).

## Status

**Open, and tracked as [issue #9](https://github.com/camster91/RFrontdesk/issues/9).**
The v1.0.0 release is unsigned (`signed: NotSigned`), so everything above is a
proposal rather than a report: what the agent does with a *signed* build has not
been measured, because no certificate exists on this machine yet. Getting one is
a hand-off to IT — and when it arrives, the measurement to record here is the same
one the unsigned build already has, so the two can be compared.
