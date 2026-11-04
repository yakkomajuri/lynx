// Cron and one-off schedules that start or continue a session.
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import { json, now, parse } from './db'
import { AppError, problem, type StartInput, type Store } from './store'

export type Launch = (StartInput & { prompt: string }) | { session_id: string; prompt: string; attachments?: StartInput['attachments'] }
export interface Schedule {
  id: string
  name: string
  cron: string | null
  run_at: string | null
  timezone: string
  launch: Launch
  enabled: boolean
  next_fire_at: string | null
  revision: number
  created_by: string
  created_at: string
  updated_at: string
}

/** How late an occurrence may start before it counts as missed. */
const GRACE_MS = 5000

export function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  if (cron.trim().split(/\s+/).length !== 5) throw problem('invalid_schedule', 'Use a five-field cron expression')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(after)
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toDate()
  } catch (e) {
    throw problem('invalid_schedule', e instanceof Error ? e.message : String(e))
  }
}
function scheduleTime(input: { cron?: string | null; run_at?: string | null; timezone?: string }, enabled: boolean) {
  if (!!input.cron === !!input.run_at) throw problem('invalid_schedule', 'Provide exactly one of cron or run_at')
  if (input.cron && !input.timezone) throw problem('invalid_schedule', 'Cron schedules require a timezone')
  const next = input.run_at ? new Date(input.run_at) : nextOccurrence(input.cron!, input.timezone!, new Date())
  if (!Number.isFinite(next.getTime()) || (enabled && next.getTime() <= Date.now())) throw problem('invalid_schedule', 'run_at must be in the future')
  return enabled ? next.toISOString() : null
}

