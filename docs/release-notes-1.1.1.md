# RFrontDesk 1.1.1

A simpler kiosk action and release maintenance.

- Typing an unlisted item now shows one **Add and borrow** action, with a note
  that staff will review the new item. Enter still selects existing items and
  never creates a new catalog entry. Existing creation limits remain in place.
- Borrower actions respond as soon as their buttons appear, even while loan
  rows are still loading. A quick tap on Edit no longer gets lost during loading.
- Release filenames, package-version checks and notes now follow the host's
  version constant, reducing the chance of a stale version in a future release.
- Build checkouts do not retain GitHub credentials, and the shared signer is
  pinned to its verified revision.

## Install or update

Use `RFrontDesk-1.1.1.msix` for a staff workstation, or extract
`RFrontDesk-1.1.1.zip` for the portable app or public-tablet kiosk installation.
The ZIP includes the per-user installer. `SHA256SUMS.txt` covers both packages.
Updates retain data within the same distribution's supported storage location.

For a public tablet, use the ZIP installer and its lockdown option. A normal
MSIX launch uses staff mode; installing the package alone does not lock a kiosk.
Export a backup before uninstalling an MSIX, because Windows removes its private
data. ZIP uninstall keeps records unless you explicitly choose to delete them.
