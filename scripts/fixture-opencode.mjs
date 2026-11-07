#!/usr/bin/env node
// Native OpenCode CLI fixture: configuration and model discovery, without user state.
import { readFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (args.includes('--version')) console.log('1.18.0')
else if (args.includes('models')) console.log('fixture/model-a\nfixture/model-b\nfixture/model-a')
else if (args.includes('config')) {
  const config = process.env.OPENCODE_CONFIG
    ? JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'))
    : { model: 'fixture/model-a', provider: {}, mcp: { personal: { type: 'remote', url: 'https://example.invalid', headers: { authorization: 'ungranted-secret' } } }, agent: { personal: { permission: 'allow' } } }
  if (process.env.OPENCODE_FIXTURE_CONFLICT && process.env.OPENCODE_CONFIG) config.mcp.personal = { enabled: true }
  console.log(JSON.stringify(config))
} else process.exit(2)
