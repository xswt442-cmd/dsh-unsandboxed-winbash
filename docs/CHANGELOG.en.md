# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## 0.1.6 - 2026-09-29

### Changed

- `CHANGELOG.md`, `CHANGELOG.en.md` and `RELEASING.md` move into `docs/`; the repository root keeps the two READMEs, `LICENSE` and `AGENTS.md`. The npm package ships the two changelogs at their new paths.

## 0.1.5 - 2026-09-28

### Fixed

- Argument validation checks types first: a non-string `command` / `description` returns a validation error instead of a `TypeError`, and the `enableRunInBackground: false` refusal is covered by a unit test.
- On `SIGINT` / `SIGBREAK` the plugin terminates its Git Bash process trees before exiting, and takes over only while it is that signal's sole listener; on Windows the process ends itself once the cleanup is done.

### Changed

- Tests are split into `test/unit/` (`npm test`, spawns nothing) and `test/e2e/` (`npm run test:e2e`, spawns real Git Bash), with one check that rejects a test file collected by neither script.
- The tree-termination unit cases cover a tree whose descendants survive, the e2e case asserts that a grandchild process is terminated with its tree, and one further case verifies exit cleanup against a real host process.
- `docs:check` runs this repository's own `scripts/check-docs.mjs` with no external dependency; the comparison covers per-section item counts in both CHANGELOGs and the `Unreleased` section, and an all-zero `--base` skips the pair check.
- `RELEASING.md` matches the actual flow: a `v*` tag triggers OIDC Trusted Publishing, and there is no manual `npm publish` step.

### Maintenance

- The npm package excludes `RELEASING.md`; `package.json` adds `homepage` and `bugs` and a bilingual `description`; `.gitattributes` is added and `.gitignore` completed.
- The publish CI uses `npm ci --ignore-scripts` with an npm cache, requires the tag to point at a commit on `main`, and splits into checks / npm / GitHub release jobs, only the one that runs no tests holding repository write access.

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
