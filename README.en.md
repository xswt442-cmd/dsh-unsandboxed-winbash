# dsh-unsandboxed-winbash

[中文](./README.md) | [English](./README.en.md)

[![ci](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/actions/workflows/ci.yml/badge.svg)](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=plugin&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-unsandboxed-winbash?label=npm&color=4d6bfe)](https://www.npmjs.com/package/dsh-unsandboxed-winbash)
[![release](https://img.shields.io/github/v/release/xswt442-cmd/dsh-unsandboxed-winbash?label=release&color=16a3a3)](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/releases)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=%3E%3D0.1.5-rc.1&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D20&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/d18m/dsh-unsandboxed-winbash?label=downloads&logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-unsandboxed-winbash)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

A Git Bash (MSYS2) tool plugin for Windows. It adds one `winbash` tool that runs commands through Git for Windows bash with the MSYS PATH repaired; the command runs outside the file sandbox, which the tool description states.

## Why this exists

dsh ships no bash tool on Windows at all: `@deepseek-ai/dsh-base` disables both `dsh-bash-sandbox` and `dsh-tool-bash` on `win32`. Enabling them by hand does not help either, because the Windows sandbox cannot host MSYS2: the restricted token refuses the named pipe MSYS needs for signal handling. Measured inside a sandboxed tool call on Windows 11 with dsh 0.1.5-rc.1:

| Attempt | Result |
| --- | --- |
| `bash -c` (PATH resolves to `C:\Windows\System32\bash.exe`) | `Bash/Service/CreateInstance/E_ACCESSDENIED` |
| `wsl.exe -e bash -c` | `Wsl/Service/CreateInstance/E_ACCESSDENIED` |
| `C:\Program Files\Git\usr\bin\bash.exe -c` | `fatal error - couldn't create signal pipe, Win32 error 5` |

## Features

- Adds the `winbash` tool: runs a command through `bash -c` and returns stdout, stderr and the exit code. A non-zero exit is reported as a result, not as a tool error.
- Git Bash auto-discovery: `usr\bin\bash.exe` (the real MSYS2) before the `bin\bash.exe` wrapper, searched across the well-known Git for Windows install locations; `bashPath` overrides it.
- PATH repair: Git's `usr\bin`, `mingw64\bin` and `cmd` are prepended. A Windows `PATH` normally carries only `Git\cmd`, so without this `ls`, `grep`, `sed`, `awk`, `find`, `sleep` and `wc` are all `command not found`.
- Bounded output: a `maxOutputBytes` window is retained, the rest goes to a spill file whose path is reported, and multi-byte boundaries are never cut into replacement characters.
- Environment scrubbing: reuses `scrubbedParentEnv` from `@deepseek-ai/dsh-subprocess`, forwarding only `dshEnv` and what Git needs.
- Timeout and abort: a deadline or an abort terminates the whole tree (`taskkill /T /F`). On Windows a killed child does not guarantee its stdio pipes close, so the run settles on `exit` and drains output for a bounded `drainMs`.
- Background tasks: `run_in_background` registers with the host `ctx.jobs` and supports incremental reads.
- Every command calls Git Bash explicitly, never a bare `bash`: on Windows that resolves to the WSL shim, which is a different shell.

## Install

```powershell
# install from npm and register with the web profile (recommended)
dsh plugin --profile web add dsh-unsandboxed-winbash

# install the npm package only
npm install dsh-unsandboxed-winbash

# or install from GitHub
dsh plugin --profile web add github:xswt442-cmd/dsh-unsandboxed-winbash
```

The package declares `dsh.bundle`, so the bundle patch mounts the tool row itself and no hand-edited `cordis.patch.yml` is needed. Restart DSH Web after installing.

## Configuration

```yaml
- insert:
    - id: tool-winbash
      name: dsh-unsandboxed-winbash/tool
      config:
        bashPath: ''          # explicit Git Bash path (default: auto-discover)
        gitPathPrefix: true   # prepend Git's usr\bin / mingw64\bin / cmd to PATH
        extraPath: ''         # extra PATH prefix, ';'-separated, placed first
        drainMs: 250          # bounded wait for output after the child exits
        timeoutMs: 120000     # default command timeout
        maxTimeoutMs: 600000
        maxOutputBytes: 64000
        maxSpillBytes: 67108864
        enableRunInBackground: true
```

Auto-discovery order: `%ProgramFiles%\Git\usr\bin\bash.exe` → `%ProgramFiles%\Git\bin\bash.exe` → `%LOCALAPPDATA%\Programs\Git\usr\bin\bash.exe` → `%ProgramFiles(x86)%\Git\...`. When nothing is found and `bashPath` is unset, only a `winbash` call fails; mounting the plugin does not.

## Boundaries and security

- The command runs outside the file sandbox: MSYS cannot start under an ACL-restricted token, which is why this plugin exists. The tool description states it, and no `sandbox_permissions` escalation surface is offered, because there is nothing to escalate from.
- No service is replaced, only one tool added: `pwsh`, the permission presets, the `/permission` command and the `fs` tools keep the sandbox and approval policy they already had.
- Use the `fs` tools for file edits that need to stay confined and reviewable.
- Credential-shaped environment variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`) are not forwarded to the child; `dshEnv` and what Git needs are.
- A timeout or abort terminates the whole tree; a background task cleans up its process tree when the host exits.

## Platform and compatibility

| Item | Requirement |
| --- | --- |
| Platform | Windows (`win32`) |
| DSH | `>=0.1.5-rc.1` |
| Node.js | `>=20` |
| Dependency | Git for Windows (provides Git Bash) |

No other platform needs this plugin: `dsh-tool-bash` and `dsh-bash-sandbox` are enabled by default off `win32`.

## Development and verification

The two suites are split by whether they start a process: `test/unit.test.mjs` starts none (PATH composition, environment scrubbing, the collector, the `windowsHide` regression guard) and passes inside the sandbox too, while `test/exec.test.mjs` starts real Git Bash and writes spill files, so it needs an unsandboxed shell. Both run under `node --test`, one named case per assertion, and CI runs both on `windows-latest` for Node 20, 22 and 24 — this is a Windows-only plugin, so no job targets another platform.

`test:e2e` carries `--test-force-exit`: the last run leaves its pipe sockets and the child handle in the event loop (a killed child does not guarantee its stdio closes, the Windows behaviour this executor works around). That residue is bounded rather than a leak, and the suite asserts that four runs do not accumulate handles. Dropping the flag makes node wait out the test-runner timeout instead.

This plugin is the publishable form of `../../winbash`: that private copy keeps the deployment shape and every investigation note, while this repository provides `dsh.bundle`, its own package name and CI. The tool code and the assertions are the same in both, so change them together.

```powershell
npm test          # pure units, also inside the sandbox
npm run test:e2e  # starts Git Bash, needs an unsandboxed shell
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
