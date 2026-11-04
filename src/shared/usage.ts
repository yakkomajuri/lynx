// How much of their plan's usage Claude Code and Codex have left: the windows each one counts in (a
// 5-hour one, a weekly one, one per model), each as a share used and when it starts over. Read in the
// main process (src/main/usage.ts) and shown in Settings › Usage.

/** One window a plan's usage is counted in. */
export interface UsageWindow {
  /** "5-hour limit", "Weekly limit", "Weekly · Opus". */
  name: string
  /** Share used, 0–100. */
  used: number
  /** When it starts over (ms), or null when not known. */
  resetsAt: number | null
}

export interface ProviderUsage {
  id: 'claude' | 'codex'
  name: string
  /**
   * ok: the windows are known. none: signed in some way plan limits do not apply to (an API key,
   * Bedrock, Vertex). missing: not installed. unsupported: installed, but too old to say. error: asking failed.
   */
  status: 'ok' | 'none' | 'missing' | 'unsupported' | 'error'
  /** The plan, as the provider names it ("max", "pro", "plus"), when known. */
  plan?: string | null
  windows: UsageWindow[]
  /** Paid usage past the plan, when there is any to say. */
  extra?: string
  /** Why there are no windows, in words. */
  detail?: string
}

export interface UsageReport {
  providers: ProviderUsage[]
  /** When it was read (ms). */
  at: number
}

const clampPercent = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null)
/** ISO text, or seconds or ms since 1970, as ms. */
const time = (t: unknown): number | null => {
  if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t < 1e12 ? t * 1000 : t
  if (typeof t === 'string' && t) {
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/** The rate-limit part of Claude Code's structured `/usage` answer (get_usage), as windows. */
export function claudeWindows(limits: any): UsageWindow[] {
  if (!limits || typeof limits !== 'object') return []
  const out: UsageWindow[] = []
  const add = (name: string, w: any) => {
    const used = clampPercent(w?.utilization)
    if (used !== null) out.push({ name, used, resetsAt: time(w?.resets_at) })
  }
  add('5-hour limit', limits.five_hour)
  add('Weekly limit', limits.seven_day)
  add('Weekly · Opus', limits.seven_day_opus)
  add('Weekly · Sonnet', limits.seven_day_sonnet)
  // Use through apps signed in with the Claude account (Claude Code's own sign-in among them).
  add('Weekly · OAuth apps', limits.seven_day_oauth_apps)
  if (Array.isArray(limits.model_scoped)) for (const m of limits.model_scoped) add(`Weekly · ${String(m?.display_name ?? 'model')}`, m)
  return out
}

/** Claude's paid usage past the plan, when it is on: "$12.40 of $50.00 this month". */
export function claudeExtra(limits: any): string | undefined {
  const x = limits?.extra_usage
  if (!x?.is_enabled) return undefined
  const money = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: x.currency || 'USD' }).format(n)
    } catch {
      return `${n.toFixed(2)} ${x.currency ?? ''}`.trim()
    }
  }
  // Credits come in cents.
  const used = typeof x.used_credits === 'number' ? money(x.used_credits / 100) : null
  const limit = typeof x.monthly_limit === 'number' ? money(x.monthly_limit / 100) : null
  if (used && limit) return `Extra usage: ${used} of ${limit} this month`
  if (used) return `Extra usage: ${used} this month`
  return 'Extra usage is on'
}

/** "5-hour limit", "Weekly limit", or the window's length in hours or days. */
const codexWindowName = (mins: unknown) => {
  if (typeof mins !== 'number' || !mins) return 'Limit'
  if (mins === 300) return '5-hour limit'
  if (mins === 10080) return 'Weekly limit'
  if (mins % 1440 === 0) return `${mins / 1440}-day limit`
  if (mins % 60 === 0) return `${mins / 60}-hour limit`
  return `${mins}-minute limit`
}

/** Codex's `account/rateLimits/read` answer, as windows: every bucket it counts in (usually just `codex`). */
export function codexWindows(result: any): UsageWindow[] {
  const byId = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object' ? Object.values(result.rateLimitsByLimitId) : []
  const snapshots = (byId.length ? byId : [result?.rateLimits]).filter(Boolean) as any[]
  const several = snapshots.length > 1
  const out: UsageWindow[] = []
  for (const s of snapshots) {
    // The main bucket goes unnamed; others (a model of their own) say which they are.
    const bucket = several && s.limitId !== 'codex' ? String(s.limitName ?? s.limitId ?? '') : ''
    for (const w of [s.primary, s.secondary]) {
      const used = clampPercent(w?.usedPercent)
      if (used === null) continue
      const name = codexWindowName(w.windowDurationMins)
      out.push({ name: bucket ? `${name} · ${bucket}` : name, used, resetsAt: time(w.resetsAt) })
    }
  }
  return out
}

/** Codex's credits past the plan, when it has any. */
export function codexExtra(result: any): string | undefined {
  const c = result?.rateLimits?.credits
  if (!c) return undefined
  if (c.unlimited) return 'Unlimited credits'
  if (c.hasCredits && c.balance != null) return `Credits: ${c.balance}`
  return undefined
}
