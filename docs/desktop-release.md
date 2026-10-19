# Desktop releases

Desktop releases are reproducible builds from stable tags. The bundled runtime is
Node.js `26.5.0`, downloaded from nodejs.org and verified against the official
`SHASUMS256.txt`.

## Prepare a release

1. Set the same stable version in `package.json`, `src-tauri/Cargo.toml`,
   `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`:

   ```sh
   pnpm version:set 1.2.3
   pnpm version:check 1.2.3
   ```

2. Commit the version change, create the tag `v1.2.3` on that commit and push it.

Only tags matching `vX.Y.Z` exactly start the release workflow. The workflow can
also be started manually with an existing stable tag. Before any build starts,
it verifies that all four files use the version of the tag.

## Build outputs

The workflow builds four independent targets in parallel:

- macOS Apple Silicon (`aarch64-apple-darwin`, on `macos-26`)
- macOS Intel (`x86_64-apple-darwin`, cross-compiled on `macos-26`, which is
  about twice as fast as the Intel runners)
- Windows x64 (`x86_64-pc-windows-msvc`, on `windows-2025`)
- Linux x64 (`x86_64-unknown-linux-gnu`, on `ubuntu-22.04`, the oldest
  supported Ubuntu, so the AppImage and `.deb` work with older glibc versions)

Each job downloads the Node.js runtime for its own OS and architecture. Release
assets get stable, version-less names, so
`https://github.com/midudev/gojs/releases/latest/download/<name>` always points
to the newest published release (the landing page links to these):

| Platform | Assets |
| --- | --- |
| macOS Apple Silicon | `GoJS-macOS-arm64.dmg` |
| macOS Intel | `GoJS-macOS-x64.dmg` |
| Windows x64 | `GoJS-Windows-x64-setup.exe`, `GoJS-Windows-x64.msi` |
| Linux x64 | `GoJS-Linux-x64.AppImage`, `GoJS-Linux-x64.deb`, `GoJS-Linux-x64.rpm` |

Each target also produces a `SHA256SUMS-<name>.txt` file.

Build outputs are retained as workflow artifacts. A single draft GitHub release
is created only after every target succeeds. Review that draft before publishing
it; rerunning a workflow for a tag that already has a release fails instead of
creating a duplicate.

## Workflow security

- Every action is pinned to a full commit SHA, and Dependabot
  (`.github/dependabot.yml`) proposes updates after a 7-day cooldown. The
  repository requires SHA-pinned actions.
- Workflows start with no permissions; each job requests only what it needs, and
  checkouts never persist the `GITHUB_TOKEN`.
- The release workflow uses no caches, so a poisoned cache entry can never end
  up in a signed binary.
- The app is compiled before any signing credential exists in the job. Signing,
  notarization, and the Azure login only happen afterwards, in
  `pnpm tauri bundle`, so build scripts of npm packages and crates never see
  them.
- Signing secrets and variables live in the `release` environment, which only
  accepts runs from `v*.*.*` tags and from `main` (for manual re-runs).
