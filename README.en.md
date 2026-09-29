# dsh-unsandboxed-winbash

[中文](./README.md) | [English](./README.en.md)

[![ci](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/actions/workflows/ci.yml/badge.svg)](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/actions/workflows/ci.yml)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=plugin&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-unsandboxed-winbash?label=npm&color=4d6bfe)](https://www.npmjs.com/package/dsh-unsandboxed-winbash)
[![release](https://img.shields.io/github/v/release/xswt442-cmd/dsh-unsandboxed-winbash?label=release&color=16a3a3)](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/releases)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=%3E%3D0.1.5-rc.3&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D20&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/d18m/dsh-unsandboxed-winbash?label=downloads&logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-unsandboxed-winbash)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

A Git Bash (MSYS2) tool plugin for Windows. It adds one `winbash` tool that runs commands through Git for Windows bash with the MSYS PATH repaired; the command runs **outside the file sandbox**, which the tool description also states.

## Why this exists

dsh on Windows ships no bash tool: `@deepseek-ai/dsh-base` disables `dsh-bash-sandbox` and `dsh-tool-bash` on `win32`.

Git Bash does not start inside the dsh file sandbox either. The restricted token refuses the named pipe MSYS creates for signal handling.

Results of calls made inside a sandbox (Windows 11, dsh 0.1.5-rc.1):

| Attempt | Result |
| --- | --- |
| `bash -c` (PATH resolves to `C:\Windows\System32\bash.exe`) | `Bash/Service/CreateInstance/E_ACCESSDENIED` |
| `wsl.exe -e bash -c` | `Wsl/Service/CreateInstance/E_ACCESSDENIED` |
| `C:\Program Files\Git\usr\bin\bash.exe -c` | `fatal error - couldn't create signal pipe, Win32 error 5` |

## Features

- Adds the `winbash` tool: a command runs through `bash -c`, and stdout, stderr and the exit code are returned.
- A non-zero exit code is returned as the command's result, and the tool call itself does not fail.
- Git Bash is discovered only in the well-known Git for Windows install locations, never through PATH.
- Git's `usr\bin`, `mingw64\bin` and `cmd` directories are prepended to the child PATH.
- The result keeps roughly the last `maxOutputBytes` bytes of output, and anything beyond that goes to a spill file whose path the result reports.
- Truncation happens at character boundaries, so a multi-byte character is never cut into a replacement character.
- The child environment is scrubbed by `scrubbedParentEnv` from `@deepseek-ai/dsh-subprocess`.
- A deadline or an abort terminates the whole process tree (`taskkill /T /F`).
- A run settles on the child's `exit` event, and output keeps draining for at most `drainMs` milliseconds.
- The child is spawned with a hidden window, so no console window appears.
- `run_in_background: true` registers the run with the host `ctx.jobs` and allows incremental reads.

## Install

```powershell
# install from npm and register with the web profile (recommended)
dsh plugin --profile web add dsh-unsandboxed-winbash

# install the npm package only
npm install dsh-unsandboxed-winbash

# or install from GitHub
dsh plugin --profile web add github:xswt442-cmd/dsh-unsandboxed-winbash
```

The package declares `dsh.bundle`, so the bundle patch mounts the tool row itself and no `cordis.patch.yml` edit is needed.

Restart DSH Web after installing.

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
        graceMs: 3000         # grace before a whole-tree kill escalates to SIGKILL
        timeoutMs: 120000     # default command timeout
        maxTimeoutMs: 600000
        maxOutputBytes: 64000
        maxSpillBytes: 67108864
        enableRunInBackground: true
```

Git Bash discovery order:

| Order | Path |
| --- | --- |
| 1 | `%ProgramFiles%\Git\usr\bin\bash.exe` |
| 2 | `%ProgramFiles%\Git\bin\bash.exe` |
| 3 | `%LOCALAPPDATA%\Programs\Git\usr\bin\bash.exe` |
| 4 | `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` |
| 5 | `%ProgramFiles(x86)%\Git\usr\bin\bash.exe` |
| 6 | `%ProgramFiles(x86)%\Git\bin\bash.exe` |

An explicit `bashPath` takes precedence over the discovery result.

When nothing is found and `bashPath` is unset, the failure is reported by the `winbash` call. Mounting the plugin is unaffected.

## Safety and limits

- The command runs outside the file sandbox, and destructive commands are not confined either.
- The tool description states this boundary, and the registered parameter list holds no `sandbox_permissions`.
- No service is replaced: the plugin only adds one tool.
- `pwsh`, the permission presets, the `/permission` command and the `fs` tools keep the sandbox and approval policy they already had.
- Use the `fs` tools for file edits that need to stay confined and reviewable.
- Environment variables whose name contains `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, and every `DSH_*` variable of the parent, are not forwarded to the child; the child receives the `DSH_*` facts supplied by `dshEnv` and what Git needs.
- A timeout or an abort terminates the whole process tree.
- A background task cleans up its process tree when the host exits.

## Platform and compatibility

| Item | Requirement |
| --- | --- |
| Platform | Windows (`win32`) |
| DSH | `>=0.1.5-rc.3` |
| Node.js | `>=20` |
| Dependency | Git for Windows (provides Git Bash) |

No other platform needs this plugin. `dsh-tool-bash` and `dsh-bash-sandbox` are enabled by default off `win32`.

## Development and verification

After a change:

```powershell
npm test          # pure units, no process spawned, fine inside the sandbox
npm run test:e2e  # spawns real Git Bash, needs an unsandboxed shell
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
