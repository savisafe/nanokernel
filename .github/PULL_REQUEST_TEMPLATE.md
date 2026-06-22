<!-- Thanks for contributing to nanokernel! -->

## What & why

<!-- What does this change do, and why is it needed? Link the related issue. -->

Closes #

## Checklist

- [ ] `npm run format:check && npm run lint && npm run typecheck && npm run build` pass locally
- [ ] No business/user data, real configs, or secrets are committed
- [ ] No vendor-, language-, or domain-specific logic added to kernel modules (`src/modules/{dialog,scripts,llm,safety,rag,...}`) — such logic lives in a pack
- [ ] Commits are signed off (DCO): `git commit -s`
- [ ] Tests added/updated where applicable