export function createSchedules(store: Store, opts: { dataDir: string }) {
  const { q, tx } = store
  const toSchedule = (row: any): Schedule => ({ ...row, launch: parse(row.launch), enabled: !!row.enabled })
  const get = (id: string) => {
    const row = q('SELECT * FROM schedules WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!row) throw problem('not_found', 'Schedule not found', 404)
    return toSchedule(row)
  }

  /** Checks a launch and freezes its attachments: they are copied now, so later runs see these exact files. */
  const prepare = async (scheduleId: string, launch: Launch): Promise<Launch> => {
    if ('session_id' in launch) {
      if (store.getSession(launch.session_id).archived_at) throw problem('archived', 'Unarchive the session before scheduling', 409)
    } else for (const id of launch.connection_ids ?? []) if (!q('SELECT id FROM connections WHERE id = ? AND enabled').get(id)) throw problem('connection_unavailable', `Connection ${id} is unavailable`, 409)
    if (!launch.attachments?.length) return launch
    const folder = join(opts.dataDir, 'schedule-files', scheduleId, randomUUID())
    await mkdir(folder, { recursive: true })
    const attachments = []
    for (const [i, a] of launch.attachments.entries()) {
      if (!a.path) throw problem('invalid_request', 'Attach files by path')
      const source = await store.allowedPath(a.path)
      const copy = join(folder, `${i}-${basename(source)}`)
      await copyFile(source, copy)
      attachments.push({ path: copy, name: a.name ?? basename(source) })
    }
    return { ...launch, attachments }
  }

  const create = async (input: { name: string; cron?: string; run_at?: string; timezone?: string; launch: Launch; enabled?: boolean }) => {
    const next = scheduleTime(input, input.enabled ?? true)
    const id = randomUUID()
    const launch = await prepare(id, input.launch)
    const at = now()
    q('INSERT INTO schedules (id, name, cron, run_at, timezone, launch, enabled, next_fire_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id, input.name, input.cron ?? null, input.run_at ?? null, input.timezone ?? 'UTC', json(launch), input.enabled === false ? 0 : 1, next, at, at,
    )
    return get(id)
  }

  const update = async (input: { id: string; name?: string; cron?: string; run_at?: string; timezone?: string; launch?: Launch; enabled?: boolean; expected_revision?: number }) => {
    const current = get(input.id)
    if (input.expected_revision !== undefined && input.expected_revision !== current.revision) throw problem('version_conflict', 'Schedule has changed', 409)
    if (input.cron && input.run_at) throw problem('invalid_schedule', 'Provide only cron or run_at')
    const cron = input.cron ?? (input.run_at ? null : current.cron)
    const run_at = input.run_at ?? (input.cron ? null : current.run_at)
    const timezone = input.timezone ?? current.timezone
    const enabled = input.enabled ?? current.enabled
    const timingChanged = input.cron !== undefined || input.run_at !== undefined || input.timezone !== undefined || enabled !== current.enabled
    const next = timingChanged ? scheduleTime({ cron, run_at, timezone }, enabled) : current.next_fire_at
    const launch = input.launch ? await prepare(input.id, input.launch) : current.launch
    tx(() => {
      if (get(input.id).revision !== current.revision) throw problem('version_conflict', 'Schedule has changed', 409)
      q('UPDATE schedules SET name = ?, cron = ?, run_at = ?, timezone = ?, launch = ?, enabled = ?, next_fire_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(
        input.name ?? current.name, cron, run_at, timezone, json(launch), enabled ? 1 : 0, next, now(), input.id,
      )
    })
    return get(input.id)
  }

  const remove = (id: string) => {
    const changed = q('UPDATE schedules SET enabled = 0, next_fire_at = NULL, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?').run(now(), now(), id)
    if (!changed.changes) throw problem('not_found', 'Schedule not found', 404)
    return { id, deleted: true }
  }

  const list = (input: { after?: string; limit?: number }) => {
    const limit = input.limit ?? 100
    const rows = q('SELECT * FROM schedules WHERE deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?').all(input.after ?? '', limit + 1)
    const items = rows.slice(0, limit).map(toSchedule)
    return { items, next_cursor: items.at(-1)?.id ?? input.after ?? null, has_more: rows.length > items.length }
  }

  const occurrences = (input: { id: string; after?: string; limit?: number }) => {
    if (!q('SELECT id FROM schedules WHERE id = ?').get(input.id)) throw problem('not_found', 'Schedule not found', 404)
    const limit = input.limit ?? 100
    const rows = q('SELECT id, schedule_id, scheduled_at, revision, status, run_id AS execution_id, reason, created_at FROM schedule_occurrences WHERE schedule_id = ? AND id > ? ORDER BY id LIMIT ?').all(input.id, Number(input.after ?? 0), limit + 1)
    const items = rows.slice(0, limit).map((r) => ({ ...r, id: String(r.id) }))
    return { items, next_cursor: items.at(-1)?.id ?? input.after ?? '0', has_more: rows.length > items.length }
  }

  /** Launches what is due. Occurrences missed while Lynx was closed are recorded as skipped, not run late. */
  const tick = async (at = new Date()) => {
    const due = q('SELECT * FROM schedules WHERE enabled AND deleted_at IS NULL AND next_fire_at <= ? ORDER BY next_fire_at, id LIMIT 10').all(at.toISOString()).map(toSchedule)
    for (const schedule of due) {
      let occurrence = new Date(schedule.next_fire_at!)
      for (let count = 0; count < 100 && occurrence <= at; count++) {
        const when = occurrence.toISOString()
        const next = schedule.run_at ? null : nextOccurrence(schedule.cron!, schedule.timezone, occurrence)
        const inserted = q("INSERT OR IGNORE INTO schedule_occurrences (schedule_id, scheduled_at, revision, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(schedule.id, when, schedule.revision, now())
        if (inserted.changes) {
          let status = 'skipped_missed'
          let reason: string | null = 'Occurrence missed while Lynx was closed or delayed beyond the 5 second launch grace'
          let runId: string | null = null
          if (at.getTime() - occurrence.getTime() <= GRACE_MS) {
            const busy = q(`SELECT id FROM runs WHERE json_extract(spec, '$.trigger.schedule_id') = ? AND status IN ('queued', 'starting', 'running', 'waiting_for_input', 'cancelling') LIMIT 1`).get(schedule.id)
            if (busy) {
              status = 'skipped_overlap'
              reason = 'Previous occurrence is still active'
            } else {
              const trigger = { type: 'schedule', schedule_id: schedule.id, scheduled_at: when, revision: schedule.revision }
              try {
                const launch = schedule.launch
                const run =
                  'session_id' in launch
                    ? await store.sendSession(launch.session_id, launch.prompt, { trigger, attachments: launch.attachments })
                    : (await store.startSession({ ...launch, trigger })).run!
                status = 'launched'
                reason = null
                runId = run.id
              } catch (e) {
                status = e instanceof AppError && e.code === 'busy' ? 'skipped_overlap' : 'failed'
                reason = e instanceof Error ? e.message : 'Execution intent could not be created'
              }
            }
          }
          q('UPDATE schedule_occurrences SET status = ?, run_id = ?, reason = ? WHERE schedule_id = ? AND scheduled_at = ?').run(status, runId, reason, schedule.id, when)
        }
        if (!next) {
          q('UPDATE schedules SET enabled = 0, next_fire_at = NULL WHERE id = ?').run(schedule.id)
          break
        }
        occurrence = next
      }
      if (!schedule.run_at) q('UPDATE schedules SET next_fire_at = ? WHERE id = ? AND revision = ?').run(occurrence.toISOString(), schedule.id, schedule.revision)
    }
  }

  return { get, create, update, remove, list, occurrences, tick }
}
export type Schedules = ReturnType<typeof createSchedules>
