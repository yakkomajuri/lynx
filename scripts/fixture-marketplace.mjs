// A read-only HTTP marketplace for app E2E checks. Templates live in their own checkout;
// the app still discovers and downloads them over HTTP, as it does in production.
import { createServer } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { templatesDir } from './templates-dir.mjs'

export async function fixtureMarketplace() {
  const items = readdirSync(templatesDir).filter((id) => existsSync(join(templatesDir, id, 'manifest.json'))).map((id) => {
    const manifest = JSON.parse(readFileSync(join(templatesDir, id, 'manifest.json'), 'utf8'))
    return { ...manifest, id, creator: 'official', verified: true, publisher: { name: 'Lynx', handle: 'lynx' }, version: 1,
      requires: manifest.requires ?? [], uses: manifest.uses ?? {}, tags: manifest.tags ?? [],
      ...(existsSync(join(templatesDir, id, 'preview/mock.js')) ? { preview: { path: manifest.preview?.path ?? '/' } } : {}),
    }
  })
  const filesOf = (id) => {
    const base = join(templatesDir, id)
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name.startsWith('.') || e.name === 'node_modules') return []
      const file = join(dir, e.name)
      if (e.isDirectory()) return walk(file)
      if (!e.isFile()) return []
      const path = relative(base, file).split('\\').join('/')
      const buf = readFileSync(file), text = buf.toString('utf8')
      return [{ path, ...(!buf.includes(0) && Buffer.from(text).equals(buf) ? { text } : { base64: buf.toString('base64') }) }]
    })
    return walk(base)
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (req.method === 'GET' && path === '/v1/templates') return send(200, { templates: items })
    const match = /^\/v1\/templates\/([a-z0-9-]+)\/(bundle|installs)$/.exec(path)
    const item = match && items.find((i) => i.id === match[1])
    if (item && req.method === 'GET' && match[2] === 'bundle') return send(200, { id: item.id, version: 1, files: filesOf(item.id) })
    if (item && req.method === 'POST' && match[2] === 'installs') return send(200, { installs: 1 })
    send(404, { error: 'Not available in the read-only E2E marketplace' })
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return { api: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } }
}
