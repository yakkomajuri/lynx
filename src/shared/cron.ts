// Cron expressions in local time: minute hour day-of-month month day-of-week, with an optional
// field of seconds in front (six fields) for anything more often than once a minute.
// Each field is `*`, a number, a range (1-5), a list (1,15), or any of those with a step (*/10, 0-30/5).

const FIELDS: [name: string, min: number, max: number][] = [
  ['second', 0, 59],
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
  ['day of week', 0, 7],
]

export interface Cron {
  second: Set<number>
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  /** Whether the day-of-month and day-of-week fields restrict anything; when both do, either may match. */
  anyDay: boolean
  anyWeekday: boolean
}

export function parseCron(expr: string): Cron {
  const given = String(expr).trim().split(/\s+/)
  if (given.length !== 5 && given.length !== 6) throw new Error(`A schedule has five fields (minute hour day-of-month month day-of-week), e.g. "*/10 * * * *", or six with seconds first, e.g. "*/5 * * * * *"; got "${expr}"`)
  // Without a seconds field it runs at the start of the minute.
  const parts = given.length === 5 ? ['0', ...given] : given
  const sets = parts.map((part, i) => {
    const [label, min, max] = FIELDS[i]!
    const out = new Set<number>()
    for (const item of part.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item)
      if (!m) throw new Error(`Bad ${label} "${item}" in "${expr}"`)
      const step = m[2] === undefined ? 1 : Number(m[2])
      const [a, b] = m[1] === '*' ? [min, max] : m[1]!.split('-').map(Number)
      // "5/15" means from 5 to the end, every 15.
      const from = a!
      const to = b ?? (m[2] === undefined ? from : max)
      if (step < 1 || from < min || to > max || from > to) throw new Error(`Bad ${label} "${item}" in "${expr}": ${label} runs from ${min} to ${max}`)
      for (let v = from; v <= to; v += step) out.add(v)
    }
    return out
  })
  const weekday = new Set([...sets[5]!].map((d) => d % 7))
  return { second: sets[0]!, minute: sets[1]!, hour: sets[2]!, day: sets[3]!, month: sets[4]!, weekday, anyDay: parts[3] === '*', anyWeekday: parts[5] === '*' }
}

/** The first matching second strictly after `after`. */
export function nextRun(expr: string | Cron, after: Date): Date {
  const c = typeof expr === 'string' ? parseCron(expr) : expr
  const d = new Date(after)
  d.setMilliseconds(0)
  d.setSeconds(d.getSeconds() + 1)
  const dayOk = () => {
    const dom = c.day.has(d.getDate())
    const dow = c.weekday.has(d.getDay())
    return c.anyDay ? dow : c.anyWeekday ? dom : dom || dow
  }
  // Skip whole months, days, hours and minutes that cannot match, so this is a few hundred steps at most.
  for (let guard = 0; guard < 100000; guard++) {
    if (!c.month.has(d.getMonth() + 1)) d.setMonth(d.getMonth() + 1, 1), d.setHours(0, 0, 0, 0)
    else if (!dayOk()) d.setDate(d.getDate() + 1), d.setHours(0, 0, 0, 0)
    else if (!c.hour.has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0)
    else if (!c.minute.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1, 0)
    else if (!c.second.has(d.getSeconds())) d.setSeconds(d.getSeconds() + 1)
    else return d
  }
  throw new Error(`"${typeof expr === 'string' ? expr : 'This schedule'}" never comes round (for example 31 February)`)
}
