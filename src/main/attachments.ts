// Files the user drops on a conversation, turned into paths the agent engine will attach. The
// engine only reads files under its roots (the data folder and the home folder), so a file from
// anywhere else, or one with no file behind it (an image pasted or dragged out of a browser), is
// copied into <data>/attachments first. The engine captures what it attaches, so these copies are
// only needed until the message is sent; ones older than a day are swept at launch.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'

/** What the engine accepts per attachment (AGENT_TRANSFER_MAX_BYTES). */
const MAX_FILE = 1024 ** 3
/** Bytes that arrive over IPC sit in memory on both sides. */
const MAX_BYTES = 256 * 1024 ** 2
const DAY = 24 * 3600e3

export interface StagedFile {
  path: string
  name: string
  size: number
}

/** The folders the engine reads attachments from; AGENT_FILE_ROOTS in services/Engine.ts. */
export const fileRoots = (dataDir: string) => [dataDir, homedir()]

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
// The engine takes names of 1-200 characters without control characters or slashes.
const cleanName = (name: string) => basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f/]/g, '').slice(0, 200) || 'file'
const mb = (n: number) => `${Math.round(n / 1024 ** 2)} MB`

export function attachments(dataDir: string) {
  const dir = join(dataDir, 'attachments')
  const place = async (name: string) => {
    const folder = join(dir, randomUUID())
    await mkdir(folder, { recursive: true })
    return join(folder, cleanName(name))
  }

  const stage = async (req: { path?: string; name?: string; bytes?: Uint8Array }): Promise<StagedFile> => {
    if (req.path) {
      const name = cleanName(req.name || req.path)
      const real = await realpath(req.path).catch(() => {
        throw new Error(`Could not read “${name}”.`)
      })
      const info = await stat(real)
      if (info.isDirectory()) throw new Error(`“${name}” is a folder. Drop the files in it instead.`)
      if (!info.isFile()) throw new Error(`“${name}” is not a file.`)
      if (info.size > MAX_FILE) throw new Error(`“${name}” is too large to attach (over 1 GB).`)
      const roots = await Promise.all(fileRoots(dataDir).map((r) => realpath(r).catch(() => r)))
      if (roots.some((r) => within(r, real))) return { path: real, name, size: info.size }
      const copy = await place(name)
      await copyFile(real, copy)
      return { path: copy, name, size: info.size }
    }
    if (!req.bytes) throw new Error('Nothing to attach.')
    const name = cleanName(req.name || 'file')
    if (req.bytes.byteLength > MAX_BYTES) throw new Error(`“${name}” is too large to attach this way (over ${mb(MAX_BYTES)}). Save it to a file and drop that.`)
    const copy = await place(name)
    await writeFile(copy, req.bytes)
    return { path: copy, name, size: req.bytes.byteLength }
  }

  const sweep = async () => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const path = join(dir, e.name)
      const info = await stat(path).catch(() => null)
      if (info && Date.now() - info.mtimeMs > DAY) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { stage, sweep }
}
