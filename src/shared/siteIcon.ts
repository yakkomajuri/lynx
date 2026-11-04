// A connector's face: the icon of the site its server belongs to (mcp.linear.app → linear.app).

const SECOND_LEVELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'nic', 'ltd', 'plc', 'sch', 'nom', 'mil'])

/**
 * The site a server address belongs to: the last two labels, or three under a country's second
 * level (example.co.uk). Null for local and built-in connectors.
 */
export const rootDomain = (url?: string): string | null => {
  let host: string
  try {
    host = new URL(url ?? '').hostname
  } catch {
    return null
  }
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host === 'localhost') return null
  const labels = host.split('.')
  // example.co.uk and example.com.br, but exa.ai and mcp.io are sites of their own.
  const second = labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVELS.has(labels.at(-2)!)
  return labels.slice(second ? -3 : -2).join('.')
}

/**
 * The icons a page declares, best first: SVG, then the largest PNG or ICO up to 256px, then the
 * apple-touch icon, all resolved against the page's address.
 */
export function iconLinks(html: string, base: string): string[] {
  const found: { href: string; score: number }[] = []
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined)
    const rel = (attr('rel') ?? '').toLowerCase()
    const href = attr('href')
    if (!href || !/\b(icon|apple-touch-icon)\b/.test(rel) || /mask-icon/.test(rel)) continue
    const size = Number(/(\d+)x\d+/.exec(attr('sizes') ?? '')?.[1] ?? 0)
    const svg = /\.svg(\?|$)/i.test(href) || /svg/.test(attr('type') ?? '')
    const score = svg ? 1000 : rel.includes('apple-touch-icon') ? 100 : size && size <= 256 ? 200 + size : 150
    try {
      found.push({ href: new URL(href.replace(/&amp;/g, '&'), base).href, score })
    } catch {
      /* an address that does not parse is not an icon */
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.href)
}

/**
 * An SVG icon as it looks on a light background, whatever the system's mode. Icons are drawn on a
 * white chip, and some sites' icons turn white in dark mode (a prefers-color-scheme: dark rule in
 * their own style), which leaves a blank chip. Those rules are taken out; the rest is left as it is.
 */
export function lightSvg(svg: string): string {
  let out = svg
  for (;;) {
    const at = out.search(/@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/i)
    if (at < 0) return out
    // Through the brace that closes the block, rules inside it and all.
    let i = out.indexOf('{', at)
    let depth = 0
    for (; i < out.length; i++) {
      if (out[i] === '{') depth++
      else if (out[i] === '}' && --depth === 0) break
    }
    out = out.slice(0, at) + out.slice(i + 1)
  }
}
