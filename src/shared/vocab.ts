// Correcting what speech-to-text heard, against the names Lynx knows: workspaces, connectors, what is
// on screen, what was just said. No model: each name is compared with the words heard, one, two or
// three at a time, by spelling (Jaro-Winkler) and by sound (Double Metaphone), and a stretch of words
// is replaced only when both agree it is that name. "lenear" becomes Linear, "post hog" PostHog.
import { doubleMetaphone } from 'double-metaphone'

export interface Term {
  /** The name as it should be written. */
  text: string
  /** Where it came from: what the user is most likely to say wins a close call. */
  weight: number
  squashed: string
  tokens: number
  sound: [string, string]
}
export interface Correction {
  text: string
  changes: { from: string; to: string; score: number }[]
}

/** Words that never stand in for a name on their own, nor start or end a stretch longer than the name. */
const STOP = new Set(
  'a an the to in on at of for from by with and or but if then so as is are was were be been it its this that these those there here me my mine you your we our us they them their he she him her his i do does did done can could will would should may might must not no yes up down out over under into onto about after before all any some each every one two new open show make go get put set let please now just also more less very really what which who when where why how'.split(' '),
)

const squash = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/'s$/, '')
    .replace(/[^a-z0-9]/g, '')

/** The words of a name: spaces, dashes and underscores split it, and so does camelCase ("PostHog"). */
const wordsOf = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

const jaroWinkler = (a: string, b: string) => {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const am = new Array<boolean>(a.length).fill(false)
  const bm = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++)
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++)
      if (!bm[j] && a[i] === b[j]) {
        am[i] = bm[j] = true
        matches++
        break
      }
  if (!matches) return 0
  let k = 0
  let swaps = 0
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue
    while (!bm[k]) k++
    if (a[i] !== b[k]) swaps++
    k++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - swaps / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

const levenshtein = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const was = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = was
    }
  }
  return row[b.length]!
}

/** How alike two sound codes are, 0 to 1, taking the closer of each side's two codes. */
const soundAlike = (a: [string, string], b: [string, string]) => {
  let best = 0
  for (const x of a)
    for (const y of b) {
      if (!x || !y) continue
      best = Math.max(best, 1 - levenshtein(x, y) / Math.max(x.length, y.length))
    }
  return best
}

/** A name, ready to compare; none when it is too short or too common to stand for anything. */
export const term = (text: string, weight = 1): Term | null => {
  const clean = text.replace(/\s+/g, ' ').trim()
  const words = wordsOf(clean)
  const squashed = squash(clean)
  if (squashed.length < 4 || words.length > 4 || /^\d+$/.test(squashed)) return null
  if (words.length === 1 && STOP.has(squashed)) return null
  return { text: clean, weight, squashed, tokens: words.length, sound: doubleMetaphone(squashed) }
}

/** The names to listen for, from where they were found, each once (the heaviest copy kept). */
export const vocabulary = (sources: { texts: string[]; weight: number }[], max = 400): Term[] => {
  const byName = new Map<string, Term>()
  for (const s of sources)
    for (const text of s.texts) {
      const add = (t: Term | null) => t && (byName.get(t.squashed)?.weight ?? -1) < t.weight && byName.set(t.squashed, t)
      const t = term(text, s.weight)
      add(t)
      // The capitalised words of a longer name are names too: "Globex pilot" gives Globex.
      if (t && t.tokens > 1) for (const w of wordsOf(t.text)) if (/^\p{Lu}/u.test(w) && w.length >= 5) add(term(w, s.weight * 0.9))
    }
  return [...byName.values()].sort((a, b) => b.weight - a.weight).slice(0, max)
}

/**
 * Names in running text: runs of capitalised or camelCase words ("Globex pilot" gives Globex, "the
 * MotherDuck warehouse" MotherDuck). Words that open a sentence only count when they look like names.
 */
export const namesIn = (text: string) => {
  const out: string[] = []
  for (const run of text.matchAll(/(?:\b[A-Z][\p{L}\p{N}]*(?:[ -](?=[A-Z])|\b))+/gu)) {
    const first = run.index === 0 || /[.!?:]\s*$/.test(text.slice(0, run.index))
    // A little word opening a sentence is not part of the name after it ("The MotherDuck").
    const words = run[0].trim().split(/[ -]/)
    while (words.length && STOP.has(words[0]!.toLowerCase())) words.shift()
    const name = words.join(' ')
    if (!name || (first && words.length === run[0].trim().split(/[ -]/).length && !/[a-z][A-Z]|\s/.test(name))) continue
    out.push(name)
  }
  return out
}

const SPELLING = 0.8
const SOUND = 0.6
const SCORE = 0.86

/** What was heard, with the names in it written as Lynx knows them. Unsure, it leaves words as they are. */
export const correct = (heard: string, terms: Term[]): Correction => {
  const words = [...heard.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu)].map((m) => ({ text: m[0], at: m.index!, end: m.index! + m[0].length, squashed: squash(m[0]) }))
  const found: { from: number; to: number; term: Term; score: number }[] = []
  for (const t of terms)
    for (let n = Math.max(1, t.tokens - 1); n <= t.tokens + 1; n++)
      for (let i = 0; i + n <= words.length; i++) {
        const span = words.slice(i, i + n)
        // A longer stretch than the name may not lean on a little word at either end.
        if (n > t.tokens && (STOP.has(span[0]!.squashed) || STOP.has(span[n - 1]!.squashed))) continue
        if (span.every((w) => STOP.has(w.squashed))) continue
        const squashed = span.map((w) => w.squashed).join('')
        // Spelled right: one word only differs in capitals ("linear" is left be), but words that run
        // together into the name are it ("post hog" is PostHog).
        if (squashed === t.squashed) {
          if (n > 1 && span.map((w) => w.text).join(' ') !== t.text) found.push({ from: i, to: i + n, term: t, score: 1 })
          continue
        }
        // Numbers in a name are said too: "stage" is not Stage 1.
        if (/\d/.test(t.squashed) && t.squashed.replace(/\D/g, '') !== squashed.replace(/\D/g, '')) continue
        const ratio = squashed.length / t.squashed.length
        if (ratio < 0.6 || ratio > 1.6) continue
        const spelling = jaroWinkler(squashed, t.squashed)
        if (spelling < SPELLING) continue
        const sound = soundAlike(doubleMetaphone(squashed), t.sound)
        if (sound < SOUND) continue
        const score = 0.6 * spelling + 0.4 * sound
        if (score >= SCORE) found.push({ from: i, to: i + n, term: t, score })
      }
  // The best first, by how sure and how likely; no word changes twice.
  found.sort((a, b) => b.score * b.term.weight - a.score * a.term.weight)
  const taken = new Set<number>()
  const picked = found.filter((f) => {
    for (let i = f.from; i < f.to; i++) if (taken.has(i)) return false
    for (let i = f.from; i < f.to; i++) taken.add(i)
    return true
  })
  let text = heard
  for (const f of picked.sort((a, b) => b.from - a.from)) {
    const last = words[f.to - 1]!
    const possessive = /'s$/i.test(last.text) ? "'s" : ''
    text = text.slice(0, words[f.from]!.at) + f.term.text + possessive + text.slice(last.end)
  }
  return {
    text,
    changes: picked
      .sort((a, b) => a.from - b.from)
      .map((f) => ({ from: heard.slice(words[f.from]!.at, words[f.to - 1]!.end), to: f.term.text, score: Math.round(f.score * 100) / 100 })),
  }
}
