// A refresh cannot grant new scopes. Pause at an explicit MCP permission challenge until a
// user asks to reconnect, then run authorization with the requested scope and keep the old
// credentials until the browser flow completes.
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'

export interface ScopeChallenge {
  scope?: string
  resourceMetadataUrl?: string
}
/** Retain previously granted scopes (including offline access) when adding a requested one.
 * Without a scope in the challenge, let SDK discovery choose the server's advertised scopes. */
export function consentScope(granted: unknown, requested?: string): string | undefined {
  if (!requested) return undefined
  return [...new Set(`${typeof granted === 'string' ? granted : ''} ${requested}`.split(/\s+/).filter(Boolean))].join(' ')
}
export class ScopeRequiredError extends Error {
  constructor() {
    super('This connector needs additional permissions. Connect again to review them in your browser.')
  }
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export function scopeAwareFetch(inner: Fetch, serverUrl: string, required: (challenge: ScopeChallenge) => void): Fetch {
  return async (input, init) => {
    const response = await inner(input, init)
    const url = input instanceof Request ? input.url : String(input)
    if (response.status === 403 && new URL(url).origin === new URL(serverUrl).origin) {
      const challenge = extractWWWAuthenticateParams(response)
      if (challenge.error === 'insufficient_scope') {
        required({ ...(challenge.scope ? { scope: challenge.scope } : {}), ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl.toString() } : {}) })
        await response.body?.cancel()
        throw new ScopeRequiredError()
      }
    }
    return response
  }
}
