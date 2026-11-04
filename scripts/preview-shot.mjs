// Screenshots of a marketplace item running on its preview/mock.js, in headless Chromium, without
// starting the app. Bundled the way the marketplace bundles a preview (see preview-bundle.mjs).
//
//   node scripts/preview-shot.mjs <item> [path,path,…] [--dark] [--out dir] [--size 1280x800]
//
// Prints each screenshot's file, and any error the page logged, so a broken page fails loudly.
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { bundlePreview, launchBrowser, watch } from './preview-bundle.mjs'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const dark = args.includes('--dark') && (args.splice(args.indexOf('--dark'), 1), true)
const out = resolve(flag('--out') ?? join(tmpdir(), 'lynx-preview-shots'))
const [width, height] = (flag('--size') ?? '1280x800').split('x').map(Number)
const [id, pathArg] = args
if (!id) {
  console.error('usage: node scripts/preview-shot.mjs <item> [path,path,…] [--dark] [--out dir] [--size WxH]')
  process.exit(2)
}

const { manifest, url } = await bundlePreview(resolve('.'), id, join(out, `.site-${id}`))
const paths = pathArg ? pathArg.split(',') : [manifest.preview?.path ?? '/']

const browser = await launchBrowser()
const page = await browser.newPage({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: 2 })
const seen = watch(page)
let failed = false
for (const p of paths) {
  seen.errors.length = 0
  await page.goto(`${url}#${p}`)
  await page.waitForTimeout(1200)
  const file = join(out, `${id}${p === '/' ? '' : p.replace(/[^a-z0-9]+/gi, '-').replace(/-$/, '')}${dark ? '-dark' : ''}.png`)
  await page.screenshot({ path: file })
  console.log(file)
  const problems = await seen.problems()
  for (const e of problems) console.log(`  ${e}`)
  if (problems.length) failed = true
}
await browser.close()
process.exit(failed ? 1 : 0)
