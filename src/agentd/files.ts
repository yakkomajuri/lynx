// Files under the allowed roots, as the engine served them: listing, ranged reads with a content
// version, and atomic writes and patches that can insist on the version they were based on.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readdir, readFile, readlink, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { AppError, problem } from './store'

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const FS_ERRORS: Record<string, [string, string, number]> = {
  ENOENT: ['not_found', 'File or parent directory not found; create parents with exec first', 404],
  EISDIR: ['invalid_path', 'Expected a regular file, received a directory', 400],
  ENOTDIR: ['invalid_path', 'Expected a directory', 400],
  EACCES: ['permission_denied', 'Filesystem access denied', 403],
  EPERM: ['permission_denied', 'Filesystem access denied', 403],
}
/** Turns filesystem errors into the answers callers expect, e.g. "not found" for a missing file. */
const attempt = async <A>(f: () => Promise<A>): Promise<A> => {
  try {
    return await f()
  } catch (e) {
    if (e instanceof AppError) throw e
    const known = FS_ERRORS[(e as NodeJS.ErrnoException).code ?? '']
    if (known) throw problem(...known)
    throw e
  }
}
const validateVersion = (value?: string) => {
  if (value !== undefined && value !== 'missing' && !/^[a-f0-9]{64}$/.test(value)) throw problem('invalid_request', 'expected_version must be missing or a SHA-256 hex digest')
}
const decodeBase64 = (value: string) => {
  const bytes = Buffer.from(value, 'base64')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || bytes.toString('base64') !== value) throw problem('invalid_request', 'data must be canonical padded base64')
  return bytes
}
const fileVersion = async (path: string) => {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export function createFiles(opts: { dataDir: string; roots: string[] }) {
  /** An absolute path under the roots; with `create`, one that does not exist yet in a folder that does. */
  const allowedPath = async (input: string, create = false) => {
    if (!isAbsolute(input)) throw problem('invalid_path', 'Use an absolute path')
    const requested = resolve(input)
    let path: string
    try {
      path = await realpath(requested)
    } catch (e) {
      if (!create || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      path = join(await realpath(dirname(requested)), basename(requested))
    }
    const roots = await Promise.all(opts.roots.map((r) => realpath(r).catch(() => r)))
    if (!roots.some((root) => within(root, path))) throw problem('permission_denied', 'Path is outside allowed file roots', 403)
    const dataDir = await realpath(opts.dataDir).catch(() => opts.dataDir)
    if (basename(path).startsWith('agentd.sqlite') && within(dataDir, path)) throw problem('permission_denied', 'The agent database is private', 403)
    return path
  }
  // Writes to one path take turns, so a version check and the write it guards cannot interleave.
  const locks = new Map<string, Promise<unknown>>()
  const locked = <A>(path: string, f: () => Promise<A>) => {
    const next = (locks.get(path) ?? Promise.resolve()).then(f, f)
    const settled = next.catch(() => {})
    locks.set(path, settled)
    void settled.then(() => locks.get(path) === settled && locks.delete(path))
    return next
  }

  const list = (input: { path: string; after?: string; limit?: number }) =>
    attempt(async () => {
      const path = await allowedPath(input.path)
      const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).filter((e) => !input.after || e.name > input.after)
      const items = await Promise.all(
        entries.slice(0, input.limit ?? 100).map(async (e) => {
          const info = await lstat(join(path, e.name))
          return {
            name: e.name,
            type: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file',
            size: info.size,
            modified_at: info.mtime.toISOString(),
            ...(e.isSymbolicLink() ? { target: await readlink(join(path, e.name)) } : {}),
          }
        }),
      )
      return { path, items, next_cursor: items.at(-1)?.name ?? input.after ?? '', has_more: entries.length > items.length }
    })

  const read = (input: { path: string; offset?: number; length?: number }) =>
    attempt(async () => {
      const path = await allowedPath(input.path)
      const file = await open(path, 'r')
      try {
        const info = await file.stat({ bigint: true })
        if (!info.isFile()) throw problem('invalid_path', 'Expected a regular file')
        if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw problem('too_large', 'File size exceeds supported range', 413)
        const size = Number(info.size)
        const offset = input.offset ?? 0
        const bytes = Buffer.alloc(Math.min(input.length ?? 65536, Math.max(0, size - offset)))
        // The version is the hash of this open file, read in the same pass as the range, so the two agree.
        const hash = createHash('sha256')
        const chunk = Buffer.alloc(65536)
        let position = 0
        while (position < size) {
          const got = await file.read(chunk, 0, Math.min(chunk.length, size - position), position)
          if (!got.bytesRead) throw problem('file_changed', 'File changed in place during the read', 409)
          hash.update(chunk.subarray(0, got.bytesRead))
          const from = Math.max(position, offset)
          const to = Math.min(position + got.bytesRead, offset + bytes.length)
          if (to > from) chunk.copy(bytes, from - offset, from - position, to - position)
          position += got.bytesRead
        }
        const after = await file.stat({ bigint: true })
        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs) throw problem('file_changed', 'File changed in place during the read', 409)
        const text = bytes.toString('utf8')
        return {
          path,
          data: bytes.toString('base64'),
          encoding: 'base64',
          ...(text.includes('�') || bytes.includes(0) ? {} : { text }),
          size,
          offset,
          next_offset: offset + bytes.length,
          version: hash.digest('hex'),
        }
      } finally {
        await file.close()
      }
    })

  /** Replaces a file atomically: whole (text or base64 data), or one exact fragment of it. */
  const write = (input: { path: string; text?: string; data?: string; expected_version?: string; find?: string; replace?: string }) =>
    attempt(async () => {
      validateVersion(input.expected_version)
      if (input.data !== undefined) decodeBase64(input.data)
      const path = await allowedPath(input.path, true)
      return locked(path, () =>
        attempt(async () => {
          const current = await fileVersion(path)
          if (input.expected_version !== undefined && input.expected_version !== (current ?? 'missing')) throw problem('version_conflict', 'File has changed', 409)
          let bytes: Buffer
          if (input.find !== undefined) {
            if ((await stat(path)).size > 16 * 1024 * 1024) throw problem('too_large', 'Patch supports files up to 16 MiB', 413)
            const text = await readFile(path, 'utf8')
            if (text.indexOf(input.find) < 0) throw problem('patch_not_found', 'find was not found in the file', 409)
            if (text.indexOf(input.find) !== text.lastIndexOf(input.find)) throw problem('ambiguous_patch', 'find must match exactly once', 409)
            bytes = Buffer.from(text.replace(input.find, () => input.replace ?? ''))
          } else bytes = input.data !== undefined ? decodeBase64(input.data) : Buffer.from(input.text ?? '')
          const temp = join(dirname(path), `.agent-${randomUUID()}.tmp`)
          try {
            const file = await open(temp, 'wx', current === null ? 0o600 : (await stat(path)).mode & 0o777)
            try {
              await file.writeFile(bytes)
              await file.sync()
            } finally {
              await file.close()
            }
            await rename(temp, path)
            const folder = await open(dirname(path), 'r')
            try {
              await folder.sync()
            } finally {
              await folder.close()
            }
          } finally {
            await unlink(temp).catch(() => {})
          }
          return { path, size: bytes.length, version: createHash('sha256').update(bytes).digest('hex') }
        }),
      )
    })

  return { list, read, write }
}
export type Files = ReturnType<typeof createFiles>
