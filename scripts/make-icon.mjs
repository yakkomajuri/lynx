// Renders an SVG (resources/icon.svg unless given) into the PNG sizes iconutil wants. Run by make-app.mjs under Electron:
//   electron scripts/make-icon.mjs <iconset dir> [svg]
import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [out, svgPath] = process.argv.slice(process.argv.findIndex((a) => a.endsWith('make-icon.mjs')) + 1)
app.dock?.hide()
// Not a top-level await: Electron holds `ready` back until this module has finished loading.
void app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const svg = readFileSync(svgPath ?? join(import.meta.dirname, '../resources/icon.svg'), 'utf8')
  await win.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:transparent;overflow:hidden">${svg}</body>`)}`)
  await new Promise((r) => setTimeout(r, 300))
  const full = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' })
  mkdirSync(out, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    writeFileSync(join(out, `icon_${size}x${size}.png`), full.resize({ width: size, height: size, quality: 'best' }).toPNG())
    writeFileSync(join(out, `icon_${size}x${size}@2x.png`), full.resize({ width: size * 2, height: size * 2, quality: 'best' }).toPNG())
  }
  app.exit(0)
})
