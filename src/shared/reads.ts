/** Query metadata travels outside tool arguments. Direct calls and manual reloads stay fresh. */
export interface ReadRequest {
  staleMs: number
  fresh?: boolean
}

export const MAX_READ_AGE = 10 * 60_000
export function readRequest(value: unknown): ReadRequest | undefined {
  if (!value || typeof value !== 'object' || !('staleMs' in value) || typeof value.staleMs !== 'number') return undefined
  return { staleMs: Math.max(0, Math.min(MAX_READ_AGE, Number.isFinite(value.staleMs) ? value.staleMs : MAX_READ_AGE)), fresh: 'fresh' in value && value.fresh === true }
}
