# Agent sessions over ACP

Both session providers use the shared [ACP client](src/agentd/providers/acp.ts). The pinned
`@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp` packages translate ACP
into each installed CLI's protocol. No adapter is downloaded when a session starts. Both providers
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
Session instructions use the negotiated ACP v1 draft `systemPrompt` capability; other traffic uses
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

`npm run test:acp` checks both provider entries through the real worker using a local ACP fixture and
MCP server. It covers warm turns, connector revocation and credential rotation through the runner,
permission mode restoration, private Claude connector registration, resume, settings, connector grants,
redaction, all permission modes, questions, failures and cancellation. `npm run test:acp:live` sends short prompts through the installed,
signed-in agents to check that Claude CLI arguments and environment have no connector credentials,
authenticated connectors, new sessions, warm turns, model/effort selection and resume. It uses model
quota and an isolated temporary working directory. `npm run check` includes the deterministic suite.

## Pi

Pi uses the published `pi-acp` adapter, pinned to 0.0.34. Install Pi 1.5.0 or newer
(`npm install -g @earendil-works/pi-coding-agent`), run `pi` and use `/login` to
configure an account. `AGENT_PI_BIN` can select a different Pi executable.
This launch integration supports macOS and Linux. Model discovery uses Pi's
metadata-only RPC request, with no model prompt.

The [upstream adapter](https://github.com/svkozak/pi-acp#limitations) does not wire
client MCP servers into Pi and has no ACP approval bridge. Lynx therefore offers
Pi for local-file work, with read-only and full-access permission modes. The UI
labels this restriction; automatic connector assignment skips providers without
connector support, and the backend rejects explicit grants. Pi cannot run Lynx
workspace-building or connector workflows. It is not an onboarding agent.

Read-only sessions start Pi with `read,grep,find,ls`; full-access sessions also get
`bash,edit,write`. Personal extensions, skills, prompt templates and native MCP
servers are disabled in both modes. Session instructions use Pi's append-system-
prompt flag. Temporary launch files are removed when the adapter exits. This
limits the available tools; it does not create an OS sandbox.

Streaming, tool cards, warm turns, resume, model selection, thinking settings and
cancellation use the shared ACP code. Pi's ACP modes describe thinking effort,
so the shared client does not mistake them for permission modes. ACP session IDs
are adapter IDs; use Pi's own session picker to continue in its terminal UI.

`npm run test:acp` covers the shared transport and capability refusals.
`npm run test:pi` tests the real adapter and an installed Pi against a local fake
model with isolated state. It checks discovery, instructions, actual file reads,
refused writes in read-only mode, full-access writes, warm model changes, resume
and cancellation. `AGENT_PI_BIN` selects the tested install. After building, run
`scripts/pi-smoke.mjs --built` under Electron's Node mode to test the shipped chunk.
