<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Skills & MCP

nanokernel agents act through **skills** — typed tools the LLM (or an FSM script)
can call. Skills come from two places:

1. **Built-in skills** — shipped in this repo as NestJS providers (e.g. the salon
   `booking` skills under `src/modules/skills/skills/`).
2. **External skills via MCP** — any [Model Context Protocol](https://modelcontextprotocol.io)
   server. Each MCP tool is wrapped as a skill automatically. This is how you plug
   in **ready-made skill libraries** (filesystem, git, github, fetch, databases, …)
   or your **own custom MCP servers**, without changing kernel code.

Both sources flow into the same `SkillsRegistry`, so the per-bot allowlist, trust
gating, capability gating, FSM dispatch and LLM tool-calling work identically for
either.

## The skill contract

A skill is `{ name, description, parameters (JSON Schema), execute(args, ctx) }`
plus security metadata (`trust`, `capabilities`) — see
[`skill.contract.ts`](../src/modules/skills/skill.contract.ts). This is exactly the
shape of an OpenAI-style tool and of an MCP tool, which is why MCP tools map onto
skills one-to-one.

## Configuring MCP servers — `config/mcp.json`

The platform connects to the MCP servers listed here at startup, lists their
tools, and registers each tool as a skill named **`mcp:<server>:<tool>`**.

```jsonc
{
  "mcpServers": {
    // stdio server (local subprocess) — e.g. this repo's custom dev pack:
    "dev": {
      "command": "node",
      "args": ["packs/dev/index.mjs"],
      "trust": "third-party",
    },

    // a ready-made public server (no code to write):
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
      "trust": "third-party",
    },

    // remote server over Streamable HTTP:
    "search": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${TOKEN}" },
      "trust": "third-party",
    },
  },
}
```

Field reference (`src/modules/mcp/mcp-servers.types.ts`):

| Field                           | Applies to | Meaning                                                                                                                                                                   |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`, `args`, `env`, `cwd` | stdio      | how to spawn the server process                                                                                                                                           |
| `url`, `headers`                | remote     | Streamable HTTP endpoint                                                                                                                                                  |
| `trust`                         | both       | `builtin` \| `community` \| `third-party` (default `third-party`). Stamped onto every skill from this server.                                                             |
| `capabilities`                  | both       | Override the capabilities of this server's skills. If omitted, capabilities are derived per-tool from MCP annotations (`readOnlyHint`/`destructiveHint`/`openWorldHint`). |
| `startupTimeoutMs`              | both       | connect + tools/list timeout (default 15000).                                                                                                                             |
| `disabled`                      | both       | skip this server without removing it.                                                                                                                                     |

A missing or unreachable server is logged and skipped — it never blocks boot.
`MCP_CONFIG` (env) overrides the config path.

## Selecting skills per agent

In a bot config (`config/<id>/configuration.json`), `skills` is an allowlist of
skill names; `guardrails` adds defense-in-depth:

```jsonc
{
  "skills": ["mcp:dev:read_file", "mcp:dev:run_shell"],
  "guardrails": {
    "allowedSkillTrust": ["builtin", "third-party"], // origin policy
    "allowedCapabilities": ["read", "write", "network"], // capability policy
  },
}
```

Enforcement happens in `SkillsRegistry.makeDispatcher`
([`skills-registry.service.ts`](../src/modules/skills/skills-registry.service.ts)):
a tool call is executed only if the skill is in the bot's allowlist **and** its
trust is allowed **and** all of its capabilities are allowed. A blocked call
returns `{ error }` to the model (it can apologise) instead of throwing. Because
the loader stamps `trust`/`capabilities` from configuration, server code cannot
escalate its own privileges.

## Writing your own MCP server (pack)

Author a standalone MCP server with `@modelcontextprotocol/sdk` and register it in
`config/mcp.json`. It is then reusable in any MCP client (Claude Desktop, Cursor,
IDEs), not just nanokernel. See [`packs/dev/index.mjs`](../packs/dev/index.mjs) for
a complete example and [docs/ai-programmer.md](./ai-programmer.md) for how it is
used.
