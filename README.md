# nanokernel

> A lightweight, config-driven AI agent kernel — a tiny microkernel plus pluggable packs that runs well on **small, short-context models (4–8k)**.

[![CI](https://github.com/nanokernel-ai/nanokernel/actions/workflows/ci.yml/badge.svg)](https://github.com/nanokernel-ai/nanokernel/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](./LICENSE)

## Why

Most agent platforms push everything into the LLM — persona, knowledge, history, tools — and need a large, expensive, long-context model to cope. **nanokernel** takes the opposite bet: a deterministic core does the heavy lifting (fast snippet replies → finite-state scripts → retrieval → typed skills), so the model only fills the gaps. The result is an agent that behaves well on small, cheap, local models.

The moat isn't the model — it's the orchestration that lets a weak model act smart.

## Architecture: a microkernel + packs

The **kernel** is domain- and language-agnostic. Everything specific to a use case lives in a **pack** loaded through configuration:

```
kernel (engine)        packs (pluggable, config-loaded)
─────────────────      ──────────────────────────────────
dialog orchestration   channel packs   (Telegram, WhatsApp, …)
scripts / FSM          skill packs     (booking, lookup, CRM, …)
snippets               language packs  (safety keywords, intents, …)
rag (local embeddings) verticals       (salon, sales, support, …)
safety pipeline
llm abstraction
skills contract
config schema (v2)
```

A new bot is a JSON config, not a code change.

## Tech stack

NestJS 11 · TypeScript (strict) · Prisma/PostgreSQL · Redis + BullMQ (optional) · local embeddings (Xenova) + sqlite-vec · OpenAI-compatible LLM endpoint (LM Studio, Ollama, llama.cpp, …).

## Quickstart

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env        # set DATABASE_URL, LLM_BASE_URL, bot token, …

# 3. Infra (Postgres + Redis)
npm run db:up
npm run prisma:migrate

# 4. Run
npm run start:dev
```

Point a Telegram webhook at the running instance:

```bash
npm run telegram:webhook:set
```

### Configuration

A bot is a single JSON file under `config/<id>/configuration.json`, discovered at startup. To create one, copy the annotated template:

```bash
cp config/example/configuration.example.json config/my-bot/configuration.json
```

The template ([config/example/configuration.example.json](config/example/configuration.example.json)) is a complete, valid BotConfig v2 — persona, business facts, guardrails (rate/burst/repeat limits), snippet replies, a booking finite-state script, and LLM settings. Secrets are never stored in the JSON: channel tokens and API keys are referenced by environment-variable name (`tokenEnv`, `apiKeyEnv`). The `.example.json` suffix keeps the template from being auto-loaded — rename to `configuration.json` to activate.

## Status

Pre-1.0. The engine is functional; the kernel/pack boundary and a test suite are actively being hardened for public use. See the issue tracker for the roadmap.

## License

**[AGPL-3.0-only](./LICENSE).** You may use, modify, and self-host freely; if you run a modified version as a network service, you must publish your source under the same license.

**Commercial license available.** If AGPL's copyleft doesn't fit your product, a commercial license is offered — open an issue or contact the maintainer.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Contributions are accepted under the Developer Certificate of Origin (a `Signed-off-by` line on each commit).
