// A cron expression in words, for the common shapes ("*/10 * * * *" -> "Every 10 minutes",
// "*/5 * * * * *" -> "Every 5 seconds"). Anything it cannot say plainly comes back as the expression itself.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)
const num = (s: string) => /^\d+$/.test(s)
const step = (s: string) => (/^\*\/\d+$/.test(s) ? Number(s.slice(2)) : null)

/** Which days, as words that follow "on": "weekdays", "Mondays", "Monday, Wednesday and Friday". Null when not sayable. */
function days(dow: string): string | null {
  const set = new Set<number>()
  for (const part of dow.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part)
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] === undefined ? from : Number(m[2])
    if (from > 7 || to > 7 || from > to) return null
    for (let d = from; d <= to; d++) set.add(d % 7)
  }
  const all = [...set].sort((a, b) => a - b)
  const key = all.join('')
  if (key === '0123456') return ''
  if (key === '12345') return 'weekdays'
  if (key === '06') return 'weekends'
  return all.length === 1 ? `${DAYS[all[0]!]}s` : list(all.map((d) => DAYS[d]!))
}

export function cronWords(expr: string): string {
  const parts = String(expr).trim().split(/\s+/)
  // Six fields: seconds first.
  if (parts.length === 6) {
    const [sec, ...rest] = parts as [string, ...string[]]
    if (sec === '0') return cronWords(rest.join(' '))
    const n = sec === '*' ? 1 : step(sec)
    const [min, hour, dom, month, dow] = rest
    if (!n || min !== '*' || hour !== '*' || dom !== '*' || month !== '*') return expr
    const on = dow === '*' ? '' : days(dow!)
    if (on === null) return expr
    return `Every ${n === 1 ? 'second' : `${n} seconds`}${on ? ` on ${on}` : ''}`
  }
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
  if (month !== '*') return expr
  const mm = min.padStart(2, '0')
  // How often within a day, or the time of day.
  let often: string | null = null
  let at: string | null = null
  if (hour === '*') {
    const n = step(min)
    if (min === '*' || n === 1) often = 'Every minute'
    else if (n) often = `Every ${n} minutes`
    else if (num(min)) often = `Every hour at :${mm}`
  } else if (step(hour) && num(min)) often = step(hour) === 1 ? `Every hour at :${mm}` : `Every ${step(hour)} hours at :${mm}`
  else if (num(hour) && num(min)) at = `${hour.padStart(2, '0')}:${mm}`
  if (!often && !at) return expr

  if (dom === '*') {
    const on = dow === '*' ? '' : days(dow)
    if (on === null) return expr
    if (often) return on ? `${often} on ${on}` : often
    return on ? `${on[0]!.toUpperCase()}${on.slice(1)} at ${at}` : `Every day at ${at}`
  }
  if (dow !== '*' || !num(dom)) return expr
  return often ? `${often} on day ${dom} of the month` : `Day ${dom} of every month at ${at}`
}
