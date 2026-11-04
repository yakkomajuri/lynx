// Updates: whether a newer Lynx is out, and putting it in place of this copy.
//
// Where to look is configurable, first that is set wins:
//   1. LYNX_UPDATE_FEED and LYNX_UPDATE_DOWNLOAD in the environment
//   2. "feed" and "download" in <data>/updates.json
//   3. "updates": { "feed", "download" } in package.json (what an installer ships with)
// With no feed nothing is checked and the title bar never shows an update. In the feed's address,
// {platform} and {arch} are this machine's (darwin, arm64). Test runs (LYNX_E2E) only use the environment.
//
// The feed is a JSON document: { "version": "0.1.7", "notes": "markdown", "date": "2026-10-18",
// "url": "https://…/Lynx-0.1.7-arm64.dmg", "sha256": "…", "releases": [{ "version", "notes", "date" }] }.
// Only "version" is required. The feed is asked with ?since=<this version>, and "releases" can then
// list every version since this one, so someone skipping versions sees what changed in each. The file
// comes from "url" when the feed has one, else from the download address, where {version} and
// {arch} are filled in. A .dmg or a .zip holding Lynx.app.
//
// Installing: download, check the optional transport hash, extract the .app and require a valid
// Developer ID signature matching the installed publisher and bundle id, all
// while the app carries on. Then, when the user restarts, quit and let a small script swap the bundle
// once this process is gone and open the new one. An installed update not restarted into is removed on quit. That needs an
// installed Mac app in a folder this user may write; anywhere else the update is downloaded by hand.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { access, constants, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { UpdateState } from '@shared/types'
import { updateSignatures, type UpdateSignatures } from './updateSignatures'

const run = promisify(execFile)

export interface UpdateConfig {
  /** The address of the feed: JSON saying which version is the newest. */
  feed: string | null
  /** Where the file is when the feed does not say: {version} and {arch} are filled in. */
  download: string | null
}

/** One version's notes. */
export interface Change {
  version: string
  notes?: string
  date?: string
}

export interface Release extends Change {
  url?: string
  sha256?: string
  /** What came out since the version asking, newest first: this release and the ones it skips. */
  changes: Change[]
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function updateConfig(opts: { appRoot: string; dataDir: string; env?: NodeJS.ProcessEnv; platform?: string; arch?: string }): UpdateConfig {
  const env = opts.env ?? process.env
  const fill = (url: string | null) => url?.replaceAll('{platform}', opts.platform ?? process.platform).replaceAll('{arch}', opts.arch ?? process.arch) ?? null
  const json = (file: string) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) ?? {}
    } catch {
      return {}
    }
  }
  const test = !!env.LYNX_E2E
  const local = test ? {} : json(join(opts.dataDir, 'updates.json'))
  const shipped = test ? {} : (json(join(opts.appRoot, 'package.json')).updates ?? {})
  const pick = (key: 'feed' | 'download', name: string) => text(env[name]) ?? text(local[key]) ?? text(shipped[key])
  // {version} in the download address is the release's, filled in once there is one.
  return { feed: fill(pick('feed', 'LYNX_UPDATE_FEED')), download: pick('download', 'LYNX_UPDATE_DOWNLOAD') }
}

/** Only https, except on this machine (for trying a feed out). */
export const fetchable = (url: string) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}

