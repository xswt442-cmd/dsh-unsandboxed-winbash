# Agent guide

`dsh-unsandboxed-winbash` is a Windows-only DSH host plugin: it adds a `winbash` tool that runs commands through Git for Windows bash outside the file sandbox, because MSYS cannot start under an ACL-restricted token.

## Engineering

- Keep `README.md` / `README.en.md` and `docs/CHANGELOG.md` / `docs/CHANGELOG.en.md` in step. `npm run docs:check` is this repository's own `scripts/check-docs.mjs`; the pairs live in its `pairs` constant, so a document move is an edit there.
- Keep the tool id and name `winbash`; renaming it invalidates every prompt and transcript that refers to it.
- Keep `windowsHide: true` on the spawn. The tool runs outside the file sandbox by design; do not add a `sandbox_permissions` escalation surface.
- Discover the executable from the well-known Git for Windows locations, never through PATH. `DSH_TEST_BASH` is an e2e-only knob read by `test/e2e/`, never by `lib/`.
- The suite has two layers and `test/unit/layout.test.mjs` enforces them: `test/unit/*.test.mjs` (no spawned process) and `test/e2e/*.test.mjs` (real Git Bash). Seams such as `deps.spawn` exist so the kill policy can be asserted without a machine.
- This repository depends on no sibling package and embeds no shared source fragment. Keep it that way: a documentation lint is not a reason to install from outside.

## Changelog

- One bullet per shipped change, at most two short sentences, in the README's register: no implementation narrative, no root-cause essay, no conversational verbs or emphasis quotes.
- `Unreleased` is for changes a user would notice; deferred work belongs in a handoff note.
- Do not name another repository.

## Releases

Maintainers commit straight to `dev` and fast-forward `main`; CI still runs when an outside pull request arrives. `docs/RELEASING.md` is the runbook; `scripts/release-notes.mjs` cuts release notes from `docs/CHANGELOG.md`.

## Verify

```sh
npm test          # pure units; no process is spawned
npm run test:e2e  # spawns Git Bash; needs an unsandboxed shell
npm run docs:check
for f in lib/index.js lib/tool/index.js lib/tool/exec.js lib/tool/kit.js; do node --check "$f"; done
npm pack --dry-run
```

## Scope

- Change only what the task requires. Keep tracked files self-contained: no personal paths, credentials, or one-off logs. Git operations beyond the current task need explicit authorization.
