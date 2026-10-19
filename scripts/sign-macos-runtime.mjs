#!/usr/bin/env node
// Re-signs the bundled Node.js binary with our Developer ID right before Tauri
// bundles the app (`build.beforeBundleCommand`).
//
// Tauri signs frameworks, sidecars and the main executable, but copies
// resources verbatim. `runtime/bin/node` would keep the Node.js Foundation
// signature, whose `get-task-allow` entitlement makes Apple reject the
// notarization of the whole app. Signing it here, inside out, keeps the nested
// signature valid when Tauri seals the bundle afterwards.
//
// Usage:
//   APPLE_SIGNING_IDENTITY="Developer ID Application: …" node scripts/sign-macos-runtime.mjs
//
// Without a Developer ID (no APPLE_SIGNING_IDENTITY, or the ad-hoc `-`), or
// outside macOS, it does nothing: an ad-hoc build is never notarized, and the
// official Node.js Foundation signature beats an ad-hoc one.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE_BINARY = join(ROOT, 'src-tauri', 'runtime', 'bin', 'node')
const ENTITLEMENTS = join(ROOT, 'src-tauri', 'node-runtime.entitlements')
const FORBIDDEN_ENTITLEMENT = 'com.apple.security.get-task-allow'

function main() {
  const identity = process.env.APPLE_SIGNING_IDENTITY

  if (process.platform !== 'darwin' || !identity || identity === '-') {
    console.log('No Developer ID configured; keeping the official Node.js runtime signature.')
    return
  }
  if (!existsSync(NODE_BINARY)) {
    throw new Error('No bundled Node.js runtime found. Run `pnpm node:fetch` first.')
  }

  execFileSync(
    'codesign',
    ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', '--entitlements', ENTITLEMENTS, NODE_BINARY],
    { stdio: 'inherit' },
  )
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', NODE_BINARY], { stdio: 'inherit' })

  const entitlements = execFileSync('codesign', ['--display', '--entitlements', '-', '--xml', NODE_BINARY], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (entitlements.includes(FORBIDDEN_ENTITLEMENT)) {
    throw new Error(`The bundled Node.js binary still requests ${FORBIDDEN_ENTITLEMENT}.`)
  }

  console.log('✓ Signed the bundled Node.js runtime for notarization')
}

try {
  main()
} catch (err) {
  console.error(`✗ sign-macos-runtime: ${err.message}`)
  process.exit(1)
}
