// A command the user has to run themselves, such as an agent's sign-in (`/login` in the agent
// panel), opened in a Terminal window of its own. Sign-ins read keys and codes from a terminal, so
// they cannot run hidden behind the app.
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** A word of a command as the shell reads it. */
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** Whether a command is fit to run in a terminal: each word a plain name or flag, or an absolute path (where the agent's CLI is installed). */
export const runnable = (command: unknown): command is string[] =>
  Array.isArray(command) && command.length > 0 && command.every((w) => typeof w === 'string' && (/^[\w.-]+$/.test(w) || (isAbsolute(w) && !/[\0-\x1f]/.test(w))))

/** Runs a program that asks for a window and ends; rejects when it is not there or ends with a fault. */
export const launch = (file: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(file, args, (e) => (e ? reject(e) : resolve())))

/**
 * The shell script a terminal window runs: `command`, then `done`. It removes its own file, and its
 * PATH is the one the app found in the user's shell (env.ts), where the agents' CLIs are.
 */
export const terminalScript = (command: string[], done: string, path = process.env.PATH ?? '') =>
  ['#!/bin/sh', 'rm -f -- "$0"', `export PATH=${quote(path)}`, 'clear', command.map(quote).join(' '), 'echo', `echo ${quote(done)}`].join('\n')

/** Runs `command` in a new Terminal window, which stays open when it ends so its output can be read. */
export async function openInTerminal(command: string[], done: string) {
  if (!runnable(command)) throw new Error('Not a command to run')
  // Terminal runs a .command file it is asked to open, with no Automation permission to grant.
  const file = join(await mkdtemp(join(tmpdir(), 'lynx-')), 'sign-in.command')
  await writeFile(file, `${terminalScript(command, done)}\n`)
  await chmod(file, 0o700)
  return launch('open', ['-a', 'Terminal', file])
}
