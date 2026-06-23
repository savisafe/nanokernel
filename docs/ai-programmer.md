<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# AI-programmer agent

A first non-salon agent that demonstrates the skill platform: it reads code, runs
commands and edits files through a **custom MCP server** (`packs/dev`), driven over
a plain **HTTP channel** (no Telegram/WhatsApp needed).

It is built entirely from existing seams — see [docs/skills-and-mcp.md](./skills-and-mcp.md)
for the platform itself.

## The `dev` MCP server (`packs/dev`)

A standalone [MCP](https://modelcontextprotocol.io) server
([`packs/dev/index.mjs`](../packs/dev/index.mjs)) exposing developer tools:

| Tool          | Capability     | Notes                              |
| ------------- | -------------- | ---------------------------------- |
| `list_dir`    | read           | list a directory                   |
| `read_file`   | read           | read a UTF-8 file (≤200 KB)        |
| `search_code` | read           | substring search across text files |
| `git_status`  | read           | `git status` of the workspace      |
| `write_file`  | write          | create/overwrite a file            |
| `run_shell`   | write, network | run a shell command (30s timeout)  |

**Jail:** every file and shell operation is confined to a workspace root
(`DEV_WORKSPACE_ROOT`, default: process cwd). Paths that escape the jail are
rejected. The server is declared `trust: "third-party"`, and its write/network
tools are gated by the bot's `allowedSkillTrust` / `allowedCapabilities` — a
deployment must explicitly opt in.

Because it is a standard MCP server, it also works in any other MCP client.

## The agent config

[`config/ai-programmer/configuration.json`](../config/ai-programmer/configuration.json)
selects the dev tools and grants the matching policy:

```jsonc
{
  "skills": [
    "mcp:dev:list_dir",
    "mcp:dev:read_file",
    "mcp:dev:write_file",
    "mcp:dev:run_shell",
    "mcp:dev:search_code",
    "mcp:dev:git_status",
  ],
  "guardrails": {
    "allowedSkillTrust": ["builtin", "third-party"],
    "allowedCapabilities": ["read", "write", "network"],
  },
  "llm": { "toolCalling": "auto" },
}
```

The dev server is registered in [`config/mcp.json`](../config/mcp.json).

## The HTTP channel

[`src/modules/http-channel/`](../src/modules/http-channel/) implements the standard
`ChannelAdapter` contract, so the same dialog/skill pipeline runs without a
messenger. One synchronous endpoint:

```
POST /channels/http/message
Content-Type: application/json
{ "sessionId": "s1", "text": "list the files in src/modules" }

→ { "reply": "..." }
```

`sessionId` keys the conversation (history, rate-limits); `text` is the user
message. The request is processed synchronously and the reply is returned in the
HTTP response (no Redis/queue required).

Example:

```bash
curl -s localhost:3000/channels/http/message \
  -H 'content-type: application/json' \
  -d '{"sessionId":"s1","text":"run: node -v"}'
```

## Running it

The agent loop needs the same infrastructure as any nanokernel bot — Postgres
(Prisma), Redis (BullMQ), and an OpenAI-compatible LLM endpoint with tool-calling
(e.g. a local Ollama). Minimal `.env`:

```bash
BOT_CONFIGURATION=ai-programmer
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nanokernel?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
LLM_ENABLED=true
LLM_BASE_URL=http://127.0.0.1:11434/v1   # Ollama, or any OpenAI-compatible API
LLM_MODEL=llama3:latest
DEV_WORKSPACE_ROOT=/abs/path/to/the/repo/the/agent/should/work/in
```

```bash
npm run db:up        # postgres + redis via docker compose
npm run prisma:migrate
npm run build && npm start
# then POST to /channels/http/message
```

On boot you should see the MCP server connect and its tools register:

```
[McpClientService] MCP server "dev" connected: 6 tools
[SkillsRegistry]  Registered skills: …, mcp:dev:list_dir, mcp:dev:run_shell, …
```

## Verifying without a live LLM

[`src/modules/mcp/mcp-integration.spec.ts`](../src/modules/mcp/mcp-integration.spec.ts)
boots the real `dev` MCP server over stdio and runs its tools through the registry
with the `ai-programmer` policy (allowlist + trust + capability), proving the whole
chain end-to-end except the LLM's tool choice:

```bash
npx vitest run src/modules/mcp/mcp-integration.spec.ts
```
