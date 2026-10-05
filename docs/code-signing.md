# Code signing (Azure Artifact Signing)

GitHub builds `RotmanFrontDesk.exe` on every push (`.github/workflows/build.yml`) and, on `main`, signs it with **Azure Artifact Signing** (formerly "Trusted Signing"). The signed zip is attached to each run under **Actions → Build → Artifacts → rotman-front-desk**.

Until the setup below is done, the signing steps are skipped and the zip is unsigned. Nothing else changes.

This is the cloud alternative to option A in `EDR_AND_SIGNING.md` (a certificate from IT). Both work; `host/build.ps1 -Pfx` still signs locally with an IT certificate.

## If Rclicker is already set up (recommended)

The same Azure signing account and certificate profile can sign both apps. The Basic plan allows one profile, and it covers both easily. You only need:

1. **Microsoft Entra ID → App registrations →** `rclicker-github-signing` → **Certificates & secrets → Federated credentials → Add credential**:
   - Scenario: **GitHub Actions deploying Azure resources**
   - Organization: `camster91`, Repository: `RFrontdesk`, Entity type: **Branch**, Branch: `main`
2. In https://github.com/camster91/RFrontdesk → **Settings → Secrets and variables → Actions → Variables**, add the same six variables Rclicker uses:

| Name | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID of `rclicker-github-signing` |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Your subscription ID |
| `AZURE_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | e.g. `rclickersigning` |
| `AZURE_SIGNING_PROFILE` | e.g. `rclicker` |

The next push to `main` signs the exe.

## Starting from nothing

Follow `docs/code-signing.md` in the Rclicker repo (Azure subscription, register `Microsoft.CodeSigning`, signing account, identity check, certificate profile, app registration). Then do the two steps above.

## Checking a build

- The **Verify signature** step in the workflow fails the build if the signature isn't valid.
- `For IT.txt` inside the zip shows `Signed : yes -- <publisher>` and the exe's SHA-256.
- On Windows: right-click `RotmanFrontDesk.exe` → **Properties** → **Digital Signatures**.

## Notes

- Only `RotmanFrontDesk.exe` is signed. The WebView2 DLLs are already signed by Microsoft.
- The certificate names whoever passed the Azure identity check (you, or Ashbi if you verified as an organization). It is publicly trusted, so it works on any Windows PC, not just domain machines.
- A new certificate can still see a SmartScreen prompt for a short while until downloads build reputation. Endpoint agents usually trust a valid, timestamped signature much sooner.
