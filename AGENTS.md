# Agent guide

`dsh-unsandboxed-winbash` is a Windows-only DSH host plugin: it adds a `winbash` tool that runs commands through Git for Windows bash outside the file sandbox, because MSYS cannot start under an ACL-restricted token.

## Engineering

- Keep `README.md` / `README.en.md` and `CHANGELOG.md` / `CHANGELOG.en.md` in sync.
- Keep the tool id and name `winbash`. Only the package is named after the property that matters; renaming the tool would invalidate every prompt and transcript that already refers to it.
- Keep `windowsHide: true` on the spawn: `CREATE_NO_WINDOW` is the whole reason no console window appears, and `test/unit/exec.test.mjs` guards it.
- The tool runs outside the file sandbox by design. Do not add a `sandbox_permissions` escalation surface: there is nothing to escalate from, and the tool description states the boundary. `test/unit/tool.test.mjs` pins the registered parameter list, so a new knob has to be a deliberate edit.
- The executable is discovered from the well-known Git for Windows locations, never through PATH, where `bash` is the WSL shim. `DSH_TEST_BASH` is an e2e-only knob: `test/e2e/` reads it to choose which bash it spawns, and nothing under `lib/` does.
- The suite has two layers and `test/unit/layout.test.mjs` enforces them: `test/unit/*.test.mjs` is `npm test` (pure units — no process is spawned, no Git for Windows is needed) and `test/e2e/*.test.mjs` is `npm run test:e2e` (real Git Bash, so an unsandboxed shell). A test file anywhere else under `test/` is collected by neither script, which is the hole that guard closes.
- The executor's seams (`deps.spawn`, `deps.spawnSync`, `deps.exists`, `deps.platform`, `deps.scrubbedParentEnv`) exist so the kill policy can be asserted without a machine; a test that reaches a real spawn belongs in `test/e2e/`.
- This repository depends on no sibling package. It embeds no shared source fragment, so the bilingual docs check is its own `scripts/check-docs.mjs`: `npm run docs:check` has to work from a bare checkout, and a documentation lint is not a reason to install something from outside.
- This repo is an npm package: a release is a version bump, the two changelogs, and a `vX.Y.Z` tag on `main`. Read `RELEASING.md` only when publishing.

## Changelog

- `CHANGELOG.md` and `CHANGELOG.en.md` stay in step: the same sections, the same number of bullets, the same order.
- One bullet per change — what changed and why it matters, in at most two short sentences — counting prose, not the inline code identifiers a bullet names (roughly 120 CJK characters or 240 letters of it, and a whole version section stays under about 900 CJK characters). A version section is published verbatim as the GitHub release notes, so its reader is someone installing this tool, not its historian.
- No implementation narrative and no root-cause essay. "It used to do X, which was wrong because Y, so now Z" is one bullet about Z; the rest belongs in the commit message or a handoff note. A bullet that needs a subordinate clause to justify itself has one clause too many.
- `Unreleased` records what a reader other than the author would notice. Deferred work and "X was left alone because it needs a product call" are handoff notes, not changelog entries — the DSH floor question in particular does not belong here.
- Do not name another repository. The test is a reader who cloned only this one: a sentence that only parses if they also know what a sibling checkout does cannot be verified and adds nothing — state what this repository does.

## Verify

```sh
npm test          # pure units; no process is spawned
npm run test:e2e  # spawns Git Bash; needs an unsandboxed shell
npm run docs:check
for f in lib/index.js lib/tool/index.js lib/tool/exec.js; do node --check "$f"; done
npm pack --dry-run
```
