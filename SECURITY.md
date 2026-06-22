# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via [GitHub Security Advisories](https://github.com/nanokernel-ai/nanokernel/security/advisories/new), or contact the maintainer directly. You will receive an acknowledgement as soon as possible, and we will work with you on a coordinated disclosure.

## Scope & handling notes

nanokernel processes untrusted input from public chat channels and talks to external services. When reporting or reviewing, pay particular attention to:

- **Secrets handling** — channel webhook secrets, HMAC signing keys, LLM and CRM tokens must never be logged or echoed back to users.
- **Webhook authenticity** — Telegram secret-token and WhatsApp `X-Hub-Signature-256` verification.
- **Prompt/command injection** — the safety pipeline (input filtering, injection patterns) is a security boundary.
- **Local data** — bot configurations and knowledge documents are git-ignored and must stay out of the published repository.

## Supported versions

This project is pre-1.0; only the latest `main` is supported with security fixes.
