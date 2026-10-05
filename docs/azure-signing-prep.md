# Azure signing preparation

Signing will use the existing `rclickersigning` account in East US and the planned `rclicker` Public Trust profile. The verified publisher is **Cameron Ashley**. All applications can use that same publisher profile.

## GitHub authentication

In the `rclicker-github-signing` app registration, add a GitHub federated credential for this repository's default branch:

- Organization: `camster91`; Organization ID: `33962910`.
- Repository: `RFrontdesk`; Repository ID: `1381855799`.
- Entity type: **Branch**; branch: `main`.
- Issuer: `https://token.actions.githubusercontent.com`.
- Audience: `api://AzureADTokenExchange`.
- Subject: `repo:camster91@33962910/RFrontdesk@1381855799:ref:refs/heads/main`.

These values match the repository's current immutable OIDC subject. Check `gh api repos/camster91/RFrontdesk/actions/oidc/customization/sub` if its authentication settings change. Pull requests and other branches must not have a signing credential.

The app needs **Artifact Signing Certificate Profile Signer** access, scoped to the `rclicker` certificate profile. Federation creates authentication access and must be approved before it is added.

## Repository variables

| Variable | Value |
| --- | --- |
| `AZURE_TENANT_ID` | `b5bdee55-d9ca-4dff-91f6-1a22445d1710` |
| `AZURE_SUBSCRIPTION_ID` | `3a6865fe-4a72-4c30-80f9-8f2645e0d6ea` |
| `AZURE_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | `rclickersigning` |
| `AZURE_SIGNING_PROFILE` | `rclicker` |
| `AZURE_SIGNING_PUBLISHER` | `Cameron Ashley` |
| `AZURE_CLIENT_ID` | `5933cfcf-1e92-46f9-ba71-226192f71417` |

These are identifiers, not secrets. **Add `AZURE_CLIENT_ID` last**, only after the identity is Completed, the profile exists, the signing role is assigned, and this repository's federated credential is present.

## Check an artifact

The existing **Build** workflow signs only pushes or manual runs on `main`, after activation. Run it manually from `main` first and download `rotman-front-desk`. Signing happens before the ZIP is built, and `For IT.txt` records the final executable's signature and hash. The workflow fails if the signature, timestamp or publisher is wrong.

Only `RotmanFrontDesk.exe` needs this signing step; the WebView2 assemblies retain their vendor signatures. The workflow uploads artifacts and does not publish a release.
