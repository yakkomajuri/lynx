// Release gate: check the shipped address, not a developer's environment or data-file override.
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function checkMarketplace(api, fetchImpl = fetch) {
  let url
  try { url = new URL(api) } catch { throw new Error('Set package.json marketplace.api to the deployed HTTPS marketplace before packaging') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('The shipped marketplace must use a public HTTPS endpoint without credentials, query or fragment')
  }
  const get = async (path) => {
    const res = await fetchImpl(`${url.href.replace(/\/+$/, '')}${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
    // Proxies and undeployed routes can return HTML or no body at all. Keep their HTTP status.
    if (!res.ok) throw new Error(`Marketplace is not ready (${res.status})`)
    try {
      return await res.json()
    } catch {
      throw new Error(`Marketplace returned invalid JSON (${res.status}) for ${path}`)
    }
  }
  const health = await get('/v1/health')
  if (health.ready !== true) throw new Error('Marketplace is not ready')
  const list = await get('/v1/templates?creator=official&limit=1')
  const template = list.templates?.find((t) => t.creator === 'official' && t.verified && t.uses && typeof t.uses === 'object' && !Array.isArray(t.uses))
  if (!template) throw new Error('Seed the official marketplace templates before packaging')
  const bundle = await get(`/v1/templates/${encodeURIComponent(template.id)}/bundle?version=${template.version}`)
  if (bundle.id !== template.id || bundle.version !== template.version || !bundle.files?.some((f) => /^App\.(jsx|tsx|js)$/.test(f.path))) {
    throw new Error('The marketplace cannot retrieve the listed template version')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  await checkMarketplace(pkg.marketplace?.api)
  console.log('Shipped marketplace: storage, sign-in configuration, official listing and bundle checks passed')
}
