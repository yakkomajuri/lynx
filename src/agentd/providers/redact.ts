/**
 * Masks every secret in the text. The places to mask are found in the original text and merged, so
 * secrets that overlap or contain one another cannot hide each other. With `cut`, the text was cut
 * off and may stop partway into a secret: an ending that could be the start of one is masked too.
 */
function mask(text: string, secrets: readonly string[], cut: boolean) {
  const ranges: [number, number][] = []
  for (const value of secrets) {
    if (value.length < 4) continue
    for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) ranges.push([at, at + value.length])
    if (cut)
      for (let n = Math.min(value.length - 1, text.length); n > 0; n--)
        if (text.endsWith(value.slice(0, n))) {
          ranges.push([text.length - n, text.length])
          break
        }
  }
  if (!ranges.length) return text
  ranges.sort((a, b) => a[0] - b[0])
  let out = ''
  let from = 0
  for (let i = 0; i < ranges.length; ) {
    let [start, end] = ranges[i++]!
    while (i < ranges.length && ranges[i]![0] <= end) end = Math.max(end, ranges[i++]![1])
    out += text.slice(from, start) + '[REDACTED]'
    from = end
  }
  return out + text.slice(from)
}

export const redactKnown = (text: string, secrets: readonly string[]) => mask(text, secrets, false)
/** For text cut off before its end, such as a preview or a partial line. */
export const redactCut = (text: string, secrets: readonly string[]) => mask(text, secrets, true)

export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return value
  if (typeof value === 'string') return redactKnown(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactKnown(key, secrets), redactValue(item, secrets)]))
  return value
}

/** The secret strings inside connection headers, with and without their "Bearer " prefix. */
export const headerSecrets = (headers: Record<string, string>[]) => headers.flatMap((h) => Object.values(h)).flatMap((v) => (/^Bearer /i.test(v) ? [v, v.slice(7)] : [v]))

/** Environment variables that hold a provider credential: a worker may print them. */
const CREDENTIALS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_FOUNDRY_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']
/** The provider credentials in these environments (the process's, the one Claude Code's settings add). */
export const envSecrets = (...envs: Record<string, string | undefined>[]) =>
  envs.flatMap((env) => CREDENTIALS.map((key) => env[key])).filter((value): value is string => !!value)
