import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface UpdateSignatures {
  requirement: (installed: string) => Promise<string>
  verify: (bundle: string, requirement: string) => Promise<void>
}

/** Trust comes from the installed app, never the feed or downloaded archive. */
export function updateSignatures(command: (args: string[]) => Promise<{ stderr: string }> = (args) => run('/usr/bin/codesign', args)): UpdateSignatures {
  const verify = async (bundle: string, requirement: string) => {
    try {
      await command(['--verify', '--deep', '--strict', '--test-requirement', `=${requirement}`, bundle])
    } catch {
      throw new Error('The app does not have a valid Developer ID signature from the installed publisher. Download a signed Lynx release from the official site.')
    }
  }
  return {
    verify,
    async requirement(installed) {
      const { stderr } = await command(['--display', '--verbose=4', installed])
      const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(stderr)?.[1]
      const id = /^Identifier=([A-Za-z0-9.-]+)$/m.exec(stderr)?.[1]
      if (!team || !id) throw new Error('Automatic updates require a Developer ID signed installation. Download and install a signed Lynx release manually.')
      // Apple-issued Developer ID Application certificate, from the same team and for the same app.
      // Reading TeamIdentifier alone is insufficient: an ad-hoc/self-signed signature can claim it.
      const requirement = `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}" and identifier "${id}"`
      await verify(installed, requirement)
      return requirement
    },
  }
}
