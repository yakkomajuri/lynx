// A marketplace item bundled with its preview/mock.js the way the marketplace bundles a preview
// (src/main/services/Marketplace.ts), written out as a page that opens from disk, and the headless
// browser the preview scripts look at it with. Used by preview-shot.mjs and preview-checks.mjs.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as esbuild from 'esbuild'
import { chromium } from 'playwright'
import { templatesDir } from './templates-dir.mjs'

/** Bundles an item from LYNX_TEMPLATES_DIR into `site`; returns its manifest and the page's file URL (add `#/path`). */
export async function bundlePreview(root, id, site) {
  const dir = join(templatesDir, id)
  const kitDir = join(root, 'src', 'kit')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const meta = JSON.stringify({ id, name: manifest.name, requires: manifest.requires ?? [] })
  const boot = {
    name: 'preview-boot',
    setup(b) {
      b.onResolve({ filter: /^sb-preview-boot$/ }, () => ({ path: 'boot', namespace: 'sb-preview' }))
      b.onLoad({ filter: /.*/, namespace: 'sb-preview' }, () => ({ contents: `import { installPreview } from ${JSON.stringify(join(kitDir, 'preview.ts'))}\nimport mock from './preview/mock.js'\ninstallPreview(mock, ${meta})\n`, resolveDir: dir, loader: 'js' }))
    },
  }
  mkdirSync(site, { recursive: true })
  const result = await esbuild.build({
    stdin: { contents: `import 'sb-preview-boot'\nimport App from './App'\nimport { mount } from 'lynx'\nmount(App)\n`, resolveDir: dir, loader: 'jsx', sourcefile: 'preview-entry.jsx' },
    bundle: true,
    write: false,
    outdir: site,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    jsx: 'automatic',
    alias: { lynx: join(kitDir, 'index.tsx') },
    nodePaths: [join(root, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.js': 'jsx', '.png': 'dataurl', '.jpg': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.md': 'text', '.txt': 'text' },
    logLevel: 'error',
    plugins: [boot],
  })
  const text = (ext) => result.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? ''
  writeFileSync(join(site, 'bundle.js'), text('.js'))
  writeFileSync(join(site, 'bundle.css'), text('.css'))
  writeFileSync(join(site, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><link rel="stylesheet" href="bundle.css"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>`)
  return { manifest, url: `file://${join(site, 'index.html')}` }
}

/** Playwright's own browser when it is installed, else the Chrome on this machine. */
export const launchBrowser = () => chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, channel: 'chrome' }))

/** Collects what a page logs as errors; `problems()` adds the kit's error notes and crash screen on display. */
export function watch(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => msg.type() === 'error' && errors.push(`console: ${msg.text()}`))
  return {
    errors,
    problems: async () => {
      const shown = await page.evaluate(() => [...document.querySelectorAll('.sb-error, .sb-crash')].map((e) => e.textContent?.trim()).filter(Boolean))
      return [...errors, ...shown.map((s) => `on screen: ${s}`)]
    },
  }
}
