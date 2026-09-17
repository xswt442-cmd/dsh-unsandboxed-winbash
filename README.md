# dsh-unsandboxed-winbash

[English](./README.md) | [中文](./README.zh.md)

Adds a **Git Bash (MSYS2)** tool (`winbash`) to dsh on Windows.

## Why this exists

On Windows, dsh ships **no bash tool at all**. `@deepseek-ai/dsh-base` disables both the
executor and the tool on `win32`:

```yaml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
```

Enabling them would not help, because the Windows sandbox cannot host MSYS2. Measured on
Windows 11 (Git for Windows 2.53, dsh 0.1.5-rc.1), all inside a sandboxed tool call:

| Attempt | Result |
|---|---|
| `bash -c` (PATH resolves to `C:\Windows\System32\bash.exe`) | no output, `Bash/Service/CreateInstance/E_ACCESSDENIED` |
| `wsl.exe -e bash -c` | `Wsl/Service/CreateInstance/E_ACCESSDENIED` |
| `C:\Program Files\Git\usr\bin\bash.exe -c` | `fatal error - couldn't create signal pipe, Win32 error 5` |
| `C:\Program Files\Git\bin\sh.exe` | same, `Win32 error 5` |

MSYS2 must create a named pipe for its signal handling, and the sandbox's restricted token
refuses it. This is a property of the sandbox, not a configuration mistake, so this tool does
the one thing that works: it spawns Git Bash **outside** the file sandbox.

## The three-way split that keeps this honest

| Surface | Value | Why |
|---|---|---|
| npm package | `dsh-unsandboxed-winbash` | Names the property that matters: this path is not sandboxed. |
| repository | `dsh-unsandboxed-winbash` | Same. |
| tool id + tool name | `winbash` | What the transcript and the system prompt already say. Renaming a tool invalidates every prompt and transcript that mentions it, so it keeps its name. |

## Install

```powershell
dsh plugin --profile web add dsh-unsandboxed-winbash
```

The package declares `dsh.bundle`, so the bundle patch mounts the tool row — no hand-edited
`cordis.patch.yml` is needed. Restart dsh afterwards: a plugin's modules cannot be hot-swapped
(Node's ESM cache has no invalidation), so editing or updating it only takes effect on restart.

Git Bash is discovered from the well-known Git for Windows install locations, newest layout
first (`usr\bin\bash.exe` before the `bin\bash.exe` wrapper). If Git is somewhere else, set
`bashPath` on the `tool-winbash` row.

## Configuration (the `tool-winbash` row)

| Field | Default | Meaning |
|---|---|---|
| `bashPath` | `''` | Explicit Git Bash path; empty means auto-discover. |
| `gitPathPrefix` | `true` | Prepend Git's `usr\bin`, `mingw64\bin` and `cmd` to `PATH`. |
| `extraPath` | `''` | Extra `PATH` prefix, `;`-separated, placed first. |
| `timeoutMs` | `120000` | Default command timeout. |
| `maxTimeoutMs` | `600000` | Ceiling for a per-call timeout. |
| `maxOutputBytes` | `64000` | Retained output window; the rest goes to a spill file. |
| `maxSpillBytes` | `67108864` | Spill file cap. |
| `drainMs` | `250` | Bounded wait for output after the child exits. |
| `enableRunInBackground` | `true` | Allow `run_in_background` calls. |

`gitPathPrefix` is not cosmetic: a Windows `PATH` normally carries only `Git\cmd`, so without
it `ls`, `grep`, `sed`, `awk`, `find`, `sleep` and `wc` are all `command not found`.

## Boundaries

- **The command itself is not confined.** It runs outside the dsh file sandbox, which is why
  it exists. The tool's own description says so, and it deliberately provides **no**
  `sandbox_permissions` escalation surface: there is nothing to escalate from.
- **Everything else keeps its sandbox.** `pwsh`, the permission presets, the `/permission`
  command and the `fs` tools are untouched, because this plugin replaces no service — it adds
  one tool.
- **Use the `fs` tools for file edits** you want confined and reviewable.

## Tests

Two suites, because the halves have different requirements:

```sh
npm test          # pure units: PATH composition, env scrubbing, bounded collector
npm run test:e2e  # spawns Git Bash: needs an unsandboxed shell
```

`npm test` passes inside a sandboxed tool call. `npm run test:e2e` does not: it starts real
Git Bash processes and writes spill files under the OS temp directory, both of which a
restricted token refuses. Run it from a normal terminal, or from this plugin's own tool.

Both files are generated from `../winbash/test/exec.test.mjs` by `npm run tests:split`, so edit
that original (or the generator) rather than the generated halves.

## Relation to `winbash`

`../winbash` is the private, deployment-specific copy that also carries the investigation notes
that produced this tool (console-window archaeology, sandbox temp-directory repair, the
`permission-presets` guard incident). This repository is the publishable form: bundle manifest,
one tool, no profile-specific setup, and the measured evidence that justifies running outside
the sandbox.

## License

[MIT](./LICENSE)
