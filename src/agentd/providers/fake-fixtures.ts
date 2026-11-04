import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { Emit } from './types'

// Called only from the explicitly enabled fake harness.
export async function fakeFixture(prompt: string, emit: Emit, secrets: string[] = []) {
  if (!prompt.startsWith('fixture:')) return false
  const write = async (data: string | Buffer) => {
    if (!process.stdout.write(data)) await once(process.stdout, 'drain')
  }
  const complete = () =>
    emit({ type: 'agent_completed', payload: { success: true, result: { text: 'done' } } })
  // Transcript fixtures exercise host-owned cards without a paid model or exposing credentials.
  if (prompt.startsWith('fixture:marketplace:')) {
    const stage = prompt.slice('fixture:marketplace:'.length)
    const name = stage ? 'marketplace_submit' : 'marketplace_account'
    const id = `marketplace-${Date.now()}`
    await emit({ type: 'tool_invocation', payload: { id, name: `mcp__connection_app__${name}`, input: stage ? { stage } : {} } })
    await emit({ type: 'tool_result', payload: { id, output: JSON.stringify(stage ? { id: stage, status: 'ready' } : { configured: true, ready: false }), is_error: false } })
    await emit({ type: 'assistant_message', payload: { text: 'Use the marketplace card to continue.' } })
    await complete()
    return true
  }
  switch (prompt) {
    case 'fixture:secret-output': {
      const secret = secrets[0]
      if (!secret) throw new Error('Fixture requires a connection token')
      // Deliberately bypass emit's structured redaction, as provider diagnostics can.
      const event =
        JSON.stringify({ type: 'assistant_message', payload: { text: secret }, text: secret }) + '\n'
      for (const byte of Buffer.from(event)) await write(Buffer.from([byte]))
      process.stderr.write(secret.slice(0, 9))
      await delay(30)
      process.stderr.write(secret.slice(9))
      await complete()
      break
    }
    case 'fixture:history':
      for (let index = 0; index < 120; index++) {
        const text = `History boundary message ${index}`
        await emit({ type: 'assistant_message', payload: { text }, text })
      }
      await complete()
      break
    case 'fixture:oversized':
      await emit({ type: 'assistant_message', payload: { text: 'x'.repeat(2 * 1024 * 1024) } })
      await complete()
      break
    case 'fixture:large': {
      const text = 'payload ✓ '.repeat(30000)
      await emit({ type: 'assistant_message', payload: { text }, text })
      await emit({ type: 'agent_completed', payload: { success: true, result: { text } } })
      break
    }
    case 'fixture:split': {
      const bytes = Buffer.from(
        JSON.stringify({
          type: 'assistant_message',
          payload: { text: 'split ✓ line' },
          text: 'split ✓ line',
        }) + '\n',
      )
      const split = bytes.indexOf(Buffer.from('✓')) + 1
      await write(bytes.subarray(0, split))
      await delay(30)
      await write(bytes.subarray(split))
      await complete()
      break
    }
    case 'fixture:malformed':
      await write('this is not JSON\nnull\n')
      await complete()
      break
    case 'fixture:invalid-completion':
      await write('{"type":"agent_completed","payload":{"success":"true"}}\n')
      break
    case 'fixture:duplicate-completion':
      await complete()
      await complete()
      break
    case 'fixture:fragment':
      await write('{"type":"assistant_message","payload":')
      break
    case 'fixture:exit-when-idle':
      await complete()
      break
    case 'fixture:secret-cut': {
      const secret = secrets[0]
      if (!secret) throw new Error('Fixture requires a connection token')
      // A diagnostic that stops partway into a secret, and the run ends before its line does.
      process.stderr.write(`\ndiagnostic ${secret.slice(0, 14)}`)
      await delay(30)
      await complete()
      // The line goes on after the run has ended.
      setTimeout(() => process.stderr.write(`${secret.slice(14)} and more\n`), 300)
      break
    }
    case 'fixture:partial-stderr':
      process.stderr.write('unfinished diagnostic')
      await delay(30)
      await complete()
      // The line goes on after the run has ended.
      setTimeout(() => process.stderr.write(' continued later\n'), 300)
      break
    case 'fixture:exit-holding-pipes': {
      // The worker exits while something it started still holds its output open.
      const { spawn } = await import('node:child_process')
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
      await complete()
      setTimeout(() => process.exit(0), 50)
      break
    }
    case 'fixture:fragment-secret': {
      const secret = secrets[0]
      if (!secret) throw new Error('Fixture requires a connection token')
      // An unfinished line whose shortened copy ends partway into a secret, then the worker dies.
      await write('{"type":"assistant_message","payload":"' + 'x'.repeat(3990 - 38) + secret)
      process.exit(1)
      break
    }
    case 'fixture:oversized-secret': {
      const secret = secrets[0]
      if (!secret) throw new Error('Fixture requires a connection token')
      // A line too long to keep, whose preview ends partway into a secret.
      await write('x'.repeat(1018) + secret + 'x'.repeat(9 * 1024 * 1024) + '\n')
      await complete()
      break
    }
    case 'fixture:auth-failure':
      // As Claude Code ends a turn it is not signed in for.
      await emit({ type: 'agent_completed', payload: { success: false, error: { code: 'auth', message: 'Not logged in · Please run /login' } } })
      break
    case 'fixture:missing-completion':
      await emit({ type: 'assistant_message', payload: { text: 'no completion' } })
      break
    default:
      throw new Error('Unknown fake fixture')
  }
  return true
}
