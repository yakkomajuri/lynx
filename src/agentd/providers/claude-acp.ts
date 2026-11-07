// The upstream ACP server with one credential-handling fix. All protocol and agent execution
// remain upstream; connector headers reach Claude only through the SDK control channel.
import { acpProtocolRouter } from '@agentclientprotocol/claude-agent-acp/dist/serve.js'
import { applyManagedPolicyEnv } from '@agentclientprotocol/claude-agent-acp/dist/managed-policy.js'
import { nodeToWebReadable, nodeToWebWritable, type ClaudeAcpAgent } from '@agentclientprotocol/claude-agent-acp'
import { ndJsonStream } from '@agentclientprotocol/sdk/experimental/v2'
import { privateClaudeConnectors } from './claude-acp-connectors'

await applyManagedPolicyEnv()
console.log = console.info = console.warn = console.debug = console.error
let adapter: ClaudeAcpAgent | undefined
const connection = acpProtocolRouter(undefined, (created) => {
  privateClaudeConnectors(created)
  adapter = created
}, 'v1').connect(ndJsonStream(nodeToWebWritable(process.stdout), nodeToWebReadable(process.stdin)))
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await adapter?.dispose().catch((error) => console.error('Claude ACP cleanup failed:', error))
  process.exit(0)
}
void connection.closed.then(stop)
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
process.stdin.resume()
