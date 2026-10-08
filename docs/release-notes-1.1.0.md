# RFrontDesk 1.1.0

The GitHub release contains these signed Windows downloads:

- `RFrontDesk-1.1.0.msix` — the managed Windows package. Windows owns its Start menu entry, startup task, updates and uninstall.
- `RFrontDesk-1.1.0.zip` — the portable folder build, which can also install per user from `RFrontDesk.exe` without administrator rights.
- `SHA256SUMS.txt` — SHA-256 checksums for both downloads.

Before uninstalling the MSIX, export a JSON backup from the Windows app settings. Windows removes the package's private data during uninstall. The release has been verified through the build's package and data-migration checks; testing on a particular managed desktop, including its endpoint policy, remains the administrator's responsibility.

- New name: RFrontDesk.
- Kiosk fixes:
  - A return cannot be lost before the condition question.
  - “Borrow another” lets someone take several items in one visit.
  - Messages do not carry over to the next person.
  - Names keep their capitals.
- Easy per-user install and uninstall are built into the executable, with no administrator rights.
- The release executable is signed with Azure Artifact Signing.
- Endpoint-security fixes:
  - Uninstall no longer moves the executable into Temp.
  - There is no install script.
  - The startup entry changes only when someone asks.
  - The company name matches the signer.
- Fixes:
  - Empty names are refused.
  - The “Merge with…” picker offers everyone.
  - The All loans date filter works past 1,000 loans.
  - Import asks before replacing everything.
  - A dismissed duplicate group stays dismissed.
