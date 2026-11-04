/** Previews are untrusted programs, even when their ordinary calls use mock data. */
export const isPreviewUrl = (url: string) => /^sbw:\/\/preview\.(local|remote)\.[a-z0-9-]+\//.test(url)

export function previewHeaders(source: string, item: string) {
  const origin = `sbw://preview.${source}.${item}`
  return {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'content-security-policy': `default-src 'none'; script-src ${origin}/bundle.js; style-src ${origin}/bundle.css 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
  }
}
