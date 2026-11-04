// What a connector's OAuth sign-in keeps, and how the SDK reads and changes it. The SDK does discovery,
// registration and refresh; this decides what is kept, and what a failure is allowed to throw away.
import { randomBytes } from 'node:crypto'
import type { ScopeChallenge } from './oauthScope'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'

export interface OAuthData {
  client?: unknown
  tokens?: unknown
  verifier?: string
  /** When the tokens were last saved, ms. */
  savedAt?: number
  state?: string
  /** Where the authorization server is, as found once the server pointed to it (RFC 9728). */
  discovery?: OAuthDiscoveryState
  /** Server-requested permission upgrade, waiting for a user to reconnect. */
  scopeChallenge?: ScopeChallenge
}

export interface OAuthHooks {
  id: string
  redirect: string
  data: () => OAuthData
  /** Throw away everything kept for this connector. */
  forget: () => void
  save: () => void
  /** Someone is asking for this connector now (a click), so a browser sign-in may be opened. */
  interactive: () => boolean
  /** A user-approved permission upgrade must authorize instead of refreshing old scopes. */
  consent?: boolean
  /** The SDK wants a browser sign-in. `renewable`: a refresh token is still held, so the sign-in is not lost, only not renewed just now. */
  redirectToAuthorization: (url: URL, renewable: boolean) => void | Promise<void>
}

const refreshTokenOf = (d: OAuthData) => (d.tokens as { refresh_token?: string } | undefined)?.refresh_token
const issuerOf = (v: unknown) => {
  const i = (v as { issuer?: unknown } | undefined)?.issuer
  return typeof i === 'string' ? i.replace(/\/+$/, '') : undefined
}
/** Tokens saved this recently are not the ones a server just refused: another refresh got there first. */
export const FRESH_MS = 60_000

export function oauthProvider(h: OAuthHooks): OAuthClientProvider {
  const { data, save } = h
  return {
    get redirectUrl() {
      return h.redirect
    },
    get clientMetadata() {
      return { client_name: 'Lynx', redirect_uris: [h.redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
    },
    // A client registered for another callback port (the saved one was taken at some launch) cannot
    // sign in again: register anew. Not while there are tokens: refreshing needs no redirect, and
    // the refresh token belongs to the client that got it.
    clientInformation: () => {
      const c = data().client as { redirect_uris?: string[] } | undefined
      if (c?.redirect_uris && !c.redirect_uris.includes(h.redirect) && !refreshTokenOf(data())) return undefined
      return c as any
    },
    saveClientInformation: (info) => {
      // A registration with an authorization server other than the one our refresh token came from
      // happens when discovery fell back to the MCP server's own origin for a moment (its metadata did
      // not answer). Keeping it would lose the client the refresh token belongs to, and with it the
      // sign-in, so it is only kept when someone is signing in.
      const held = issuerOf(data().tokens)
      if (!h.interactive() && refreshTokenOf(data()) && held && issuerOf(info) && issuerOf(info) !== held) return
      data().client = info
      save()
    },
    tokens: () => (h.consent && h.interactive() ? undefined : data().tokens) as any,
    saveTokens: (t) => {
      data().tokens = t
      data().savedAt = Date.now()
      save()
    },
    // Discovery runs before every refresh, and when the server's metadata does not answer, the SDK
    // quietly takes the server's own origin for the authorization server, where our client and tokens
    // are not known. Found once, it is kept; only what the server itself pointed to is.
    discoveryState: () => data().discovery,
    saveDiscoveryState: (s) => {
      if (!s.resourceMetadata) return
      data().discovery = s
      save()
    },
    state: () => {
      const s = `${h.id}.${randomBytes(12).toString('base64url')}`
      data().state = s
      return s
    },
    redirectToAuthorization: async (url) => {
      // Still holding a refresh token here means the refresh failed for a reason other than the
      // server refusing it (that deletes the tokens first): try again later rather than ask. Find the
      // server again next time, in case what was kept about it is what failed.
      const renewable = !!refreshTokenOf(data())
      if (renewable && !h.interactive() && data().discovery) {
        delete data().discovery
        save()
      }
      await h.redirectToAuthorization(url, renewable)
    },
    saveCodeVerifier: (v) => {
      data().verifier = v
      save()
    },
    codeVerifier: () => data().verifier ?? '',
    invalidateCredentials: (scope) => {
      if ((scope === 'tokens' || scope === 'all') && Date.now() - (data().savedAt ?? 0) < FRESH_MS) return
      if (scope === 'all') h.forget()
      else if (scope === 'tokens') delete data().tokens
      else if (scope === 'client') delete data().client
      else if (scope === 'discovery') delete data().discovery
      else delete data().verifier
      save()
    },
  }
}