// Check every hop before requesting it: fetch's automatic redirects can downgrade HTTPS to HTTP.
export async function fetchUpdate(url: string, init: RequestInit = {}): Promise<Response> {
  for (let redirects = 0; ; redirects++) {
    if (!fetchable(url)) throw new Error(`Updates download over https only, not from ${url}`)
    const res = await fetch(url, { ...init, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(res.status)) return res
    const location = res.headers.get('location')
    await res.body?.cancel()
    if (!location || redirects >= 20) throw new Error('The update URL has an invalid redirect or too many redirects')
    url = new URL(location, url).href
  }
}

/** Compares 1.2.3 and 1.2.3-beta.1 style versions: below zero when a is older. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, '').split(/-(.*)/s, 2)
    return { core: core!.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? '' }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d) return Math.sign(d)
  }
  // A prerelease comes before its release.
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}

export function parseRelease(body: unknown): Release {
  const o = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const version = text(o.version)
  if (!version || !/^v?\d+(\.\d+)*(-[\w.]+)?$/.test(version)) throw new Error('The update feed has no version')
  const sha256 = text(o.sha256)?.toLowerCase()
  if (o.sha256 !== undefined && (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))) throw new Error('The update feed has an invalid SHA-256 checksum')
  const release = { version: version.replace(/^v/i, ''), notes: text(o.notes) ?? undefined, date: text(o.date) ?? undefined }
  return { ...release, url: text(o.url) ?? undefined, sha256, changes: changesUpTo(release, o.releases) }
}

/** The feed's list of versions, newest first, none newer than `release`, and `release` always in it (with the feed's own notes for it). Bad entries are skipped. */
function changesUpTo(release: Change, list: unknown): Change[] {
  const out = new Map<string, Change>([[release.version, release]])
  for (const item of Array.isArray(list) ? list : []) {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const version = text(o.version)?.replace(/^v/i, '')
    if (!version || !/^\d+(\.\d+)*(-[\w.]+)?$/.test(version) || out.has(version) || compareVersions(version, release.version) > 0) continue
    out.set(version, { version, notes: text(o.notes) ?? undefined, date: text(o.date) ?? undefined })
  }
  return [...out.values()].sort((a, b) => compareVersions(b.version, a.version))
}

/** The feed's address, asking for every version since `current`. */
export function feedUrl(feed: string, current: string): string {
  const url = new URL(feed)
  url.searchParams.set('since', current)
  return url.href
}

/** Where the file is, or null when no URL is supplied. Invalid or insecure URLs throw. */
export function downloadUrl(release: Release, config: UpdateConfig, arch = process.arch): string | null {
  const url = release.url ?? config.download?.replaceAll('{version}', release.version).replaceAll('{arch}', arch) ?? null
  if (!url) return null
  // A relative "url" in the feed is next to the feed.
  let resolved: string
  try {
    resolved = new URL(url, config.feed ?? undefined).href
  } catch {
    throw new Error(`The update download URL is invalid: ${url}`)
  }
  if (!fetchable(resolved)) throw new Error(`Updates download over https only, not from ${resolved}`)
  return resolved
}

/** The .app this process runs from, when it is an installed Mac app. */
export function bundleOf(execPath: string): string | null {
  const bundle = dirname(dirname(dirname(execPath)))
  return bundle.endsWith('.app') && basename(dirname(execPath)) === 'MacOS' ? bundle : null
}

/** Whether this copy can replace itself: not from the disk image, not translocated, in a folder it may write. */
export async function canReplace(bundle: string | null): Promise<boolean> {
  if (!bundle || bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) return false
  return access(dirname(bundle), constants.W_OK).then(
    () => access(bundle, constants.W_OK).then(() => true),
    () => false,
  ).catch(() => false)
}

/** Reclaim abandoned downloads at startup; never follow symlinks or remove a live install. */
export async function sweepStaging(bundle: string, now = Date.now()) {
  const entries = await readdir(dirname(bundle), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\.lynx-update-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
    const work = join(dirname(bundle), entry.name)
    try {
      const info = await lstat(work)
      if (!info.isDirectory() || info.uid !== process.getuid?.() || now - info.mtimeMs < 24 * 60 * 60 * 1000) continue
      const owner = await readFile(join(work, 'owner.json'), 'utf8').catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null // Folders left by versions before ownership was recorded.
        throw e
      })
      if (owner) {
        const { pid, bundle: target } = JSON.parse(owner)
        if (target !== bundle || !Number.isInteger(pid) || pid <= 0) continue
        try {
          process.kill(pid, 0)
          continue
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      }
      await rm(work, { recursive: true, force: true })
    } catch {
      // Cleanup is best effort; a missing or inaccessible folder must not prevent updates.
    }
  }
}

/** Downloads to a file, reporting progress (0 to 1, when the size is known); checks the hash if one is given. */
export async function download(url: string, file: string, opts: { sha256?: string; onProgress?: (p: number | undefined) => void; signal?: AbortSignal } = {}) {
  const res = await fetchUpdate(url, { signal: opts.signal })
  if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status})`)
  // A sign-in page or an error page, not a build.
  if (/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
    await res.body.cancel().catch(() => undefined)
    throw new Error(`The download address answered with a web page, not the app: ${res.url || url}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let got = 0
  let last = 0
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk)
      got += chunk.length
      if (Date.now() - last > 100) {
        last = Date.now()
        opts.onProgress?.(total ? Math.min(1, got / total) : undefined)
      }
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body as any), count, createWriteStream(file))
  opts.onProgress?.(1)
  const sum = hash.digest('hex')
  if (opts.sha256 && sum !== opts.sha256) throw new Error('The download is not the file the update feed describes (its checksum differs)')
  return sum
}

