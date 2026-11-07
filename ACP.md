# Agent sessions over ACP

All three session providers use the shared [ACP client](src/agentd/providers/acp.ts). The pinned
`@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` packages translate ACP
into each installed CLI's protocol. No adapter is downloaded when a session starts. All providers
can keep warm processes. A change to connector grants, URLs or headers retires the warm worker
before the next turn, which resumes with the new connector set. `agentd` still owns persistence,
schedules, concurrency, cancellation, secret redaction and worker cleanup. Existing harness names and provider session IDs are retained;
`session/load` resumes them without storing replayed history a second time.

The client maps streamed messages and tool updates into Lynx's existing events. Permission requests
use pending approvals; text and choice forms use pending questions. URL, secret and unsupported forms
are cancelled explicitly. Mode selection maps `ask`/`deny` to Claude's default mode or Codex's
read-only mode, `auto` to each agent's own reviewer, and `allow` to full access. In `deny`, Lynx rejects
permission requests without asking. A single approval never creates a persistent permission rule.
Agent mode changes are tracked, and each turn restores the session's configured permission mode.
Missing modes, resume support, model/effort selectors or instruction support fail before prompting.
Claude and Codex session instructions use the negotiated ACP v1 draft `systemPrompt` capability; other traffic uses
ACP v1 methods. Adapter versions are pinned because this instruction capability is still a draft.

[Launch settings](src/agentd/providers/acp-launch.ts) keep connector grants separate from the user's
CLI configuration. Claude receives strict MCP settings, no user/project setting sources, the API
provider settings, and pre-approval only for declared read-only connector tools. Codex's configuration
is probed without starting a turn so every ungranted MCP server can be disabled with startup overrides.
Names outside `[a-zA-Z0-9_-]` are rejected because Codex's dotted override keys cannot safely address
them. Granted HTTP connectors go through ACP over stdin. A local Claude ACP entry registers them
through the SDK control channel after query creation, keeping credentials out of CLI arguments and
environment variables. It intercepts the pinned adapter's internal `createSession` method so internal
query restarts also restore connectors through that channel. This compatibility seam must be checked
when upgrading the adapter. Codex receives headers in ACP messages.
The Electron bootstrap clears Node-mode variables before the adapter launches the provider.

Provider discovery, account sign-in, usage queries and voice text correction retain their existing
native integrations; ACP replaces session execution. There is no direct session fallback. The regular
`AGENT_CLAUDE_BIN` / `AGENT_CODEX_BIN` overrides still select the CLI. For adapter development,
`AGENT_CLAUDE_ACP_BIN` / `AGENT_CODEX_ACP_BIN` select an executable that speaks ACP on stdin/stdout.

`npm run test:acp` checks all provider entries through the real worker using a local ACP fixture and
MCP server. It covers warm turns, connector revocation and credential rotation through the runner,
permission mode restoration, private Claude connector registration, resume, settings, connector grants,
redaction, all permission modes, questions, failures and cancellation. `npm run test:acp:live` sends short prompts through the installed,
signed-in agents to check that Claude CLI arguments and environment have no connector credentials,
authenticated connectors, new sessions, warm turns, model/effort selection and resume. It uses model
quota and an isolated temporary working directory. `npm run check` includes the deterministic suite.

## OpenCode

OpenCode uses the installed [`opencode acp`](https://opencode.ai/docs/acp/) command directly
(tested with 1.18.0), selected with `AGENT_OPENCODE_BIN`. It supports model selection, warm turns,
resume, granted HTTP connectors and `deny`/`ask`/`allow`. There is no auto-review mode or ACP question
bridge, so those capabilities are not offered. MCP tools use the same connector cards as other agents.

OpenCode's ACP modes select agents. A temporary `lynx` agent supplies session instructions and
permission rules; ACP mode updates restore that agent at the next turn. The launcher keeps model
provider settings and the user's native authentication state, disables personal MCP servers, external
plugins, custom agents and subagent delegation, and checks the effective configuration before starting.
Conflicting managed or remote configuration fails startup. Declared read-only connector tools are
pre-approved; other tool requests follow Lynx's permission setting. Connector headers travel only over
ACP, never through environment variables or the temporary config file. The temporary config is removed
when the adapter exits. User configuration files are not changed.

`opencode models` supplies model IDs without claiming a single signed-in state across all providers.
Use the existing terminal sign-in flow (`opencode auth login`) for providers that need an account.
OpenCode does not add account usage reporting or voice text correction.

`npm run test:opencode` runs the installed OpenCode against local synthetic model and authenticated
MCP servers, with isolated account/config/database directories. It checks instructions, connector
cards, read-only pre-approval, all three permission modes, warm model changes and resume without a
model account or model quota. After `npm run build`, add `-- --built` to check the production bundle.
