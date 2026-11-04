// Mentions in typed text ("@Revenue"), found the same way wherever they are typed: the agent's
// message box and Point's note box. Plain code, no React: Point's box is plain DOM.

/**
 * Where each of `marks` (whole mentions, such as "@Revenue") stands in `text`: an @ at the start or
 * after a space, the mention, then the end, a space or punctuation. Where two could, the longest wins.
 */
export function markRanges(text: string, marks: string[]) {
  const longest = [...new Set(marks)].filter((m) => m.length > 1).sort((a, b) => b.length - a.length)
  const out: { start: number; end: number; mark: string }[] = []
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    if (i > 0 && !/\s/.test(text[i - 1]!)) continue
    const mark = longest.find((m) => text.startsWith(m, i) && !/[\p{L}\p{N}_]/u.test(text[i + m.length] ?? ''))
    if (!mark) continue
    out.push({ start: i, end: i + mark.length, mark })
    i += mark.length - 1
  }
  return out
}

/** The @ being typed just before the caret, and what follows it so far: what a list of mentions is narrowed by. */
export const typedMention = (before: string) => /(^|\s)@([^@\n]{0,40})$/.exec(before)
