# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## 0.1.2 - 2026-09-20

### Fixed

- The Git Bash discovery fallback used when `ProgramFiles` is absent was written as `"C:\Program Files"` (one backslash), which JavaScript evaluates to `C:Program Files` — not a directory — so all six candidates failed on such a host and it reported Git for Windows as missing. The literal is now correctly escaped, and an assertion pins the composed candidates and their order.

### Changed

- The module documentation no longer names the private copy's package (`@deepseek-ai/dsh-winbash`) in an `@module` tag: that name is never published, so carrying it in this package's sources only misleads a reader.

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
