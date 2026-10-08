# RFrontdesk (RFrontDesk)

An equipment loan desk as a portable Windows app: staff check items in and out, borrowers use a locked-down self-service kiosk, and everything (records, backups, log) lives in one folder you can copy.

Built to replace a paper sign-out sheet at an equipment desk.

## What it does and why

The desk lends out cables, adapters, keys and other gear all day, often from a tablet that members of the public can see and touch. Front Desk gives staff a fast checkout and returns flow behind a PIN, and gives borrowers a kiosk that can only borrow and ask to return. It needs no admin rights: install it for one Windows user with a click, or just run the exe from the unzipped folder. For ZIP installations the records live in a `data` folder beside the app. MSIX installations use package-private storage; export a backup to move the records to another machine.

## Getting and installing it

Download the latest [GitHub release](https://github.com/camster91/RFrontdesk/releases), which includes both install choices and `SHA256SUMS.txt`:

1. **MSIX (managed staff workstation).** Open `RFrontDesk-1.1.0.msix` and let Windows App Installer add the package for your account. Windows creates the Start menu entry and owns package updates, startup and uninstall. The package uses a read-only install location and keeps its writable data in the package's private data area.
2. **ZIP (portable or per-user install).** Extract `RFrontDesk-1.1.0.zip`, double-click **RFrontDesk.exe**, and choose **Install**. It installs for you only into `%LOCALAPPDATA%\Programs\RFrontDesk`, with a Start menu shortcut and no admin rights. To keep it portable, choose **Run from this folder** instead. On a public tablet, tick **This is a public tablet: lock it down**.
3. **Update.** Open a newer MSIX or install a newer ZIP the same way. The records, backups and PIN settings are kept within that distribution's supported data location.
4. **Uninstall.** Before removing an MSIX, sign in to the staff panel and use **Settings → Export Backup (JSON)**, then keep the file somewhere protected. Windows removes the package's private data on uninstall. The ZIP installer keeps records by default; its uninstall option can delete them when you explicitly choose it.

**Public-tablet deployment:** use the ZIP installer and select **This is a public tablet: lock it down**. A normal MSIX Start menu or package-startup launch uses staff mode with DevTools available. MSIX does not carry the ZIP installer’s kiosk flags across launches; installing the package alone does not provide a locked kiosk. Change the factory PIN before exposing either installation to borrowers.

For the ZIP install, the **Start with Windows** toggle is available in the Windows app settings. For an MSIX install, startup is managed by the Windows package, so the app does not add a duplicate registry startup entry.

For IT: `RFrontDesk.exe --install --quiet [--kiosk] [--autostart] [--no-desktop]` and `--uninstall --quiet [--delete-data]`. The zip's `For IT.txt` lists exactly what it writes where.

The GitHub release publishes a signed ZIP/EXE and a signed MSIX from the same
Windows build. The MSIX Publisher is derived from the release certificate, and
its stable identity uses the executable's four-part version. The release also
contains SHA-256 hashes for both files.

The packaged app writes to `%LOCALAPPDATA%\Packages\<family>\LocalCache\Local\FrontDesk`,
never beside the read-only package. On first launch it copies missing files from
the old per-user install/fallback data folder without replacing existing
IndexedDB/WebView2 data, backups, logs or PIN settings. Package updates retain
that folder. Windows owns package startup and uninstall; the packaged host does
not add a duplicate registry Run entry. Package-local data is removed by a
normal Windows uninstall, so export a backup before removing the package.

The installer is built into the one exe, on purpose: a separate self-extracting setup is the shape endpoint agents (SentinelOne, CrowdStrike) delete, and a second exe would be a second file to sign.

## Key features

- **Two surfaces**: a public kiosk (borrow, request a return, see only your own loans) and PIN-protected staff screens. There is no route from the kiosk to staff screens; staff entry is a press-and-hold gesture plus the PIN, with escalating lockouts and an idle auto-lock
- **Checkout and returns**: find a borrower by phone (or walk-in), add items with type-ahead search, confirm. Returns record OK, damaged or lost, and kiosk return requests wait in a staff queue until the item is physically back
- **Admin panel**: queue, currently out, overdue, full loan history, items, people, reports and settings
- **Catalog that tolerates messy names**: `Room 115`, `115` and `115 Key` resolve to one entry, ambiguous matches are never resolved silently, duplicates are surfaced for review, and merges keep aliases and can be undone
- **Kiosk-added items** are flagged for staff review, with limits on how many a single kiosk session can create
- **Built for scale**: paged lists and a search tested against a catalog of ten thousand items
- **Reports**: period summaries, a loans-over-time chart, busiest items and borrowers, untouched inventory, and CSV export with spreadsheet formula-injection protection
- **Backups**: automatic daily backup (newest 30 kept), backup on demand, verified on write, restore that refuses invalid files and never changes the device PIN
- **Kiosk hardening** (`--kiosk`, or the install option): full screen with no way out of the app (no close button, Alt+F4, Escape or Exit), DevTools disabled, navigation locked to the app's own page, shell links refused, and the setting survives a reboot via the startup entry
- **Touch-first UI** with an on-screen keyboard, dark and light themes from one set of colour tokens, and WCAG AA contrast measured against the actual painted background in both themes

## Tech stack

- **App**: vanilla JavaScript, HTML and CSS (`web/`), data in IndexedDB
- **Host**: a small C# WinForms wrapper around Microsoft Edge WebView2 (`host/FrontDesk.cs`) providing the window, tray icon, data folder, native file dialogs and navigation policy. It compiles with the C# compiler that ships with Windows against vendored WebView2 assemblies, so no SDK is needed
- **Tests**: Node.js scripts that drive the real page in headless Edge, sandbox tests that lift sections of `app.js`, and C# host tests compiled against the shipping host source
- **Packaging**: PowerShell build and packaging scripts that produce a self-verifying zip

## Building

GitHub does this on every push and pull request (`.github/workflows/build.yml`): fetch WebView2, build, run every test suite, sign (on `main`), package, and try install, update and uninstall from the zip. Nobody needs a build computer, and nothing is deployed.

To build by hand on Windows, with PowerShell 7:

```powershell
pwsh -File host/fetch-deps.ps1     # download the WebView2 assemblies (fresh clone)
pwsh -File host/build.ps1          # build into dist/
pwsh -File tools/package.ps1       # build the distributable zip in release/
pwsh -File tools/package-msix.ps1  # MSIX from the valid signed exe
```

`build.ps1` keeps `dist/data` across rebuilds so a desk's records are never wiped, and `package.ps1` refuses to build a zip that would include live borrower data. The app needs the Microsoft Edge WebView2 Runtime, which is present on almost every Windows 10/11 machine.

To look at the UI in a normal browser:

```powershell
node tools/serve.cjs               # serves web/ on 127.0.0.1
```

## Testing

```powershell
npm ci                             # once: the test tools
node tools/test-all.cjs
```

Runs every suite: host bridge, host flags, setup and crash recovery, toast stack, screen router, report aggregation, touch keyboard, browser UI, kiosk, layout at real widths (375 to 1440 px, touch and mouse), backup round trip, catalog at scale, sessions, and records. The browser suites need Microsoft Edge installed.

## Project structure

```
web/      the app (index.html, js/app.js, styles.css)
host/     the Windows wrapper (C#), build script and icon
tools/    test suites, local dev server, icon generator, packaging scripts
packaging/msix/  MSIX manifest template
docs/     code review notes and code signing notes
.github/  the GitHub build
```

The full code review, with what was fixed and how each fix was verified, is in [docs/CODE_REVIEW.md](docs/CODE_REVIEW.md).
