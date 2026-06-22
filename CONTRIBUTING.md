# Contributing to nanokernel

Thanks for your interest in improving nanokernel. This guide covers how to get set up and the rules for contributions.

## Development setup

```bash
npm install
cp .env.example .env
npm run db:up
npm run prisma:migrate
npm run start:dev
```

Before opening a pull request, make sure these pass locally — CI runs the same:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
```

## Ground rules

- **Keep the kernel clean.** Code under `src/modules/{dialog,scripts,llm,safety,rag,snippets,skills,...}` must stay domain- and language-agnostic. Anything business-, vendor-, or language-specific belongs in a **pack** loaded via configuration — not hardcoded in the engine. PRs that add Cyrillic/English literals or a specific CRM into core modules will be asked to move that logic into a pack.
- **No user/business data.** Real bot configs and documents are git-ignored and must never be committed. Use sanitized examples.
- **Match the surrounding code.** Naming, comment density, and idioms should look like the file you're editing.

## Developer Certificate of Origin (DCO)

This project uses the [Developer Certificate of Origin](https://developertcertificate.org/). By signing off on your commits, you certify that you wrote the code or otherwise have the right to submit it under the project's license.

Add a `Signed-off-by` line to every commit:

```bash
git commit -s -m "your message"
```

This appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

> **Note on licensing.** nanokernel is AGPL-3.0 with the maintainer reserving the right to offer a commercial license. The DCO certifies your right to contribute under the project license; it does **not** by itself transfer copyright. If the project later adopts a Contributor License Agreement (CLA) to support dual-licensing, contributors will be notified before it applies.

## Pull requests

- One focused change per PR; describe the what and the why.
- Add or update tests for behavioral changes once the test suite lands.
- Link the related issue.
