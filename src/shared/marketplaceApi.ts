// The remote marketplace's HTTP API: what the app sends and what it expects back. The app's client
// (src/main/marketplaceRemote.ts) and the marketplace server are both written against this file, so a
// real server only has to answer these routes in these shapes.
//
//   GET    /v1/templates                 ?q= &tag= &connector= &creator=official|community &cursor= &limit=
//                                        → TemplateList. Public: no sign-in.
//   GET    /v1/templates/:id             → TemplateSummary. Public.
//   GET    /v1/templates/:id/bundle      ?version= → TemplateBundle: every file of that version (latest
//                                        without one). Public. Versions stay fetchable after newer ones.
//   POST   /v1/templates/:id/installs    → { installs }. Public, counts a fork; best effort.
//   POST   /v1/templates                 PublishRequest → TemplateSummary. Signed in. Same name by the
//                                        same publisher is a new version of that template.
//   DELETE /v1/templates/:id             → { deleted: true }. Signed in, publisher (or official) only.
//   POST   /v1/auth/start                LoginStartRequest → LoginStartResponse: emails a one-time code
//   POST   /v1/auth/login                LoginRequest (the emailed code) → LoginResponse
//   GET    /v1/me                        → Account. Signed in.
//   POST   /v1/me/handle                 { handle } → Account. Claims one unique public handle.
//
// Signed in means `Authorization: Bearer <token>`, the token from /v1/auth/login. Errors are any
// non-2xx status with { error: string }, which the app shows as it is.

import { nextRun, parseCron } from './cron'
import type { MarketplaceRequirement, MarketplaceSchedule, Uses } from './types'

/** Every route, relative to the server's base URL. Change a path here and both sides follow. */
export const ROUTES = {
  list: '/v1/templates',
  template: (id: string) => `/v1/templates/${encodeURIComponent(id)}`,
  /** With a version, exactly that one: what an install takes, so its files match the listing it read. */
  bundle: (id: string, version?: number) => `/v1/templates/${encodeURIComponent(id)}/bundle${version ? `?version=${version}` : ''}`,
  installs: (id: string) => `/v1/templates/${encodeURIComponent(id)}/installs`,
  publish: '/v1/templates',
  loginStart: '/v1/auth/start',
  login: '/v1/auth/login',
  me: '/v1/me',
  claimHandle: '/v1/me/handle',
} as const

/** Who made it: the Lynx team (verified), or anyone with an account. */
export type Creator = 'official' | 'community'

export interface Publisher {
  /** Shown on the template: Lynx, or the publisher's chosen handle. */
  name: string
  /** Empty only for a legacy publisher who has not claimed a handle yet. */
  handle: string
}

/** A template as listed: everything the marketplace page and a template's page show, without its files. */
export interface TemplateSummary {
  id: string
  name: string
  description: string
  icon?: string
  color?: string
  tags: string[]
  creator: Creator
  /** Checked by the Lynx team. Official templates always are. */
  verified: boolean
  publisher: Publisher
  /** Bumped on every publish. The app caches files by it. */
  version: number
  requires: MarketplaceRequirement[]
  uses: Uses
  tools?: string[]
  toolDescriptions?: Record<string, string>
  schedules?: MarketplaceSchedule[]
  /** Set when the template ships preview/mock.js. */
  preview?: { path: string }
  installs: number
  createdAt: string
  updatedAt: string
}

export interface TemplateList {
  templates: TemplateSummary[]
  /** Pass back as ?cursor= for the next page; absent on the last one. */
  next?: string
}

/** One file. Text files come as text; anything else (an image) as base64. Paths are relative, with forward slashes. */
export type BundleFile = { path: string; text: string } | { path: string; base64: string }

export interface TemplateBundle {
  id: string
  version: number
  files: BundleFile[]
}

/**
 * What goes up: the folder as it should be forked, manifest.json included. The server reads name, tags and
 * the rest from the manifest. Its id is the manifest's `id` when it asks for one that is free or already
 * the publisher's, else the name made into a slug (with -2, -3… when someone else has that).
 */
