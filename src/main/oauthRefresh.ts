// Refresh tokens are often single-use: the server hands back a new one and rejects the old one from
// then on, and the SDK answers that rejection (invalid_grant) by deleting the tokens, which leaves the
// connector waiting for a browser sign-in. The SDK refreshes on every 401 it sees, so a few calls
// that find the token expired together each post the same refresh token. This fetch sends the first
// and gives the others its answer: one refresh per refresh token, whoever asks.
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
interface Answer {
  status: number
  headers: [string, string][]
  body: string
}

/** How long an answer stays good for anyone still holding the refresh token it used. */
const KEEP_MS = 60_000
const answers = new Map<string, Promise<Answer>>()

const refreshTokenOf = (init?: RequestInit) => {
  if (!init || (init.method ?? 'GET').toUpperCase() !== 'POST') return undefined
  const body = init.body
  const params = body instanceof URLSearchParams ? body : typeof body === 'string' ? new URLSearchParams(body) : undefined
  return params?.get('grant_type') === 'refresh_token' ? (params.get('refresh_token') ?? undefined) : undefined
}

export function refreshOnce(inner: Fetch = fetch): Fetch {
  return async (input, init) => {
    const token = refreshTokenOf(init)
    if (!token) return inner(input, init)
    let answer = answers.get(token)
    if (!answer) {
      answer = inner(input, init).then(async (r) => ({ status: r.status, headers: [...r.headers], body: await r.text() }))
      answers.set(token, answer)
      // Forget a failure at once (a dropped network should be retried); keep a success for the stragglers.
      answer.then(
        (a) => setTimeout(() => answers.delete(token), a.status < 400 ? KEEP_MS : 0).unref?.(),
        () => answers.delete(token),
      )
    }
    const a = await answer
    return new Response(a.body, { status: a.status, headers: a.headers })
  }
}
