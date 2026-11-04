// Two workspaces may not share a name. Names that differ only in case or spacing count as the same.

const norm = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

export const sameName = (a: string, b: string) => norm(a) === norm(b)

/** The name itself if none of `taken` is it, else the name with the first free number after it ("Inbox 2"). */
export const freeName = (name: string, taken: Iterable<string>) => {
  const used = new Set([...taken].map(norm))
  const base = name.trim().replace(/\s+/g, ' ')
  let next = base
  for (let n = 2; used.has(norm(next)); n++) next = `${base} ${n}`
  return next
}