export interface PublishRequest {
  /** Update exactly this existing listing; never fall back to a new ID. */
  update?: { id: string; version: number }
  files: BundleFile[]
}

/**
 * Signing in proves the person owns the email: the server mails a short-lived one-time code to it.
 * Invite codes are shared to sign up for Lynx, so they never sign anyone in.
 */
export interface LoginStartRequest {
  email: string
}

export interface LoginStartResponse {
  sent: true
  /** Only from a local development server with no mail set up, so tests can sign in. Never in production. */
  devCode?: string
}

export interface LoginRequest {
  email: string
  /** The one-time code from the email. */
  code: string
}

export interface Account {
  email: string
  name: string
  /** Null until the signed-in person claims a unique handle. */
  handle: string | null
  /** Publishes as the Lynx team: their templates are official and verified. */
  official: boolean
}

export interface LoginResponse {
  token: string
  account: Account
}

/** Handles are stored lower-case; the database also enforces case-insensitive uniqueness. */
export const normalizeHandle = (value: string) => value.trim().toLowerCase()
export const validHandle = (value: string) => /^[a-z][a-z0-9_]{2,29}$/.test(value)
export const HANDLE_HELP = 'Use 3–30 letters, numbers or underscores, starting with a letter.'

/** Limits both sides hold to. */
export const LIMITS = {
  files: 400,
  /** All files together, as sent. */
  bytes: 5_000_000,
  tags: 8,
  tagLength: 24,
} as const

/** A path a bundle may contain: relative, forward slashes, no `..`, no dotfiles, nothing odd. */
export const safePath = (p: string) => p.length > 0 && p.length <= 200 && /^[\w@+\-][\w@+\-. ]*(\/[\w@+\-][\w@+\-. ]*)*$/.test(p) && !p.split('/').some((s) => s === '..' || s === '.' || s.startsWith('.'))

/** Tags as stored: lower case words with dashes, unique, at most LIMITS.tags. */
export const normTags = (tags: unknown): string[] =>
  Array.isArray(tags)
    ? [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.tagLength)).filter(Boolean))].slice(0, LIMITS.tags)
    : []

// ── what a manifest (and so a template's summary) may hold. The server refuses a publish that breaks
// these, and the app leaves out a listed template that does, so one bad entry cannot break the page.

const isStr = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const short = (v: unknown, max: number) => isStr(v) && v.length > 0 && v.length <= max
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v)
const httpUrl = (v: unknown) => {
  if (!short(v, 500)) return false
  try {
    return ['https:', 'http:'].includes(new URL(v as string).protocol)
  } catch {
    return false
  }
}
/** A connector alias, as code writes it. */
export const NAME = /^[A-Za-z_][\w-]{0,63}$/
/** A custom tool's name: what the app's tools folder takes (Tools.save), so a template's tools can always be installed. */
export const TOOL_NAME = /^[a-z][a-z0-9_]{1,47}$/

/** Why `requires` is malformed, or null. */
export function checkRequires(v: unknown): string | null {
  if (!Array.isArray(v) || v.length > 20) return 'requires must be a list of at most 20 connectors'
  for (const r of v) {
    if (!isObj(r) || !isStr(r.alias) || !NAME.test(r.alias) || !short(r.name, 60)) return 'each entry of requires needs an alias (letters, digits, _ or -) and a name'
    if (!optional(r.url, httpUrl)) return `requires.${r.alias}.url must be an http(s) address`
    if (!optional(r.hint, (h) => short(h, 300))) return `requires.${r.alias}.hint must be text of at most 300 characters`
    if (!optional(r.optional, (o) => typeof o === 'boolean')) return `requires.${r.alias}.optional must be true or false`
  }
  return null
}

/** Why `uses` is malformed, or null. */
export function checkUses(v: unknown): string | null {
  if (v === undefined) return null
  if (!isObj(v) || Object.keys(v).length > 30) return 'uses must be an object of at most 30 connectors'
  for (const [k, tools] of Object.entries(v)) {
    if (!NAME.test(k)) return `uses: ${JSON.stringify(k)} is not a connector name`
    if (tools !== '*' && !(Array.isArray(tools) && tools.length <= 200 && tools.every((t) => isStr(t) && t.length <= 100))) return `uses.${k} must be "*" or a list of tool names`
  }
  return null
}

