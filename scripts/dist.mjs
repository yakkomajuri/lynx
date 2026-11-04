// Builds the Lynx installer for macOS (Apple silicon): dist/Lynx-<version>-arm64.dmg.
//   npm run dist              local smoke-test build; no marketplace network check
//   npm run dist -- --release release build; requires a ready shipped marketplace
// Agents run on agentd, inside the app, on Electron's own Node. They are the user's own: agentd runs
// the `claude` and `codex` installed on their machine.
//
// Signing: with no Developer ID the app is signed ad hoc and macOS warns on first open. To sign and
// notarize, set CSC_NAME (the "Developer ID Application: …" identity in your keychain) plus
// APPLE_KEYCHAIN_PROFILE (a notarytool credential profile), or APPLE_ID,
// APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID. Signed builds always run the release gate.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Arch, build, Platform } from 'electron-builder'

if (process.platform !== 'darwin') throw new Error('dist builds the macOS installer and must run on a Mac')
const root = resolve(import.meta.dirname, '..')
const stage = join(root, 'build')
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
const step = (s) => console.log(`\n▸ ${s}`)
const signed = !!process.env.CSC_NAME
const args = process.argv.slice(2)
if (args.some((arg) => arg !== '--release')) throw new Error('Usage: npm run dist [-- --release]')

if (signed || args.includes('--release')) {
  step('Checking the shipped marketplace')
  sh(process.execPath, ['scripts/check-marketplace.mjs'])
} else {
  step('Local smoke-test build (use --release to check marketplace readiness)')
}

step('Building the app')
sh('npm', ['run', 'build'])

step('Rendering the icon')
mkdirSync(stage, { recursive: true })
const icns = join(stage, 'icon.icns')
if (!existsSync(icns) || statSync(icns).mtimeMs < statSync(join(root, 'resources/icon.svg')).mtimeMs) {
  const iconset = join(mkdtempSync(join(tmpdir(), 'lynx-icon-')), 'icon.iconset')
  sh(join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [join(root, 'scripts/make-icon.mjs'), iconset])
  sh('iconutil', ['-c', 'icns', iconset, '-o', icns])
}

step('Packaging')
const notarize = signed && !!(process.env.APPLE_KEYCHAIN_PROFILE || (process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID))
writeFileSync(
  join(stage, 'entitlements.mac.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`,
)
await build({
  targets: Platform.MAC.createTarget(['dmg'], Arch.arm64),
  config: {
    appId: 'dev.lynx.app',
    productName: 'Lynx',
    directories: { output: 'dist', buildResources: 'build' },
    // Workspaces are compiled at runtime by esbuild, which reads the kit and node_modules from disk.
    asar: false,
    // The Agent SDK ships its own Claude Code per platform (~230 MB); Lynx runs the user's install instead.
    files: ['out/**', 'src/kit/**', 'resources/*.md', 'resources/home/**', 'resources/onboarding/**', 'LICENSE', 'package.json', '!**/node_modules/**/*.{map,d.ts,d.mts,d.cts,md}', '!node_modules/@anthropic-ai/claude-agent-sdk-*/**'],
    mac: {
      icon: 'build/icon.icns',
      category: 'public.app-category.developer-tools',
      identity: signed ? process.env.CSC_NAME : '-',
      hardenedRuntime: signed,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      // Voice mode: macOS shows this when Lynx first asks for the microphone.
      extendInfo: { NSMicrophoneUsageDescription: 'Lynx listens while voice mode is on, to turn what you say to the agent into text on this computer.' },
      notarize,
    },
    // LZFSE: noticeably smaller than the default zlib, and opens on any supported macOS.
    dmg: { artifactName: '${productName}-${version}-${arch}.${ext}', format: 'ULFO', sign: signed },
  },
})
console.log(`\n✓ dist/Lynx-${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}-arm64.dmg${signed ? '' : ' (ad-hoc signed: macOS will ask users to confirm on first open)'}`)
