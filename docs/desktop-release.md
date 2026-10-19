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
it verifies that all three source versions match the tag.

## Build outputs

The workflow builds four independent targets:

- macOS Apple Silicon (`aarch64-apple-darwin`)
- macOS Intel (`x86_64-apple-darwin`)
- Windows x64 (`x86_64-pc-windows-msvc`)
- Linux x64 (`x86_64-unknown-linux-gnu`)

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

## Optional signing

Signing is optional. Missing or incomplete secrets produce unsigned installers
without failing the build. Without Apple secrets the macOS app is signed ad-hoc,
because Apple Silicon refuses to open downloaded apps with no signature at all;
users still have to allow it once under **System Settings → Privacy & Security**.

### macOS

Requires an Apple Developer Program membership and a **Developer ID
Application** certificate. Configure all of:

- `APPLE_CERTIFICATE`: base64-encoded PKCS#12 export of the certificate and
  its private key
- `APPLE_CERTIFICATE_PASSWORD`: PKCS#12 password
- `APPLE_SIGNING_IDENTITY`: codesigning identity, for example
  `Developer ID Application: Name (TEAMID)`
- `APPLE_ID`: Apple Developer account email
- `APPLE_PASSWORD`: app-specific password for that Apple ID
- `APPLE_TEAM_ID`: Apple Developer team identifier

Tauri signs the app but copies resources verbatim, and the official Node.js
binary requests `get-task-allow`, which notarization rejects. The
`beforeBundleCommand` (`pnpm desktop:sign-runtime`) therefore re-signs
`runtime/bin/node` first with the hardened runtime and the entitlements in
`src-tauri/node-runtime.entitlements`.

When all six secrets are present, Tauri signs, notarizes, and staples the
`.app`; the workflow then notarizes and staples the `.dmg` and checks both with
`codesign`, `spctl`, and `stapler`. If only the certificate secrets are present,
it signs without notarizing.

### Windows

Windows signing uses [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/quickstart).
Code signing keys must live in an HSM, so exportable `.pfx` certificates are no
longer issued. Configure all of:

- `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`: an Entra app
  registration with the *Artifact Signing Certificate Profile Signer* role
- `ARTIFACT_SIGNING_ENDPOINT`: regional endpoint of the account, for example
  `https://weu.codesigning.azure.net`
- `ARTIFACT_SIGNING_ACCOUNT`: Artifact Signing account name
- `ARTIFACT_SIGNING_PROFILE`: Public Trust certificate profile name

The workflow downloads the pinned `Microsoft.ArtifactSigning.Client` dlib and
verifies its checksum. The custom Tauri signing command
(`scripts/sign-windows.ps1`) then signs the application executable, uninstaller,
and final installers through `signtool`, timestamped by Microsoft. A final step
fails the build if any installer is not validly signed and timestamped.

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

4. Configure both GitHub secrets:
   - `TAURI_SIGNING_PRIVATE_KEY`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
5. Add those secrets to the release build environment and verify that the draft
   contains `latest.json` plus the expected `.sig` files before publishing it.

## Local runtime targets

`pnpm node:fetch` defaults to the current machine. Cross-target selection is
available for release automation:

```sh
NODE_PLATFORM=darwin NODE_ARCH=arm64 pnpm node:fetch
```

`NODE_PLATFORM` accepts `darwin`, `linux` or `win32`.
`NODE_ARCH` accepts `arm64` or `x64`.
