import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { AgentSpec } from './types'
import type { Session, SessionIO } from './registry'

/** The test harness: deterministic replies, fixtures for the worker's edge cases. Only when AGENT_ENABLE_FAKE=1. */
export function fakeSession({ emit, signal, ask, secrets }: SessionIO): Session {
  let turns = 0
  let gone: () => void = () => {}
  const closed = new Promise<void>((r) => (gone = r))
  async function turn(spec: AgentSpec) {
    await emit({ type: 'provider_session', payload: { id: spec.provider_session_id ?? randomUUID() } })
    if (spec.prompt === 'fixture:exit-when-idle') setTimeout(gone, 50)
    if (spec.prompt === 'fixture:marketplace:') {
      const connection = spec.connections?.find((c) => new URL(c.url).pathname === '/mcp/app')
      if (!connection) throw new Error('The publishing session did not receive the app connector')
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const client = new Client({ name: 'publishing-fixture', version: '1' })
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }))
        const { tools } = await client.listTools()
        if (!tools.some((t) => t.name === 'marketplace_account')) throw new Error('marketplace_account is missing from the real MCP tool list')
        if (tools.some((t) => t.name === 'marketplace_login' || t.name === 'marketplace_upload')) throw new Error('Private marketplace actions leaked into the agent tool list')
        const id = `account-${Date.now()}`
        await emit({ type: 'tool_invocation', payload: { id, name: 'mcp__connection_app__marketplace_account', input: {} } })
        const output = await client.callTool({ name: 'marketplace_account', arguments: {} })
        await emit({ type: 'tool_result', payload: { id, output, is_error: !!output.isError } })
        await emit({ type: 'assistant_message', payload: { text: 'Use the marketplace card to continue.' }, text: 'Use the marketplace card to continue.' })
        await emit({ type: 'agent_completed', payload: { success: true } })
      } finally { await client.close() }
      return
    }
    if (spec.config.instructions?.includes('You are reviewing a Lynx marketplace template')) {
      if (spec.connections?.length || spec.config.permission_mode !== 'deny') throw new Error('Security review received write access or connectors')
      const text = spec.prompt.includes('Unsafe review fixture') ? '**My assessment:** **Appears unsafe to install**. It sends private data to an unrelated address.' : '**My assessment:** **Most likely safe to install**. No unexpected actions were found.'
      await emit({ type: 'assistant_message', payload: { text }, text })
      await emit({ type: 'agent_completed', payload: { success: true } })
      return
    }
    const { fakeFixture } = await import('./fake-fixtures')
    if (await fakeFixture(spec.prompt, emit, secrets())) return
    if (spec.prompt.startsWith('read attachments')) {
      const { readFile } = await import('node:fs/promises')
      await emit({
        type: 'test_attachments',
        payload: await Promise.all(
          (spec.attachments ?? []).map(async (a) => ({
            name: a.name,
            data: (await readFile(a.path)).toString('base64'),
          })),
        ),
      })
    }
    if (spec.config.permission_mode === 'ask') {
      const response = await ask(
        spec.prompt.includes('question') ? 'questions' : 'approval',
        spec.prompt.includes('question')
          ? {
              provider: 'fake',
              questions: [
                {
                  id: 'format',
                  question: 'Which report format?',
                  options: ['short', 'long'],
                  allow_other: false,
                },
              ],
            }
          : spec.prompt.includes('long input')
            ? // More than a history page keeps of an event, as a file of some size to write.
              { provider: 'fake', tool_name: 'Write', tool_input: { file_path: `${spec.cwd}/notes.md`, content: 'A line of the notes to write. '.repeat(400) } }
            : spec.prompt.includes('command')
            ? // Shaped like Codex's request to run a command, so clients can show one.
              { provider: 'fake', method: 'item/commandExecution/requestApproval', detail: { command: 'npm test', cwd: spec.cwd, reason: 'Run the tests to check the change' } }
            : { provider: 'fake', tool_name: 'test_tool', tool_input: {} },
      )
      await emit({ type: 'test_input_result', payload: response })
    }
    if (spec.prompt.includes('connector')) {
      const connection = spec.connections?.[0]
      if (!connection) throw new Error('No connection granted')
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
      const { StreamableHTTPClientTransport } =
        await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
      const client = new Client({ name: 'fake-agent', version: '1' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(connection.url), {
            requestInit: { headers: connection.headers },
          }),
        )
        const listed = await client.listTools()
        const result = await client.callTool({ name: listed.tools[0]!.name, arguments: {} })
        await emit({
          type: 'connector_result',
          payload: {
            result,
            service_credentials_inherited: !!process.env.AGENTD_TOKEN,
          },
          text: JSON.stringify(result),
        })
      } finally {
        await client.close()
      }
    }
    // 'linger' keeps it working until cancelled (ten minutes at most): something to see in the list of agents running.
    await delay(spec.prompt.includes('linger') ? 600000 : spec.prompt.includes('slow') ? 1500 : 30, undefined, { signal })
    const id = `tool-${turns + 1}`
    await emit({ type: 'tool_invocation', payload: { id, kind: 'other', name: 'test_tool', input: {} } })
    await emit({
      type: 'tool_result',
      payload: { id, output: 'deterministic result', is_error: false },
      text: 'deterministic result',
    })
    await emit({
      type: 'assistant_message',
      payload: { text: `Reply: ${spec.prompt}`, resumed: !!spec.provider_session_id, turn: (turns += 1) },
      text: `Reply: ${spec.prompt}`,
    })
    await emit({
      type: 'agent_completed',
      payload: { success: true, result: { text: `Reply: ${spec.prompt}` } },
    })
  }
  return { turn, close: () => {}, closed }
}
