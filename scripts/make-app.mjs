// Makes "Lynx Dev.app" (macOS): Electron with our name, a green DEV-badged icon and a one-file stub that
// runs this checkout, so you can keep the development build in the Dock next to the real Lynx:
//   npm run app                 # write ~/Desktop/Lynx Dev.app
//   npm run app -- /Applications
// It rebuilds on launch when the code has changed since the last build (a second or two), so there
// is no `npm run build` step. It uses the same data as Lynx; don't run both at once. Run this again
// only when Electron is upgraded, the icon changes or the checkout moves.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin') throw new Error('make-app only builds a macOS app')
const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = `${pkg.productName} Dev`
const dest = join(resolve(process.argv[2] ?? join(homedir(), 'Desktop')), `${name}.app`)
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
const electronApp = join(root, 'node_modules/electron/dist/Electron.app')

sh('npm', ['run', 'build'])

// The real icon on a green plate with a DEV badge, so the two apps are easy to tell apart in the Dock.
const svg = join(root, 'resources/icon.svg')
const icns = join(root, 'node_modules/.cache/lynx-dev-icon.icns')
mkdirSync(join(root, 'node_modules/.cache'), { recursive: true })
if (!existsSync(icns) || statSync(icns).mtimeMs < Math.max(statSync(svg).mtimeMs, statSync(import.meta.filename).mtimeMs)) {
  const tmp = mkdtempSync(join(tmpdir(), 'lynx-icon-'))
  const badge = `<rect x="560" y="752" width="336" height="150" rx="42" fill="#151517"/><text x="728" y="860" text-anchor="middle" font-family="-apple-system, Helvetica, sans-serif" font-size="104" font-weight="800" fill="#f3f1ea">DEV</text>`
  const green = readFileSync(svg, 'utf8').replace('stop-color="#2b2b2f"', 'stop-color="#1fb877"').replace('stop-color="#151517"', 'stop-color="#0c7a4c"')
  writeFileSync(join(tmp, 'icon.svg'), green.replace('</svg>', `  ${badge}\n</svg>`))
  sh(join(electronApp, 'Contents/MacOS/Electron'), [join(root, 'scripts/make-icon.mjs'), join(tmp, 'icon.iconset'), join(tmp, 'icon.svg')])
  sh('iconutil', ['-c', 'icns', join(tmp, 'icon.iconset'), '-o', icns])
}

rmSync(dest, { recursive: true, force: true })
cpSync(electronApp, dest, { recursive: true, verbatimSymlinks: true })
const res = join(dest, 'Contents/Resources')
rmSync(join(res, 'default_app.asar'))
rmSync(join(res, 'electron.icns'))
cpSync(icns, join(res, 'icon.icns'))

// Its own bundle id: macOS treats it as a separate app from the installed Lynx (Dock, permissions).
const plist = join(dest, 'Contents/Info.plist')
for (const [key, value] of Object.entries({ CFBundleName: name, CFBundleDisplayName: name, CFBundleIdentifier: 'dev.lynx.app.dev', CFBundleIconFile: 'icon.icns', CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version }))
  sh('plutil', ['-replace', key, '-string', value, plist])
// Only covers default_app.asar, which is gone.
sh('plutil', ['-remove', 'ElectronAsarIntegrity', plist])

mkdirSync(join(res, 'app'))
writeFileSync(join(res, 'app/package.json'), JSON.stringify({ name: `${pkg.name}-dev`, productName: name, version: pkg.version, type: 'module', main: 'main.mjs' }, null, 2))
writeFileSync(
  join(res, 'app/main.mjs'),
  `// Written by scripts/make-app.mjs. Rebuilds the checkout below if its code changed, then runs it.
import { app, dialog } from 'electron'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = ${JSON.stringify(root)}
const entry = join(root, 'out/main/index.js')
const built = () => (existsSync(entry) ? statSync(entry).mtimeMs : 0)
const newest = () =>
  Math.max(
    ...['package.json', 'electron.vite.config.ts'].map((f) => statSync(join(root, f)).mtimeMs),
    ...readdirSync(join(root, 'src'), { recursive: true }).map((f) => statSync(join(root, 'src', f)).mtimeMs),
  )

if (newest() > built()) {
  // electron-vite runs on this app's own binary in Node mode, so the Dock's bare PATH doesn't matter.
  const r = spawnSync(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
  if (r.status !== 0) {
    dialog.showErrorBox('Lynx Dev did not build', (r.stderr || r.stdout || String(r.error)).trim().split('\\n').slice(-20).join('\\n'))
    app.exit(1)
  }
}
if (!existsSync(entry)) {
  dialog.showErrorBox('Lynx Dev is not built', 'Nothing at ' + entry + '. Run \`npm run app\` again if the checkout moved.')
  app.exit(1)
} else {
  process.env.LYNX_ROOT ??= root
  // Same data as Lynx: the folder is named after the app, and this one is called Lynx Dev.
  if (!process.env.LYNX_DATA) app.setPath('userData', join(app.getPath('appData'), ${JSON.stringify(pkg.productName)}))
  await import(pathToFileURL(entry).href)
}
`,
)

// Editing the bundle breaks Electron's signature, and arm64 will not start an unsigned app.
sh('codesign', ['--force', '--deep', '--sign', '-', dest], { stdio: ['ignore', 'ignore', 'inherit'] })
console.log(`\n${dest}\nruns ${root}, rebuilding on launch when the code changed`)
