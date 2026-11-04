// Opt-in diagnostics for request storms. Never record arguments, results, URLs or credentials.
interface Result {
  isError?: boolean
  content?: { type: string; text?: string }[]
}

export const isRateLimited = (error: unknown) => {
  // The MCP SDK keeps HTTP status in `code`, sometimes without mentioning it in the message.
  if (error && typeof error === 'object' && (('code' in error && error.code === 429) || ('status' in error && error.status === 429) || ('statusCode' in error && error.statusCode === 429))) return true
  // A bare number can be an issue/PR ID. Only treat 429 as evidence in HTTP/status context.
  return /rate.?limit|too many requests|\bHTTP(?:\/\d(?:\.\d)?)?(?:\s+error)?\s*[:=]?\s*429\b|\b(?:status(?:[\s_-]*code)?|code)\b["']?\s*[:=]\s*["']?429\b/i.test(error instanceof Error ? error.message : String(error))
}

interface Summary {
  outcome: string
  rateLimited?: boolean
  textChars?: number
  httpStatus?: number
  tools?: number
  toolDefinitionChars?: number
}

/** A 403 can also mean missing permissions: only call it a rate limit with supporting evidence. */
export function apiTraceSummary(result: { status: number; headers: Record<string, string>; body: unknown }): Summary {
  const text = JSON.stringify(result.body) ?? ''
  return {
    outcome: result.status >= 400 ? 'http_error' : 'ok',
    httpStatus: result.status,
    rateLimited: result.status === 429 || (result.status === 403 && (isRateLimited(text) || result.headers['x-ratelimit-remaining'] === '0' || !!result.headers['retry-after'])),
    textChars: text.length,
  }
}

function toolSummary(result: unknown): Summary {
  const r = result as Result | undefined
  const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
  return { outcome: r?.isError ? 'tool_error' : 'ok', rateLimited: !!r?.isError && isRateLimited(text), textChars: text.length }
}

export function connectorTrace(enabled: boolean, log: (line: string) => void = console.info) {
  let sequence = 0
  let active = 0
  return async <T>(connector: string, tool: string, by: string, run: () => Promise<T>, opts: { operation?: 'call' | 'connect'; reason?: string; summarize?: (result: T) => Summary } = {}): Promise<T> => {
    if (!enabled) return run()
    const id = ++sequence
    const start = Date.now()
    const fields = { id, connector, tool, by, operation: opts.operation ?? 'call', ...(opts.reason ? { reason: opts.reason } : {}) }
    const write = (data: object) => {
      try { log(`[connector-trace] ${JSON.stringify({ ...fields, ...data })}`) } catch { /* diagnostics cannot break calls */ }
    }
    active++
    write({ phase: 'start', active })
    let summary: Summary = { outcome: 'error', rateLimited: false }
    try {
      const result = await run()
      summary = (opts.summarize ?? toolSummary)(result)
      return result
    } catch (error) {
      summary.rateLimited = isRateLimited(error)
      throw error
    } finally {
      active--
      write({ phase: 'end', active, ms: Date.now() - start, ...summary })
    }
  }
}
