#!/usr/bin/env node
// A native HTTP/SSE server fixture; no installed CLI or model account is needed.
import assert from 'node:assert/strict'
import { readFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
const args = process.argv.slice(2)
const configuration = () => process.env.OPENCODE_CONFIG
  ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'))
  : { model: 'fixture/model-a', provider: {}, mcp: { personal: { type: 'remote', url: 'https://example.invalid', headers: { authorization: 'ungranted-secret' } } }, agent: { personal: { permission: 'allow' } } }
if (args.includes('--version')) console.log('1.18.0')
else if (args.includes('models')) console.log('fixture/model-a\nfixture/model-b\nfixture/model-a')
else if (args.includes('config')) {
  const config = configuration()
  if (process.env.OPENCODE_FIXTURE_CONFLICT && process.env.OPENCODE_CONFIG) config.mcp.personal = { enabled: true }
  console.log(JSON.stringify(config))
} else if (args.includes('serve')) {
  const config = configuration(), connections = {}, streams = new Set(), pending = new Map()
  assert.equal(config.mcp.personal.enabled, false)
  assert(!JSON.stringify(config).includes('ungranted-secret'))
  const hook = await import(config.plugin[0])
  const env = { env: {} }
  await (await hook.Lynx())['shell.env']({}, env)
  assert.equal(env.env.OPENCODE_SERVER_PASSWORD, '')
  const record = (data) => appendFileSync(process.env.OPENCODE_FIXTURE_LOG, JSON.stringify({ pid: process.pid, configPath: process.env.OPENCODE_CONFIG, ...data }) + '\n')
  const event = (type, properties) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`) }
  const ask = async (type, properties) => {
    const answer = new Promise((resolve) => pending.set(properties.id, resolve))
    event(type, properties)
    return await answer
  }
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Basic ${Buffer.from(`lynx:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`)
      const path = new URL(req.url, 'http://localhost').pathname
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
      if (path === '/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        streams.add(res); res.on('close', () => streams.delete(res))
        event('server.connected', {})
      } else if (path === '/mcp') {
        connections[body.name] = body.config
        json({ [body.name]: { status: process.env.OPENCODE_FIXTURE_MCP_FAIL ? 'failed' : 'connected' } })
      } else if (path === '/session' || (path === '/session/ses_fixture' && req.method === 'GET')) json({ id: 'ses_fixture' })
      else if (path === '/session/ses_fixture' && req.method === 'PATCH') { assert.deepEqual(body.permission, []); json({ id: 'ses_fixture' }) }
      else if (/\/(permission|question)\//.test(path)) { pending.get(path.split('/')[2])?.(body); json(true) }
      else if (path === '/session/ses_fixture/message') {
        record({ prompt: body, connections })
        const prompt = body.parts[0].text
        if (prompt === 'crash') { process.exit(1); return }
        if (prompt === 'cancel') return
        const sessionID = 'ses_fixture', messageID = 'msg_answer'
        const info = { id: messageID, sessionID, role: 'assistant', tokens: { input: 7, output: 3 }, cost: 0 }
        if (prompt === 'error') info.error = { name: 'APIError', data: { message: '429 rate limit' } }
        event('message.updated', { info: { id: 'msg_user', sessionID, role: 'user' } })
        event('message.part.updated', { part: { id: 'user', messageID: 'msg_user', sessionID, type: 'text', text: 'do not echo', time: { end: 1 } } })
        event('message.updated', { info })
        if (prompt === 'approval' || prompt === 'approval crash') {
          if (prompt === 'approval crash') setTimeout(() => process.exit(1), 200)
          const reply = await ask('permission.asked', { id: 'per_fixture', sessionID, permission: 'write', patterns: ['file.txt'], metadata: { path: 'file.txt' } })
          record({ approval: reply })
        }
        if (prompt === 'question') {
          const reply = await ask('question.asked', { id: 'que_fixture', sessionID, questions: [{ question: 'Which?', options: [{ label: 'one', description: 'first' }], custom: true }] })
          record({ question: reply })
        }
        const tool = { id: 'part_tool', sessionID, messageID, type: 'tool', callID: 'call_fixture', tool: 'connection_smoke_read', state: { status: 'running', input: {} } }
        event('message.part.updated', { part: tool })
        tool.state = { ...tool.state, status: 'completed', output: 'read result' }
        event('message.part.updated', { part: tool })
        event('message.part.delta', { sessionID, messageID, partID: 'part_text', field: 'text', delta: 'hello' })
        const text = { id: 'part_text', sessionID, messageID, type: 'text', text: 'hello', time: { end: 1 } }
        event('message.part.updated', { part: text })
        event('session.idle', { sessionID })
        json({ info, parts: [text, tool] })
      } else res.writeHead(404).end(path)
    } catch (error) { console.error(error); res.writeHead(500).end(String(error)) }
  })
  server.listen(0, '127.0.0.1', () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`))
} else process.exit(2)
