#!/usr/bin/env node
// A stand-in for the Codex CLI, as much of it as a browser sign-in uses: `--version`, and
// `app-server` answering initialize, model/list and account/login/start|cancel. How the sign-in
// ends comes from the file FAKE_CODEX_OUTCOME names: success, fail, or wait (for a cancel).
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  console.log('codex-cli 0.0.0-fake')
  process.exit(0)
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const outcome = () => {
  try {
    return readFileSync(process.env.FAKE_CODEX_OUTCOME, 'utf8').trim()
  } catch {
    return 'success'
  }
}
const loginId = '00000000-0000-4000-8000-000000000001'
const completed = (success, error = null) => send({ method: 'account/login/completed', params: { loginId, success, error, onboardingEntrypoint: null } })
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } })
  else if (m.method === 'model/list') send({ id: m.id, result: { data: [] } })
  else if (m.method === 'account/login/start') {
    send({ id: m.id, result: { type: 'chatgpt', loginId, authUrl: 'https://auth.openai.com/oauth/authorize?fake=1' } })
    const how = outcome()
    if (how === 'success') setTimeout(() => completed(true), 200)
    else if (how === 'fail') setTimeout(() => completed(false, 'Login server error: access denied'), 200)
  } else if (m.method === 'account/login/cancel') {
    send({ id: m.id, result: { status: 'canceled' } })
    completed(false, 'Login server error: Login was not completed')
  }
})