/** The connectors every install has, by the name code calls them: a manifest's `uses` may name these besides the aliases it requires. */
export const BUILT_IN_CONNECTORS = ['app', 'agents', 'tools'] as const

/**
 * Why a published template's `uses` is not least privilege, or null. What it may call is what the person
 * installing it agrees to, so it must be exact: a list of tools for each connector, never "*", and only
 * connectors it requires or the built-in ones, and present ({} when it calls nothing). Any other name would reach whichever connector of the
 * installer's happens to have that id, without being bound to it.
 */
export function checkExactUses(uses: unknown, requires: unknown): string | null {
  // Left out, an install would fall back to every tool of each bound connector: it must be said, {} for none.
  if (uses === undefined) return 'uses is missing: list the tools the code calls on each connector, or {} when it calls none'
  const wrong = checkUses(uses)
  if (wrong) return wrong
  const aliases = new Set(Array.isArray(requires) ? requires.flatMap((r) => (isObj(r) && isStr(r.alias) ? [r.alias] : [])) : [])
  for (const [k, tools] of Object.entries(uses as Record<string, unknown>)) {
    if (!aliases.has(k) && !(BUILT_IN_CONNECTORS as readonly string[]).includes(k)) return `uses.${k}: ${k} is not in requires and is not a built-in connector (${BUILT_IN_CONNECTORS.join(', ')}); add it to requires or take it out`
    if (tools === '*') return `uses.${k} is "*": list exactly the tools the code calls on ${k}`
  }
  return null
}

/** Why `tools` and `schedules` are malformed, or null. */
export function checkTools(tools: unknown, schedules: unknown): string | null {
  if (tools !== undefined && !(Array.isArray(tools) && tools.length <= 50 && tools.every((t) => isStr(t) && TOOL_NAME.test(t)))) return 'tools must be a list of tool names: lower-case letters, digits and underscores, starting with a letter (for example check_new_prs)'
  if (schedules === undefined) return null
  const names = (tools ?? []) as string[]
  if (!Array.isArray(schedules) || schedules.length > 50) return 'schedules must be a list'
  for (const s of schedules) {
    if (!isObj(s) || !short(s.id, 100) || !isStr(s.tool) || !names.includes(s.tool) || !short(s.cron, 100)) return 'each schedule needs an id, a cron and one of the tools listed in tools'
    // The installer's own checks (Tools.saveSchedule): it parses the cron and works out when it next runs,
    // so a schedule that never can ("0 0 31 2 *") would leave a half-installed template.
    try {
      nextRun(parseCron(s.cron as string), new Date())
    } catch (e) {
      return `schedule ${s.id}: ${e instanceof Error ? e.message : 'not a valid cron'}`
    }
    if (!optional(s.args, isObj)) return `schedule ${s.id}: args must be an object`
  }
  return null
}

/** Whether a listed template is well formed: the app leaves out any that is not. */
export function validSummary(t: unknown): t is TemplateSummary {
  if (!isObj(t)) return false
  return (
    isStr(t.id) &&
    short(t.name, 60) &&
    isStr(t.description) &&
    optional(t.icon, (v) => short(v, 60)) &&
    optional(t.color, (v) => short(v, 60)) &&
    Array.isArray(t.tags) &&
    t.tags.every(isStr) &&
    (t.creator === 'official' || t.creator === 'community') &&
    typeof t.verified === 'boolean' &&
    isObj(t.publisher) &&
    isStr(t.publisher.name) &&
    isStr(t.publisher.handle) &&
    Number.isInteger(t.version) &&
    checkRequires(t.requires) === null &&
    checkExactUses(t.uses, t.requires) === null &&
    checkTools(t.tools, t.schedules) === null &&
    optional(t.toolDescriptions, (d) => isObj(d) && Object.values(d).every(isStr)) &&
    optional(t.preview, (p) => isObj(p) && isStr(p.path) && p.path.startsWith('/')) &&
    optional(t.installs, (n) => Number.isInteger(n))
  )
}
