// Fetches the icon of the site behind a connector, so cards show the service rather than a plug.
// The page is read for the icons it declares (they often live somewhere other than /favicon.ico),
// and the image comes back as a data URL: frames never contact the site themselves.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { join } from 'node:path'
import { iconLinks, lightSvg, rootDomain } from '@shared/siteIcon'

const TIMEOUT = 5000
// Some sites inline megabytes of CSS before their icon links.
const MAX_PAGE = 2 * 1024 * 1024
const MAX_ICON = 256 * 1024
/** A site without an icon is asked again after an hour. */
const MISS_MS = 3600e3

const cache = new Map<string, { at: number; icon: Promise<string | null> }>()

// Found icons are also kept on disk, one file per site, so a launch shows them without going out
// to every site again. `site` is a bare domain from rootDomain, so it's safe as a file name.
let dir: string | undefined
export function keepSiteIcons(path: string) {
  mkdirSync(path, { recursive: true })
  dir = path
}
const saved = (site: string) => {
  if (!dir) return null
  try {
    return readFileSync(join(dir, `${site}.txt`), 'utf8') || null
  } catch {
    return null
  }
}
const save = (site: string, icon: string) => {
  if (dir) writeFileSync(join(dir, `${site}.txt`), icon)
}

// Any workspace may ask for a site's icon, so these requests only ever go to the public internet:
// never to this machine or the local network, whatever a name resolves to or a page links or
// redirects to. The address is checked as the connection is made (the lookup below), so a name
// that answers differently a second time cannot slip past.
const BLOCKED = new BlockList()
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) BLOCKED.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(net, bits, 'ipv6')
// BlockList also holds IPv4 addresses against the IPv6 rules in their ::ffff: form, so mapped
// addresses are turned back into IPv4 here rather than given a rule of their own.
const isPublic = (ip: string): boolean => {
  const family = isIP(ip)
  if (family === 6) {
    const mapped = /^(?:0*:)*:?ffff:(.+)$/i.exec(ip)?.[1]
    if (mapped) {
      if (isIP(mapped) === 4) return isPublic(mapped)
      const [hi, lo] = mapped.split(':').map((h) => parseInt(h, 16))
      return hi !== undefined && lo !== undefined && isPublic(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
  }
  return family !== 0 && !BLOCKED.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}
const publicLookup: LookupFunction = (host, options, done) => {
  dnsLookup(host, { all: true }, (err, addresses) => {
    if (err) return done(err, '', 0)
    const ok = addresses.filter((a) => isPublic(a.address))
    if (!ok.length || ok.length !== addresses.length) return done(Object.assign(new Error(`${host} is not on the public internet`), { code: 'ENOTPUBLIC' }), '', 0)
    if ((options as { all?: boolean }).all) return (done as unknown as (e: null, a: LookupAddress[]) => void)(null, ok)
    done(null, ok[0]!.address, ok[0]!.family)
  })
}

type Got = { body: Uint8Array; type: string; url: string }
/** One GET over HTTPS to a public address: the status, headers and body up to `max` bytes. */
const get = (url: URL, max: number, partial: boolean) =>
  new Promise<{ status: number; location?: string; got: Got | null }>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) && !isPublic(host)) return reject(new Error('not a public address'))
    const req = httpsRequest(url, { method: 'GET', lookup: publicLookup, timeout: TIMEOUT, headers: { 'user-agent': 'Mozilla/5.0 Lynx' } }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) return res.resume(), resolve({ status, location: res.headers.location, got: null })
      if (status < 200 || status >= 300) return res.resume(), resolve({ status, got: null })
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        chunks.push(c)
        size += c.byteLength
        if (size > max) res.destroy()
      })
      const finish = () => {
        if (size > max && !partial) return resolve({ status, got: null })
        const body = Buffer.concat(chunks).subarray(0, max)
        resolve({ status, got: { body, type: String(res.headers['content-type'] ?? '').split(';')[0]!.trim(), url: url.href } })
      }
      let ended = false
      res.on('end', () => ((ended = true), finish()))
      // Closed early: fine when it was cut at `max` on purpose, a failure otherwise (the deadline, a drop).
      res.on('close', () => ended || (size > max ? finish() : reject(new Error('cut off'))))
      res.on('error', reject)
    })
    // `timeout` above only notices a connection gone quiet; this bounds the whole request, so a
    // server sending a byte now and then cannot hold it open.
    const deadline = setTimeout(() => req.destroy(new Error('timed out')), TIMEOUT)
    req.on('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', reject)
    req.end()
  })

/** A response's body up to `max` bytes, following up to three redirects, each checked again. A page may be cut there (its icons are in the head); an icon may not. */
async function fetchLimited(raw: string, max: number, partial = false): Promise<Got | null> {
  let url = new URL(raw)
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:') return null
    const r = await get(url, max, partial)
    if (!r.location) return r.got
    url = new URL(r.location, url)
  }
  return null
}

const asImage = (got: Awaited<ReturnType<typeof fetchLimited>>) => {
  if (!got || !got.body.byteLength) return null
  const type = got.type.startsWith('image/') ? got.type : /\.svg(\?|$)/i.test(got.url) ? 'image/svg+xml' : /\.ico(\?|$)/i.test(got.url) ? 'image/x-icon' : null
  if (!type) return null
  const body = type === 'image/svg+xml' ? Buffer.from(lightSvg(Buffer.from(got.body).toString('utf8')), 'utf8') : Buffer.from(got.body)
  return `data:${type};base64,${body.toString('base64')}`
}

// Servers whose own domain has no icon, mapped to the site that stands for them.
const STANDS_FOR: Record<string, string> = { 'githubcopilot.com': 'github.com' }

async function resolve(site: string): Promise<string | null> {
  site = STANDS_FOR[site] ?? site
  for (const origin of [`https://${site}`, `https://www.${site}`]) {
    const page = await fetchLimited(`${origin}/`, MAX_PAGE, true).catch(() => null)
    const declared = page && /html/.test(page.type) ? iconLinks(new TextDecoder().decode(page.body), page.url) : []
    for (const href of [...declared.slice(0, 3), `${origin}/favicon.ico`]) {
      const icon = asImage(await fetchLimited(href, MAX_ICON).catch(() => null))
      if (icon) return icon
    }
  }
  return null
}

/** The icon of the site a server address belongs to, as a data URL, or null. */
export async function siteIcon(url: string | undefined): Promise<string | null> {
  const site = rootDomain(url)
  if (!site) return null
  const hit = cache.get(site)
  if (hit) {
    const icon = await hit.icon
    if (icon || Date.now() - hit.at < MISS_MS) return icon
  }
  const kept = saved(site)
  const icon = kept
    ? Promise.resolve(kept)
    : resolve(site)
        .then((found) => (found && save(site, found), found))
        .catch(() => null)
  cache.set(site, { at: Date.now(), icon })
  return icon
}
