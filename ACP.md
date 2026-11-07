# Agent sessions over ACP

Both session providers use the shared [ACP client](src/agentd/providers/acp.ts). The pinned
`@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` packages translate ACP
into each installed CLI's protocol. No adapter is downloaded when a session starts. Both providers
can keep warm processes. `agentd` still owns persistence, schedules, concurrency, cancellation,
secret redaction and worker cleanup. Existing harness names and provider session IDs are retained;
`session/load` resumes them without storing replayed history a second time.

The client maps streamed messages and tool updates into Lynx's existing events. Permission requests
use pending approvals; text and choice forms use pending questions. URL, secret and unsupported forms
are cancelled explicitly. Mode selection maps `ask`/`deny` to Claude's default mode or Codex's
read-only mode, `auto` to each agent's own reviewer, and `allow` to full access. In `deny`, Lynx rejects
permission requests without asking. A single approval never creates a persistent permission rule.
Missing modes, resume support, model/effort selectors or instruction support fail before prompting.
Session instructions use the negotiated ACP v1 draft `systemPrompt` capability; other traffic uses
ACP v1 methods. Adapter versions are pinned because this instruction capability is still a draft.

[Launch settings](src/agentd/providers/acp-launch.ts) keep connector grants separate from the user's
CLI configuration. Claude receives strict MCP settings, no user/project setting sources, the API
provider settings, and pre-approval only for declared read-only connector tools. Codex's configuration
is probed without starting a turn so every ungranted MCP server can be disabled with startup overrides.
Names outside `[a-zA-Z0-9_-]` are rejected because Codex's dotted override keys cannot safely address
them. Granted HTTP connectors go through ACP over stdin. Claude header values use environment references
so the upstream SDK cannot expose them in CLI arguments; Codex receives them in ACP messages.
The Electron bootstrap clears Node-mode variables before the adapter launches the provider.

Provider discovery, account sign-in, usage queries and voice text correction retain their existing
native integrations; ACP replaces session execution. There is no direct session fallback. The regular
`AGENT_CLAUDE_BIN` / `AGENT_CODEX_BIN` overrides still select the CLI. For adapter development,
`AGENT_CLAUDE_ACP_BIN` / `AGENT_CODEX_ACP_BIN` select an executable that speaks ACP on stdin/stdout.

`npm run test:acp` checks both provider entries through the real worker using a local ACP fixture and
MCP server. It covers warm turns, resume, settings, connector grants, redaction, all permission modes,
questions, failures and cancellation. `npm run test:acp:live` sends short prompts through the installed,
signed-in agents to check new sessions, warm turns, model/effort selection and resume. It uses model
quota and an isolated temporary working directory. `npm run check` includes the deterministic suite.