- CI runs [zizmor](https://docs.zizmor.sh) on every push and pull request to
  catch insecure workflow patterns.

## Optional signing

Signing is optional. Missing or incomplete configuration produces unsigned
installers without failing the build. Without Apple signing the macOS app is
signed ad-hoc, because Apple Silicon refuses to open downloaded apps with no
signature at all; users still have to allow it once under **System Settings →
Privacy & Security**.

Configure everything under **Settings → Environments → release**. Secrets stay
encrypted and masked; variables hold identifiers that are not sensitive.

### macOS

Requires an Apple Developer Program membership and a **Developer ID
Application** certificate.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `APPLE_CERTIFICATE` | base64-encoded PKCS#12 export of the certificate and its private key |
| Secret | `APPLE_CERTIFICATE_PASSWORD` | PKCS#12 password |
| Variable | `APPLE_SIGNING_IDENTITY` | for example `Developer ID Application: Name (TEAMID)` |
| Secret | `APPLE_API_PRIVATE_KEY` | contents of the App Store Connect API key (`AuthKey_XXXX.p8`) |
| Variable | `APPLE_API_KEY_ID` | key ID of that API key |
| Variable | `APPLE_API_ISSUER` | issuer ID shown above the API keys list |

Notarization uses an App Store Connect API key (Users and Access →
Integrations → Team Keys, role *Developer*) instead of an Apple ID: an
app-specific password would also unlock the account's iCloud data if it ever
leaked. The certificate is imported into a temporary keychain as
non-extractable and deleted at the end of the job.

Tauri signs the app but copies resources verbatim, and the official Node.js
binary requests `get-task-allow`, which notarization rejects. The
`beforeBundleCommand` (`pnpm desktop:sign-runtime`) therefore re-signs
`runtime/bin/node` first with the hardened runtime and the entitlements in
`src-tauri/node-runtime.entitlements`.

With the API key configured, Tauri signs, notarizes, and staples the `.app`;
the workflow then notarizes and staples the `.dmg` and checks both with
`codesign`, `spctl`, and `stapler`. With only the certificate, it signs without
notarizing.

### Windows

Windows signing uses [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/quickstart)
with OpenID Connect, so there is no Azure secret at all. Code signing keys must
live in an HSM, so exportable `.pfx` certificates are no longer issued.

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `AZURE_CLIENT_ID` | client ID of the Entra app registration |
| Variable | `AZURE_TENANT_ID` | Entra tenant ID |
| Variable | `ARTIFACT_SIGNING_ENDPOINT` | regional endpoint, for example `https://weu.codesigning.azure.net` |
| Variable | `ARTIFACT_SIGNING_ACCOUNT` | Artifact Signing account name |
| Variable | `ARTIFACT_SIGNING_PROFILE` | Public Trust certificate profile name |

The app registration needs the *Artifact Signing Certificate Profile Signer*
role on the account and a federated credential for GitHub Actions with:

- Organization `midudev`, repository `gojs`
- Entity type **Environment**, name `release`

The workflow logs in with `azure/login`, downloads the pinned
`Microsoft.ArtifactSigning.Client` dlib and verifies its checksum. The custom
Tauri signing command (`scripts/sign-windows.ps1`) then signs the application
executable, uninstaller, and final installers through `signtool`, timestamped by
Microsoft. A final step fails the build if any installer is not validly signed
and timestamped.

### Linux and provenance

Linux packages are not code signed. Every release asset, on every platform, gets
a GitHub build provenance attestation instead, so anyone can verify that a file
was built by this workflow from this repository:

```sh
gh attestation verify GoJS-Linux-x64.AppImage --repo midudev/gojs
```

## Future automatic updates

Do not enable Tauri's updater until its signing key exists. Enabling
`createUpdaterArtifacts` without a private key makes release builds fail.

To activate it later:

1. Generate a Tauri updater keypair and commit only the public key.
2. Add `tauri-plugin-updater` to Rust and the updater capability/configuration.
3. Set `bundle.createUpdaterArtifacts` to `true` and point the endpoint to:

   ```text
   https://github.com/midudev/gojs/releases/latest/download/latest.json
   ```

4. Add both secrets to the `release` environment:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
5. Pass them to the `Bundle, sign and notarize` step and verify that the draft
   contains `latest.json` plus the expected `.sig` files before publishing it.

## Local runtime targets

`pnpm node:fetch` defaults to the current machine. Cross-target selection is
available for release automation:

```sh
NODE_PLATFORM=darwin NODE_ARCH=arm64 pnpm node:fetch
```

`NODE_PLATFORM` accepts `darwin`, `linux` or `win32`.
`NODE_ARCH` accepts `arm64` or `x64`.

## Patched dependencies

`src-tauri/vendor/wry` is a copy of `wry` 0.57.0 (wired in through `[patch.crates-io]` in
`src-tauri/Cargo.toml`) with one change in `src/wkwebview/drag_drop.rs`: `collect_paths` no
longer `unwrap`s the drag pasteboard. Upstream panics there, which aborts the whole app when a
file is dragged over a GoJS window (for example while dragging the app from the installer into
Applications). Drop the patch once a `wry` release fixes it.
