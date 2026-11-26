// The process environment both halves of the app need: the window, and the background service that
// may be started at login with next to nothing in its environment.
import { execFile, execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'

// What tells Claude Code to use a cloud provider instead of an Anthropic sign-in, and that provider's
// region, profile and credentials. People on Bedrock or Vertex often export these from their shell
// profile. API keys stay out: a key in the shell is no sign that the user wants Claude billed to it.
const PROVIDER_ENV =
  /^(CLAUDE_CODE_(USE|SKIP)_(BEDROCK|VERTEX|FOUNDRY)(_AUTH)?|ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY)_\w+|ANTHROPIC_DEFAULT_[A-Z]+_MODEL|ANTHROPIC_SMALL_FAST_MODEL(_AWS_REGION)?|AWS_\w+|CLOUD_ML_REGION|VERTEX_REGION_\w+|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT)$/
const MARK = '__LYNX_SHELL_PATH__'

/** The cloud-provider variables in a shell's `env` output that this process does not have yet. */
export function providerEnv(listing: string, have: NodeJS.ProcessEnv = process.env) {
  const found: Record<string, string> = {}
  for (const line of listing.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line)
    if (m && PROVIDER_ENV.test(m[1]!) && have[m[1]!] === undefined) found[m[1]!] = m[2]!
  }
  return found
}

// Markers around PATH, since a profile may print to the terminal first.
const SHELL_ARGS = ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"; env`]
const SHELL_OPTS: ExecFileSyncOptionsWithStringEncoding = { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }

// GUI apps (and launchd) do not inherit the shell environment: node, claude, codex and local MCP
// servers live on its PATH, and Claude Code may be set up there to use Bedrock or Vertex.
export function fixPath() {
  let out = ''
  try {
    out = execFileSync(process.env.SHELL || '/bin/zsh', SHELL_ARGS, SHELL_OPTS)
  } catch {
    /* defaults below */
  }
  applyShell(out)
}

// fixPath without blocking. A login shell can take seconds, so the window shows first and runs this
// after: nothing it starts needs the shell's PATH until the user asks for it.
let later: Promise<void> | undefined
export function fixPathLater() {
  // Once per app, however many windows open.
  if (later) return later
  later = new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/zsh', SHELL_ARGS, SHELL_OPTS, (error, out) => {
      applyShell(error ? '' : out)
      resolve()
    })
  })
  return later
}

function applyShell(out: string) {
  const extra = [`${process.env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/share/mise/shims`]
  const [, shellPath = '', listing = ''] = out.split(MARK)
  Object.assign(process.env, providerEnv(listing))
  process.env.PATH = [...new Set([...shellPath.split(':'), ...(process.env.PATH ?? '').split(':'), ...extra].filter(Boolean))].join(':')
  // Nor a locale when opened from Finder; the agents' tools expect one.
  if (!process.env.LANG && !process.env.LC_ALL) process.env.LANG = 'en_US.UTF-8'
}

/** Opens a web address in the default browser, from a process that has no Electron to ask. */
export function openUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return Promise.reject(new Error('Only web addresses are opened'))
  // Never through a shell: an address is full of characters a shell would read.
  return new Promise<void>((resolve, reject) => execFile('open', [url], (e) => (e ? reject(e) : resolve())))
}
