// Drafts: how agents change a workspace without stepping on each other. Every workspace folder is a
// git repository whose `main` is what is on screen. An agent works in a draft of its own (a
// worktree on branch draft/<name>, outside the workspace folder) and publishes it when done.
// Publishing is the only moment that needs care, so it is the only one that waits its turn: it
// is refused when someone else published since the draft began, and the agent rebases and tries
// again. A published change is one commit on main, so main's log is the workspace's history.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Effect, Layer } from 'effect'
import { Config } from './Config'
import { Events } from './Events'
import { Workspaces } from './Workspaces'

export interface DraftInfo {
  workspace: string
  draft: string
  /** The folder to edit. */
  dir: string
  branch: string
  /** Changes in the draft not yet published, counted in commits (uncommitted edits count as one more). */
  ahead: number
  /** Changes published to the workspace since the draft last caught up with it. */
  behind: number
  /** Edits not committed yet. Publishing commits them. */
  dirty: boolean
}

export interface Change {
  commit: string
  /** Who published it: an agent's draft, or "Lynx" for edits made directly in the folder. */
  by: string
  at: string
  message: string
  files: string[]
}

export type PublishResult =
  | { published: true; commit: string; files: string[] }
  | { published: false; reason: 'nothing'; detail: string }
  | { published: false; reason: 'behind'; detail: string; changes: Change[] }
  | { published: false; reason: 'build'; detail: string; errors: string[] }
  | { published: false; reason: 'rebasing'; detail: string }
  | { published: false; reason: 'name'; detail: string }

export interface DraftsShape {
  /** The draft by this name, made from what is on screen if there is none yet. */
  readonly open: (workspace: string, draft: string) => Effect.Effect<DraftInfo, Error>
  readonly build: (workspace: string, draft: string) => Effect.Effect<{ status: 'ok' | 'error'; errors: string[] }, Error>
  readonly publish: (workspace: string, draft: string, message: string) => Effect.Effect<PublishResult, Error>
  readonly discard: (workspace: string, draft: string) => Effect.Effect<boolean, Error>
  /** Published changes, newest first, and the drafts in progress. */
  readonly history: (workspace: string, limit?: number) => Effect.Effect<{ changes: Change[]; drafts: DraftInfo[] }, Error>
  /** Undo one published change with a new change that reverses it. */
  readonly revert: (workspace: string, commit: string) => Effect.Effect<{ reverted: true; commit: string } | { reverted: false; reason: string }, Error>
}

export class Drafts extends Context.Service<Drafts, DraftsShape>()('Drafts') {}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)))
const attempt = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: asError })

// Built output, the user's files for the agent and the kit guide (rewritten at every start) are not the workspace's history.
const GITIGNORE = '.data/\n.out/\n.agent-attachments/\nnode_modules/\n.DS_Store\nKIT.md\n'
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/i
const SEP = '\x1f'
const REC = '\x1e'

