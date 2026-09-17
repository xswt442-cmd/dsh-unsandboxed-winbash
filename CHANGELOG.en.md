# Changelog

Release notes are generated from the matching version section; newest first.
For Chinese, see [CHANGELOG.md](CHANGELOG.md).

## 0.1.1 - 2026-09-18

### Changed

- The root entry now carries a default export (`export default apply`), the shape `dsh-ballast` and `dsh-treekeeper` ship. It previously had named exports only, which loads fine by package name but fails any tool that checks a plugin by its default shape.

## 0.1.0 - 2026-09-18

### Added

- Add the `winbash` tool: runs `bash -c` through Git for Windows bash on Windows and returns stdout, stderr and the exit code.
- Git Bash auto-discovery (`usr\bin` before the `bin` wrapper) and PATH repair (Git `usr\bin`, `mingw64\bin` and `cmd` prepended).
- Bounded output window with a spill file, environment scrubbing, deadline-driven tree termination, and background tasks registered with the host `ctx.jobs`.
- The package declares `dsh.bundle`, so the tool row mounts on install.

### Security

- The command runs outside the file sandbox (MSYS cannot start under an ACL-restricted token). The tool description states this, and no `sandbox_permissions` escalation surface is offered.
- No service is replaced: the sandbox and approval policy of `pwsh`, the permission presets and the `fs` tools are unaffected.
