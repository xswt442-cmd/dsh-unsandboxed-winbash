# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## Unreleased

### Fixed

- `winbash` argument validation checks types first: a non-string `command` / `description` now answers a validation error instead of a `TypeError`. The rejection paths, background execution included, have unit tests.
- A host ended by Ctrl+C or Ctrl+Break (`SIGINT` / `SIGBREAK`) now reaps its Git Bash process trees first, and only while this plugin is that signal's sole listener. Windows has no signal to hand back, so the plugin ends the process itself.

### Changed

- Tests split into `test/unit/` (`npm test`, spawns nothing) and `test/e2e/` (`npm run test:e2e`, spawns real Git Bash), and a guard test rejects a test file that neither script would collect.
- Tree termination gained unit negative cases, and the e2e check that a killed tree really died now asserts instead of warning, with one more case that verifies the host-exit cleanup against a real host process.
- `docs:check` still runs this repository's own `scripts/check-docs.mjs`, with no external dependency; the comparison is wider: per-section changelog item counts, the `Unreleased` section included, and a `--base` that degrades on an all-zero SHA instead of failing.
- `RELEASING.md` describes the real flow: a `v*` tag triggers OIDC Trusted Publishing, and there is no manual `npm publish` step.

### Maintenance

- The npm package no longer ships `RELEASING.md`; `homepage` and `bugs` are added, `description` is now bilingual, and `.gitattributes` and `.gitignore` are filled out.
- Release CI tightened: `npm ci --ignore-scripts` with the npm cache, a tag must point at a commit on `main`, and publishing splits into checks, npm and release jobs so only the one that runs no tests holds repository write access.

## 0.1.4 - 2026-09-25

### Changed

- Declare host compatibility: `peerDependencies` and `engines.dsh` both require `>=0.1.5-rc.1`, with the peer optional so npm never installs the host. The host's startup preflight uses that range to decide whether to disable this plugin.
- Six `@deepseek-ai/*` packages and `schemastery` move from `dependencies` to optional `peerDependencies` plus `devDependencies`, so the host supplies them and this package no longer resolves a private older copy.

## 0.1.3 - 2026-09-20

### Fixed

- `inject` now travels on the plugin's default export: dsh reads a plugin's metadata from that value, and without it the whole boot failed ("cannot get property systemPrompt without inject").
- **Installing 0.1.1 or 0.1.2 breaks the dsh boot**; use 0.1.3. 0.1.0 is unaffected.

## 0.1.2 - 2026-09-20

### Fixed

- On a host without `ProgramFiles`, Git Bash discovery now falls back to a valid Windows path, so all six candidates resolve again. An assertion pins the composed candidates and their order.

### Changed

- The module documentation no longer names an unpublished package in an `@module` tag.

## 0.1.1 - 2026-09-18

### Changed

- The root entry exports the plugin function itself (`export default apply`); a module that offers named exports only is not recognised as a plugin by tooling that checks a plugin's default shape.

## 0.1.0 - 2026-09-18

### Added

- Add the `winbash` tool: runs `bash -c` through Git for Windows bash on Windows and returns stdout, stderr and the exit code.
- Git Bash auto-discovery (`usr\bin` before the `bin` wrapper) and PATH repair (Git `usr\bin`, `mingw64\bin` and `cmd` prepended).
- Bounded output window with a spill file, environment scrubbing, deadline-driven tree termination, and background tasks registered with the host `ctx.jobs`.
- The package declares `dsh.bundle`, so the tool row mounts on install.

### Security

- The command runs outside the file sandbox (MSYS cannot start under an ACL-restricted token). The tool description states this, and no `sandbox_permissions` escalation surface is offered.
- No service is replaced: the sandbox and approval policy of `pwsh`, the permission presets and the `fs` tools are unaffected.
