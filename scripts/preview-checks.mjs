// Runs the interaction checks marketplace items ship in preview/checks.mjs, against their preview
// data in headless Chromium, without starting the app. A check is { name, path, run(page), clock? }:
// the page opens at `path` (with `clock`, on Playwright's fake clock, so `run` can move time on with
// page.clock), `run` drives it with Playwright and throws when something is wrong, and the
// check also fails if the page logged an error or shows an error note or the crash screen.
//
//   node scripts/preview-checks.mjs [item …]      (every item that has checks, when none are named)
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { bundlePreview, launchBrowser, watch } from './preview-bundle.mjs'
import { templatesDir } from './templates-dir.mjs'

const root = resolve('.')
const named = process.argv.slice(2)
const ids = (named.length ? named : readdirSync(templatesDir)).filter((id) => existsSync(join(templatesDir, id, 'preview', 'checks.mjs')))
const browser = await launchBrowser()
let failed = 0
for (const id of ids) {
  console.log(id)
  const { url } = await bundlePreview(root, id, join(tmpdir(), 'lynx-preview-checks', id))
  const { default: checks } = await import(pathToFileURL(join(templatesDir, id, 'preview', 'checks.mjs')).href)
  for (const check of checks) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const seen = watch(page)
    let problems
    try {
      if (check.clock) await page.clock.install()
      await page.goto(`${url}#${check.path}`)
      await (check.clock ? page.clock.runFor(800) : page.waitForTimeout(800))
      await check.run(page)
      await (check.clock ? page.clock.runFor(300) : page.waitForTimeout(300))
      problems = await seen.problems()
    } catch (e) {
      problems = [e.message.split('\n')[0], ...(await seen.problems().catch(() => []))]
    }
    console.log(`${problems.length ? '  FAIL' : '  ok  '} ${check.name}${problems.length ? `  -> ${problems.join(' | ')}` : ''}`)
    if (problems.length) failed++
    await page.close()
  }
}
await browser.close()
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
