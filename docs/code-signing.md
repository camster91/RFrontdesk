# Code signing (Azure Artifact Signing)

GitHub builds `RFrontDesk.exe` on every push (`.github/workflows/build.yml`) and, on `main`, signs it with **Azure Artifact Signing** (formerly "Trusted Signing"). The signed zip is attached to each run under **Actions → Build → Artifacts → rfrontdesk**.

Signing goes through the shared workflow in the Rclicker repo (`camster91/Rclicker/.github/workflows/sign-windows.yml`), which every one of camster91's Windows apps uses. The Azure IDs live in that one file, so this repository stores no secrets and no Azure variables. GitHub signs in to Azure with a short-lived OIDC token.

This is the cloud alternative to option A in `EDR_AND_SIGNING.md` (a certificate from IT). Both work; `host/build.ps1 -Pfx` still signs locally with an IT certificate.

## How the build works

1. **build** compiles into `dist\\` and uploads it unsigned as the artifact `rfrontdesk-windows`.
2. **sign** (only on `main`) calls the shared workflow. It signs and verifies `RFrontDesk.exe` and uploads `rfrontdesk-windows-signed`.
3. **package** runs `tools/package.ps1` on the signed folder, or on the unsigned one for other branches, and uploads the zip as `rfrontdesk`. It runs after signing so `For IT.txt` records the signed exe's hash.

If signing fails on `main`, nothing is packaged, so an unsigned zip can never pass for a signed one.

## Setup (already done)

The shared workflow needs one thing per repository: a federated credential that lets this repo's `main` branch sign. It exists as `RFrontdesk-main` on the `rclicker-github-signing` app registration (**Microsoft Entra ID → App registrations → rclicker-github-signing → Certificates & secrets → Federated credentials**):

- Scenario: **GitHub Actions deploying Azure resources**
- Organization: `camster91`, Repository: `RFrontdesk`, Entity type: **Branch**, Branch: `main`
- Immutable subject: `repo:camster91@33962910/RFrontdesk@1381855799:ref:refs/heads/main`
- Issuer: `https://token.actions.githubusercontent.com`; audience: `api://AzureADTokenExchange`

Verify the current subject with `gh api repos/camster91/RFrontdesk/actions/oidc/customization/sub` before changing federation. Existing signing access is already configured; no per-repository Azure variables need to be added.

If the default branch is ever renamed, update that credential and the `refs/heads/main` check in the workflow.

For the Azure account itself (subscription, signing account, identity check, certificate profile), see `docs/code-signing.md` in the Rclicker repo.

## Checking a build

- The shared workflow's **Verify signatures** step requires a valid Authenticode signature, a timestamp, and the exact verified publisher **Cameron Ashley**. It fails before uploading the signed artifact if any check fails.
- These rejection paths are tested in Rclicker's Windows CI with synthetic signatures. The policy is maintained in the shared signer; do not restore the obsolete inline signing steps from this repository's earlier draft.
- `For IT.txt` inside the zip shows `Signed  : yes, by <publisher>` and the exe's SHA-256.
- On Windows: right-click `RFrontDesk.exe` → **Properties** → **Digital Signatures**.

## Troubleshooting

- **sign fails at "Sign in to Azure"**: the federated credential above is missing or doesn't match the repository or branch name (case matters).
- **sign fails with a 403 from the signing service**: the app registration has lost the **Artifact Signing Certificate Profile Signer** role on the signing account.
- **The run fails before starting with "workflow was not found"**: `sign-windows.yml` isn't on Rclicker's `main` branch.

## Notes

- Only `RFrontDesk.exe` is signed. The WebView2 DLLs are already signed by Microsoft.
- The certificate names whoever passed the Azure identity check (you, or Ashbi if you verified as an organization). It is publicly trusted, so it works on any Windows PC, not just domain machines.
- A new certificate can still see a SmartScreen prompt for a short while until downloads build reputation. Acceptance by managed endpoint agents still needs a test on an IT-controlled PC.
