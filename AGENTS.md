# Agent guide

`dsh-unsandboxed-winbash` is a Windows-only DSH host plugin: it adds a `winbash` tool that runs commands through Git for Windows bash outside the file sandbox, because MSYS cannot start under an ACL-restricted token.

## Engineering

- Keep `README.md` / `README.en.md` and `CHANGELOG.md` / `CHANGELOG.en.md` in sync.
- Keep the tool id and name `winbash`. Only the package is named after the property that matters; renaming the tool would invalidate every prompt and transcript that already refers to it.
- Keep `windowsHide: true` on the spawn: `CREATE_NO_WINDOW` is the whole reason no console window appears, and `test/unit.test.mjs` guards it.
- The tool runs outside the file sandbox by design. Do not add a `sandbox_permissions` escalation surface: there is nothing to escalate from, and the tool description states the boundary.
- The executable is discovered from the well-known Git for Windows locations, never through PATH, where `bash` is the WSL shim. `DSH_TEST_BASH` overrides discovery for tests.
- This repo is the publishable form. A private copy exists outside this workspace with the same tool code and assertions, so change both when the tool changes.

## Verify

```sh
npm test          # pure units; no process is spawned
npm run test:e2e  # spawns Git Bash; needs an unsandboxed shell
npm run docs:check
npm pack --dry-run
```