interface Git {
  (cwd: string, args: string[], opts?: { as?: string }): Promise<string>
  ok: (cwd: string, args: string[]) => Promise<boolean>
}
const git: Git = Object.assign(
  (cwd: string, args: string[], opts: { as?: string } = {}) =>
    new Promise<string>((resolve, reject) => {
      // Commits are the app's, whatever the user's own git settings say.
      const id = ['-c', `user.name=${opts.as ?? 'Lynx'}`, '-c', 'user.email=lynx@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
      execFile('git', [...id, ...args], { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`)) : resolve(stdout)))
    }),
  {
    ok: (cwd: string, args: string[]) => git(cwd, args).then(
      () => true,
      () => false,
    ),
  },
)

export const DraftsLive = Layer.effect(Drafts)(
  Effect.gen(function* () {
    const cfg = yield* Config
    const events = yield* Events
    const workspaces = yield* Workspaces
    const root = join(cfg.dataDir, 'drafts')

    // One change to a workspace's repository at a time.
    const queues = new Map<string, Promise<unknown>>()
    const serial = <A>(id: string, f: () => Promise<A>): Promise<A> => {
      const next = (queues.get(id) ?? Promise.resolve()).then(f, f)
      queues.set(id, next.catch(() => undefined))
      return next
    }
    const live = (id: string) => {
      const w = workspaces.get(id)
      if (!w) throw new Error(`No workspace named ${id}`)
      return w
    }
    /** The workspace name a commit's workspace.json gives. Read from git, not the folder, so it is checked before it is on disk. */
    const nameAt = (dir: string, rev: string) =>
      git(dir, ['show', `${rev}:workspace.json`]).then(
        (t) => {
          const name = (JSON.parse(t) as { name?: unknown }).name
          return typeof name === 'string' ? name : undefined
        },
        () => undefined,
      )
    /** Why a name cannot become the workspace's, if it is a new one and another workspace has it. */
    const nameClash = (id: string, name: string | undefined) => (name !== undefined && name.trim() !== live(id).name ? workspaces.nameTaken(name, id) : undefined)
    const named = (draft: string) => {
      if (!NAME.test(draft)) throw new Error('A draft name is letters, digits and dashes, up to 48')
      return draft
    }
    const draftDir = (id: string, draft: string) => join(root, id, draft)

    /** The workspace folder as a repository, started from what is in it the first time. */
    const repo = async (id: string) => {
      const dir = live(id).dir
      if (existsSync(join(dir, '.git'))) return dir
      if (!existsSync(join(dir, '.gitignore'))) await writeFile(join(dir, '.gitignore'), GITIGNORE)
      await git(dir, ['init', '-q', '-b', 'main'])
      await git(dir, ['add', '-A'])
      await git(dir, ['commit', '-q', '--allow-empty', '-m', 'Start of history'])
      return dir
    }
    /** Anything changed in the folder itself (the app's own edits, an editor) becomes a change on main, so drafts see it as published. */
    const settle = async (dir: string) => {
      if (!(await git(dir, ['status', '--porcelain'])).trim()) return
      await git(dir, ['add', '-A'])
      await git(dir, ['commit', '-q', '-m', 'Changed directly in the folder'])
    }
    const count = async (dir: string, range: string) => Number((await git(dir, ['rev-list', '--count', range])).trim()) || 0
    const info = async (id: string, draft: string): Promise<DraftInfo> => {
      const dir = draftDir(id, draft)
      const branch = `draft/${draft}`
      const dirty = !!(await git(dir, ['status', '--porcelain'])).trim()
      return { workspace: id, draft, dir, branch, ahead: (await count(dir, `main..${branch}`)) + (dirty ? 1 : 0), behind: await count(dir, `${branch}..main`), dirty }
    }
    const rebasing = async (dir: string) => {
      for (const p of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) if (existsSync((await git(dir, ['rev-parse', '--git-path', p])).trim())) return true
      return false
    }
    const changes = async (dir: string, range: string[], limit = 50): Promise<Change[]> => {
      const out = await git(dir, ['log', ...range, `-n${limit}`, '--name-only', `--format=${REC}%H${SEP}%an${SEP}%aI${SEP}%s`])
      return out
        .split(REC)
        .filter((r) => r.trim())
        .map((r) => {
          const [head, ...files] = r.split('\n')
          const [commit, by, at, message] = head!.split(SEP)
          return { commit: commit!, by: by!, at: at!, message: message!, files: files.filter(Boolean) }
        })
    }
    const drafts = async (id: string, dir: string) => {
      const out = await git(dir, ['worktree', 'list', '--porcelain'])
      const names = [...out.matchAll(/^branch refs\/heads\/draft\/(.+)$/gm)].map((m) => m[1]!)
      return Promise.all(names.filter((n) => existsSync(draftDir(id, n))).map((n) => info(id, n)))
    }

    const open: DraftsShape['open'] = (id, draft) =>
      attempt(() =>
        serial(id, async () => {
          named(draft)
          const dir = await repo(id)
          await settle(dir)
          const at = draftDir(id, draft)
          if (!existsSync(at)) {
            await git(dir, ['worktree', 'prune'])
            await mkdir(join(root, id), { recursive: true })
            const exists = await git.ok(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/draft/${draft}`])
            await git(dir, exists ? ['worktree', 'add', '-q', at, `draft/${draft}`] : ['worktree', 'add', '-q', '-b', `draft/${draft}`, at, 'main'])
          }
          // The guide is not tracked; a draft gets the current one to read.
          await writeFile(join(at, 'KIT.md'), await readFile(join(dir, 'KIT.md'), 'utf8').catch(() => ''))
          return info(id, draft)
        }),
      )

    const build: DraftsShape['build'] = (id, draft) =>
      Effect.try({ try: () => draftDir(id, named(draft)), catch: asError }).pipe(
        Effect.flatMap((at) => (existsSync(at) ? workspaces.check(at) : Effect.fail(new Error(`No draft ${draft} of ${id}: start it with workspace_draft`)))),
      )

    const publish: DraftsShape['publish'] = (id, draft, message) =>
      attempt(() =>
        serial(id, async (): Promise<PublishResult> => {
          const at = draftDir(id, named(draft))
          if (!existsSync(at)) throw new Error(`No draft ${draft} of ${id}: start it with workspace_draft`)
          const dir = await repo(id)
          await settle(dir)
          if (await rebasing(at)) return { published: false, reason: 'rebasing', detail: 'The draft is in the middle of a rebase or merge. Resolve the conflicts and finish it (git rebase --continue), then publish again.' }
          const branch = `draft/${draft}`
          const title = message.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Changes'
          if ((await git(at, ['status', '--porcelain'])).trim()) {
            await git(at, ['add', '-A'])
            await git(at, ['commit', '-q', '-m', title], { as: `Agent (${draft})` })
          }
          if (!(await count(dir, `main..${branch}`))) return { published: false, reason: 'nothing', detail: 'The draft has nothing that is not on screen already.' }
          if (!(await git.ok(dir, ['merge-base', '--is-ancestor', 'main', branch]))) {
            const base = (await git(dir, ['merge-base', 'main', branch])).trim()
            return {
              published: false,
              reason: 'behind',
              detail: `Someone else published to this workspace since your draft began. In ${at} run \`git rebase main\`, resolve any conflicts so both changes survive, check it with workspace_build, then publish again.`,
              changes: await changes(dir, [`${base}..main`]),
            }
          }
          const built = await Effect.runPromise(workspaces.check(at))
          if (built.status === 'error') return { published: false, reason: 'build', detail: 'The draft does not build. Fix it and publish again.', errors: built.errors }
          // A draft can rename the workspace; checking the name and putting it on screen is one step,
          // so no other workspace takes the name in between.
          const merged = await workspaces.naming(async (): Promise<PublishResult | undefined> => {
            const clash = nameClash(id, await nameAt(dir, branch))
            if (clash) return { published: false, reason: 'name', detail: `The draft renames the workspace in workspace.json. ${clash}` }
            // One change on main per publish, however many commits the draft took to get there.
            await git(dir, ['merge', '-q', '--squash', branch])
            if (await git.ok(dir, ['diff', '--cached', '--quiet'])) {
              await git(at, ['reset', '-q', '--hard', 'main'])
              return { published: false, reason: 'nothing', detail: 'The draft ends up where the workspace already is.' }
            }
            await git(dir, ['commit', '-q', '-m', title], { as: `Agent (${draft})` })
            await workspaces.reload(id)
          })
          if (merged) return merged
          // The draft carries on from what it just published.
          await git(at, ['reset', '-q', '--hard', 'main'])
          const [head] = await changes(dir, ['main'], 1)
          const w = live(id)
          Effect.runSync(events.publish({ t: 'toast', tone: 'good', text: `${w.name}: ${title}` }))
          return { published: true, commit: head!.commit, files: head!.files }
        }),
      )

    const discard: DraftsShape['discard'] = (id, draft) =>
      attempt(() =>
        serial(id, async () => {
          const at = draftDir(id, named(draft))
          const dir = await repo(id)
          const had = existsSync(at)
          if (had) await git(dir, ['worktree', 'remove', '--force', at]).catch(() => rm(at, { recursive: true, force: true }))
          await git(dir, ['worktree', 'prune'])
          await git.ok(dir, ['branch', '-D', `draft/${draft}`])
          return had
        }),
      )

    const history: DraftsShape['history'] = (id, limit = 50) =>
      attempt(() =>
        serial(id, async () => {
          const dir = await repo(id)
          await settle(dir)
          return { changes: await changes(dir, ['main'], Math.min(Math.max(1, limit), 500)), drafts: await drafts(id, dir) }
        }),
      )

    const revert: DraftsShape['revert'] = (id, commit) =>
      attempt(() =>
        serial(id, async () => {
          if (!/^[0-9a-f]{7,40}$/i.test(commit)) throw new Error('commit is a commit id from workspace_history')
          const dir = await repo(id)
          await settle(dir)
          if (!(await git.ok(dir, ['merge-base', '--is-ancestor', commit, 'main']))) return { reverted: false as const, reason: 'That change is not part of this workspace.' }
          if (!(await git.ok(dir, ['rev-parse', '--verify', '--quiet', `${commit}^`]))) return { reverted: false as const, reason: 'That is where the history starts; there is nothing before it to go back to.' }
          return workspaces.naming(async () => {
            // Undoing a rename brings back the old name, which another workspace may have by now.
            const [was, became] = await Promise.all([nameAt(dir, `${commit}^`), nameAt(dir, commit)])
            const clash = was !== became ? nameClash(id, was) : undefined
            if (clash) return { reverted: false as const, reason: `Undoing it would bring back a name in use. ${clash}` }
            if (!(await git.ok(dir, ['revert', '--no-edit', commit]))) {
              await git.ok(dir, ['revert', '--abort'])
              return { reverted: false as const, reason: 'Later changes touched the same lines, so it cannot be undone on its own. Ask the agent to undo it instead.' }
            }
            await workspaces.reload(id)
            const [head] = await changes(dir, ['main'], 1)
            return { reverted: true as const, commit: head!.commit }
          })
        }),
      )

    return Drafts.of({ open, build, publish, discard, history, revert })
  }),
)