/** Takes the .app out of a downloaded .dmg or .zip, into `into`. Returns its path. */
export async function extractApp(file: string, into: string): Promise<string> {
  const find = (dir: string) => readdirSync(dir).find((f) => f.endsWith('.app') && !f.startsWith('.'))
  if (/\.zip$/i.test(file)) {
    await run('ditto', ['-x', '-k', file, into])
  } else {
    const mount = await mkdtemp(join(tmpdir(), 'lynx-update-mnt-'))
    await run('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, file])
    try {
      const app = find(mount)
      if (!app) throw new Error('The disk image has no app in it')
      await run('ditto', [join(mount, app), join(into, app)])
    } finally {
      await run('hdiutil', ['detach', mount, '-force']).catch(() => undefined)
      await rm(mount, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  const app = find(into)
  if (!app) throw new Error('The download has no app in it')
  return join(into, app)
}

const plist = (bundle: string, key: string) => run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')]).then((r) => r.stdout.trim())

/** The new app must be this app (same bundle id), at the version the feed promised or later. */
export async function checkApp(next: string, current: string, version: string, signatures: UpdateSignatures = updateSignatures()) {
  const [id, ours, v, executable] = await Promise.all([plist(next, 'CFBundleIdentifier'), plist(current, 'CFBundleIdentifier'), plist(next, 'CFBundleShortVersionString'), plist(next, 'CFBundleExecutable')])
  if (id !== ours) throw new Error(`The download is a different app (${id}), not this one (${ours})`)
  if (!/^\d+(\.\d+)*(-[\w.]+)?$/.test(v) || compareVersions(v, version) < 0) throw new Error(`The download is version ${v}, not ${version}`)
  if (!executable || basename(executable) !== executable || executable === '.' || executable === '..') throw new Error('The download has no valid app executable')
  await access(join(next, 'Contents', 'MacOS', executable), constants.X_OK)
  await signatures.verify(next, await signatures.requirement(current))
}

// Waits for the app to be gone (a few minutes at most: if it is still running, nothing is touched),
// moves the old bundle aside, the new one in, and opens it. If the new one cannot go in, the old one goes back.
const SWAP = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; work="$4"
# Launch Services is told about the swap. Otherwise its record of the target stays the old bundle's for a
# while, and opening Lynx by its id (the Dock, Spotlight) can land on another copy: a disk image, a build.
lsr="\${LYNX_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n+1)); [ "$n" -gt 1500 ] && { rm -rf "$work"; exit 1; }
  sleep 0.2
done
old="$target.old-$$"
if ! mv "$target" "$old"; then
  open "$target"
  rm -rf "$work"
  exit 1
fi
if ! mv "$staged" "$target"; then
  mv "$old" "$target" && open "$target"
  rm -rf "$work"
  exit 1
fi
"$lsr" -f "$target" >/dev/null 2>&1
if open "$target"; then
  "$lsr" -u "$old" >/dev/null 2>&1
  rm -rf "$old"
else
  # Keep the old bundle until Launch Services accepts the new one. Preserve both if recovery fails.
  mv "$target" "$staged" && mv "$old" "$target" && open "$target" || exit 1
fi
rm -rf "$work"
`

/** Starts the script that puts `staged` in place of `target` once process `pid` has exited. */
export async function scheduleSwap(opts: { pid: number; target: string; staged: string; work: string }) {
  const script = join(opts.work, 'swap.sh')
  writeFileSync(script, SWAP, { mode: 0o755 })
  const child = spawn('/bin/sh', [script, String(opts.pid), opts.target, opts.staged, opts.work], { detached: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export interface Updater {
  state: () => UpdateState
  /** Asks the feed now. */
  check: () => Promise<UpdateState>
  /** Downloads the newest version and gets it ready, while the app carries on. */
  install: () => Promise<UpdateState>
  /** Once it is ready: quits, and the new version takes this one's place and opens. */
  restart: () => Promise<UpdateState>
  /** Where the newest version can be downloaded by hand. */
  downloadUrl: () => string | null
  dispose: () => void
}

/** Checks the feed a little after launch and every few hours, and installs on request. */
export function makeUpdater(opts: { current: string; config: UpdateConfig; execPath: string; packaged: boolean; onChange: () => void; quit: () => void; every?: number; /** For tests: what starts the swap. */ swap?: typeof scheduleSwap; /** Signature commands, replaceable in lifecycle tests. */ signatures?: UpdateSignatures }): Updater {
  const { config } = opts
  const signatures = opts.signatures ?? updateSignatures()
  const bundle = opts.packaged ? bundleOf(opts.execPath) : null
  let canInstall = false
  const ready = canReplace(bundle).then(async (ok) => {
    if (ok && bundle) await sweepStaging(bundle)
    canInstall = !!(ok && bundle && await signatures.requirement(bundle).then(() => true, () => false))
    opts.onChange()
  })
  let release: Release | null = null
  let s: Omit<UpdateState, 'current' | 'configured' | 'canInstall' | 'latest'> = { status: 'idle' }
  const set = (next: typeof s) => {
    s = next
    opts.onChange()
  }
  const state = (): UpdateState => ({ ...s, current: opts.current, configured: !!config.feed, canInstall, latest: release ? { version: release.version, notes: release.notes, date: release.date, changes: release.changes.filter((c) => compareVersions(c.version, opts.current) > 0) } : undefined })
  const busy = () => s.status === 'downloading' || s.status === 'installing' || s.status === 'ready'
  /** The new app, checked and waiting beside this one for a restart. */
  let staged: { app: string; work: string; version: string } | null = null
  let restarting = false

  let checking: Promise<UpdateState> | null = null
  const check = () =>
    (checking ??= (async () => {
      if (!config.feed || busy()) return state()
      if (!fetchable(config.feed)) {
        set({ status: 'error', error: `The update feed must be https: ${config.feed}` })
        return state()
      }
      set({ status: 'checking' })
      try {
        const res = await fetchUpdate(feedUrl(config.feed, opts.current), { headers: { accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) })
        if (!res.ok) throw new Error(`The update feed answered HTTP ${res.status}`)
        const next = parseRelease(await res.json())
        const had = release?.version
        release = compareVersions(next.version, opts.current) > 0 ? next : null
        if (release && release.version !== had) console.error(`[update] Lynx ${release.version} is available (this is ${opts.current})`)
        set({ status: release ? 'available' : 'idle', checkedAt: new Date().toISOString() })
      } catch (e) {
        // A failed check keeps whatever was found before.
        set({ status: release ? 'available' : 'idle', error: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() })
      }
      return state()
    })().finally(() => (checking = null)))

  let installing: Promise<UpdateState> | null = null
  const install = () => (installing ??= Promise.resolve().then(async () => {
    if (busy()) return state()
    await ready
    // A refresh must finish before choosing the release, so it cannot overwrite install progress.
    if (checking) await checking
    if (!release) await check()
    const r = release
    if (!r) return state()
    let work: string | undefined
    try {
      const url = downloadUrl(r, config)
      if (!url) throw new Error('The update feed does not say where to download it')
      if (!canInstall || !bundle) throw new Error('This copy of Lynx cannot replace itself. Download the new version and install it over this one.')
      set({ status: 'downloading', progress: 0 })
      console.error(`[update] downloading ${url}`)
      // Stage on the target filesystem so the final bundle moves are atomic renames, even when
      // the app lives on a different volume from the system temporary directory.
      work = await mkdtemp(join(dirname(bundle), '.lynx-update-'))
      writeFileSync(join(work, 'owner.json'), JSON.stringify({ pid: process.pid, bundle }))
      const name = basename(new URL(url).pathname) || 'Lynx.dmg'
      const file = join(work, /\.(dmg|zip)$/i.test(name) ? name : `${name}.dmg`)
      await download(url, file, { sha256: r.sha256, onProgress: (progress) => s.status === 'downloading' && set({ status: 'downloading', progress }) })
      set({ status: 'installing' })
      const stagedApp = await extractApp(file, await mkdtemp(join(work, 'app-')))
      await checkApp(stagedApp, bundle, r.version, signatures)
      await rm(file, { force: true })
      staged = { app: stagedApp, work, version: r.version }
      console.error(`[update] Lynx ${r.version} is installed beside this one; it takes over on restart`)
      set({ status: 'ready' })
    } catch (e) {
      if (work) await rm(work, { recursive: true, force: true }).catch(() => undefined)
      console.error(`[update] installing failed: ${e instanceof Error ? e.message : e}`)
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return state()
  }).finally(() => (installing = null)))

  const restart = async () => {
    if (!staged || !bundle || restarting) return state()
    try {
      // Recheck staged bytes before handing them to the swap, including a fresh signature check.
      await checkApp(staged.app, bundle, staged.version, signatures)
      await (opts.swap ?? scheduleSwap)({ pid: process.pid, target: bundle, staged: staged.app, work: staged.work })
      restarting = true
      console.error(`[update] restarting into ${staged.app}`)
      opts.quit()
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    }
    return state()
  }

  const first = setTimeout(() => void check(), 5000)
  const timer = setInterval(() => void check(), opts.every ?? 4 * 60 * 60 * 1000)
  return {
    state,
    check,
    install,
    restart,
    downloadUrl: () => (release ? downloadUrl(release, config) : null),
    dispose: () => {
      clearTimeout(first)
      clearInterval(timer)
      // Quitting without restarting into it: the installed update goes, in the background (it is the size of the app).
      if (staged && !restarting) spawn('/bin/rm', ['-rf', staged.work], { detached: true, stdio: 'ignore' }).unref()
    },
  }
}
