#!/usr/bin/env node
// Pi's metadata-only RPC surface for backend capability tests.
import { createInterface } from 'node:readline'
if (process.argv.includes('--version')) console.log('1.5.0')
else createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data: { models: [{ provider: 'fixture', id: 'model-a', name: 'Model A' }] } }) + '\n')
})
