# OpenCode

This provider uses the installed `opencode serve` command and the official
[`@opencode-ai/sdk`](https://opencode.ai/docs/sdk/) HTTP/SSE client. It does not
use ACP or change the Claude Code and Codex adapters. Tested with OpenCode 1.18.0;
the SDK is pinned to that version.

Install OpenCode, configure a model provider with `opencode auth login` or its
normal provider configuration, then select OpenCode in Lynx. Model IDs come from
`opencode models`. `AGENT_OPENCODE_BIN` can select a different executable.
OpenCode has several account types, so discovery does not claim that installing
it proves that an account is signed in.

Each message starts a local server and resumes the saved session ID. The server
stops when the message ends or is cancelled. Current instructions, model,
permissions and connector grants apply on each message. This costs startup time
but avoids a second persistent worker lifecycle.

The adapter supports streaming text, tool cards, approvals, questions, session
resume and the deny, ask and allow permission modes. Auto review is not offered.
Read-only connector tools can run without approval; other connector calls follow
the selected mode. Subagents and plan transitions are disabled so they cannot
change the session's permission policy.

Provider settings and existing OpenCode accounts remain available. Lynx writes
a temporary configuration that disables personal MCP servers, agents and plugins,
and checks the resolved configuration before starting. Conflicting managed
settings fail the run. Connector headers are sent through the authenticated
localhost API, not through command arguments, environment variables or config
files. A small local plugin removes the API server password from shell tool
environments. Its config directory is read-only to avoid dependency installation
for this dependency-free hook. Temporary configuration is removed on exit.
These controls are permission integration, not an OS sandbox.

## Verification

- `npm run check`: type checks, unit tests, agent tests, native API fixtures and build.
- `npm run test:opencode:native`: installed CLI with temporary state, fake keys,
  and local synthetic model/MCP servers. Tests instructions, connector reads,
  write approvals, permission modes, model changes, resume, revoked grants and
  the shell environment. No model account or external model request is needed.
- Run `scripts/opencode-smoke.mjs --built` with Electron's Node mode after the
  build to check the shipped provider chunk.
