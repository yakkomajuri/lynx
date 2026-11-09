import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { opencodeBin } from './opencode-bin'
import type { Discovered } from './registry'
const exec = promisify(execFile)

export async function discoverOpenCode(): Promise<Discovered> {
  const command = opencodeBin()
  let version: string
  try { version = (await exec(command, ['--version'], { timeout: 5000 })).stdout.trim() }
  catch { return { available: false, version: null, error: 'OpenCode executable unavailable', models: [] } }
  try {
    const { stdout } = await exec(command, ['--pure', 'models'], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 })
    const ids = [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line)))]
    // OpenCode can use several accounts, environment keys and free models. Installation is not
    // evidence of sign-in, and its CLI exposes no single account status for all of them.
    return { available: true, version, signed_in: null, models: ids.map((id) => ({ id, name: id })) }
  } catch {
    return { available: true, version, signed_in: null, models: [], error: 'OpenCode could not list models. Check `opencode models` in a terminal.' }
  }
}
