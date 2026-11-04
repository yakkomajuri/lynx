// Which process is the background service for a data folder, by the pid file it writes once it holds
// its port. It is how a port that does not answer is told apart: a busy service, or something else.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

/** lynxd leaves with this when its port is held by something that is not lynxd. */
export const EXIT_PORT_TAKEN = 3

/** The argument lynxd is started with, so its command line says which data folder it serves. */
export const dataTag = (dataDir: string) => `--data=${dataDir}`

/** Where the service says it is: written with the pid file, once it holds its port. */
export const ADDRESS_FILE = 'lynxd.address'
export function serviceAddress(dataDir: string): { pid: number; port: number } | null {
  try {
    const { pid, port } = JSON.parse(readFileSync(join(dataDir, ADDRESS_FILE), 'utf8'))
    return Number.isInteger(pid) && Number.isInteger(port) ? { pid, port } : null
  } catch {
    return null
  }
}

/** The pid of the lynxd running for this data folder, or null when there is none. */
export function runningService(dataDir: string): number | null {
  let pid: number
  try {
    pid = Number(readFileSync(join(dataDir, 'lynxd.pid'), 'utf8'))
  } catch {
    return null
  }
  if (!pid || pid === process.pid) return null
  try {
    process.kill(pid, 0)
  } catch {
    return null
  }
  // A pid can be reused after a crash, by anything, another data folder's service included.
  try {
    const command = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
    // --data is the final argument, including any spaces in the folder name. An older service may
    // have been started through a symlink: compare the folders, not the spellings of their paths.
    const serviceDir = /(?:^|[/\\\s])lynxd\.js --data=([\s\S]+)$/.exec(command.replace(/\r?\n$/, ''))?.[1]
    return serviceDir && realpathSync(serviceDir) === realpathSync(dataDir) ? pid : null
  } catch {
    return null
  }
}
