# dsh-unsandboxed-winbash

[中文](./README.md) | [English](./README.en.md)

[![DSH](https://img.shields.io/static/v1?label=DSH&message=plugin&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/dsh-unsandboxed-winbash?label=npm&color=4d6bfe)](https://www.npmjs.com/package/dsh-unsandboxed-winbash)
[![release](https://img.shields.io/github/v/release/xswt442-cmd/dsh-unsandboxed-winbash?label=release&color=16a3a3)](https://github.com/xswt442-cmd/dsh-unsandboxed-winbash/releases)
[![DSH](https://img.shields.io/static/v1?label=DSH&message=%3E%3D0.1.5-rc.1&color=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D20&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/d18m/dsh-unsandboxed-winbash?label=downloads&logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-unsandboxed-winbash)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

Windows 上的 Git Bash（MSYS2）工具插件。它向会话新增一个 `winbash` 工具，直接以 Git for Windows 的 bash 执行命令并修好 MSYS 的 PATH；命令在文件沙箱之外执行，工具描述写明了这一点。

## 为什么需要它

Windows 上 dsh 不提供任何 bash 工具：`@deepseek-ai/dsh-base` 在 `win32` 上同时禁用了 `dsh-bash-sandbox` 与 `dsh-tool-bash`。手工打开也无效，因为 Windows 沙箱装不下 MSYS2——受限 token 拒绝创建 MSYS 信号处理所需的命名管道。以下为 Windows 11 + dsh 0.1.5-rc.1 的沙箱内实测：

| 尝试 | 结果 |
| --- | --- |
| `bash -c`（PATH 解析到 `C:\Windows\System32\bash.exe`） | `Bash/Service/CreateInstance/E_ACCESSDENIED` |
| `wsl.exe -e bash -c` | `Wsl/Service/CreateInstance/E_ACCESSDENIED` |
| `C:\Program Files\Git\usr\bin\bash.exe -c` | `fatal error - couldn't create signal pipe, Win32 error 5` |

## 功能

- 新增 `winbash` 工具：以 `bash -c` 执行命令，返回 stdout、stderr 与退出码；非零退出按结果上报，不作为工具错误。
- Git Bash 自动发现：`usr\bin\bash.exe`（真实 MSYS2）优先于 `bin\bash.exe` 包装器，按 Git for Windows 的常见安装位置查找；`bashPath` 可显式指定。
- PATH 修复：把 Git 的 `usr\bin`、`mingw64\bin`、`cmd` 前置。Windows 的 `PATH` 通常只有 `Git\cmd`，不前置时 `ls`、`grep`、`sed`、`awk`、`find`、`sleep`、`wc` 全部 `command not found`。
- 有界输出：保留 `maxOutputBytes` 窗口，超出部分写入 spill 文件并在结果里给出路径；多字节边界不会被截断成乱码。
- 环境擦除：复用 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv`，只转发 `dshEnv` 与 Git 需要的变量。
- 超时与中断：deadline 到期或调用被中止时按整树终止（`taskkill /T /F`）。Windows 上子进程被杀后 stdio 管道不保证关闭，因此在 `exit` 上结算，并用 `drainMs` 有界排空。
- 后台任务：`run_in_background` 走宿主的 `ctx.jobs` 注册表，可增量读取输出。
- 命令内部一律显式调用 Git Bash，不用裸 `bash`：Windows 上它解析到 WSL shim，是另一个 shell。

## 安装

```powershell
# 从 npm 安装并注册到 web profile（推荐）
dsh plugin --profile web add dsh-unsandboxed-winbash

# 仅下载 npm package
npm install dsh-unsandboxed-winbash

# 或从 GitHub 安装
dsh plugin --profile web add github:xswt442-cmd/dsh-unsandboxed-winbash
```

包内声明了 `dsh.bundle`，bundle 补丁自行挂载工具行，无需手工改 `cordis.patch.yml`。安装后重启 DSH Web 生效。

## 配置

```yaml
- insert:
    - id: tool-winbash
      name: dsh-unsandboxed-winbash/tool
      config:
        bashPath: ''          # 显式指定 Git Bash 路径（默认自动发现）
        gitPathPrefix: true   # 把 Git 的 usr\bin / mingw64\bin / cmd 前置到 PATH
        extraPath: ''         # 额外 PATH 前缀，';' 分隔（排在最前）
        drainMs: 250          # 子进程退出后等待输出排空的上限
        timeoutMs: 120000     # 命令默认超时
        maxTimeoutMs: 600000
        maxOutputBytes: 64000
        maxSpillBytes: 67108864
        enableRunInBackground: true
```

Git Bash 自动发现顺序：`%ProgramFiles%\Git\usr\bin\bash.exe` → `%ProgramFiles%\Git\bin\bash.exe` → `%LOCALAPPDATA%\Programs\Git\usr\bin\bash.exe` → `%ProgramFiles(x86)%\Git\...`。找不到且未配置 `bashPath` 时，只在调用 `winbash` 时报错，挂载本身不失败。

## 安全与边界

- 命令在文件沙箱之外执行：MSYS 无法在 ACL 受限 token 下启动，这是本插件存在的前提。工具描述里写明，且不提供 `sandbox_permissions` 升级面——没有可升级的起点。
- 不替换任何服务，只新增一个工具：`pwsh`、权限预设、`/permission` 命令与 `fs` 工具仍受各自的沙箱与审批策略约束。
- 需要受限、可审计的文件改动请用 `fs` 工具。
- 命令内的凭证类环境变量（`*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSWORD*`）不传给子进程；`dshEnv` 与 Git 需要的变量除外。
- 超时或被中止时按整树终止；后台任务在宿主退出时同步清理进程树。

## 平台与兼容性

| 项目 | 要求 |
| --- | --- |
| 平台 | Windows（`win32`） |
| DSH | `>=0.1.5-rc.1` |
| Node.js | `>=20` |
| 依赖 | Git for Windows（提供 Git Bash） |

其他平台不需要本插件：`dsh-tool-bash` 与 `dsh-bash-sandbox` 在非 `win32` 上默认启用。

## 开发与验证

`test/unit.test.mjs` 不启动任何进程（PATH 组合、环境擦除、有界收集器），在沙箱内也能通过；`test/exec.test.mjs` 会启动真实 Git Bash 并写 spill 文件，必须在非沙箱 shell 中运行。两个文件由 `scripts/split-tests.mjs` 从 `../../winbash/test/exec.test.mjs` 生成，要改请改原始文件。

```powershell
npm test          # 纯单元，沙箱内亦可
npm run test:e2e  # 启动 Git Bash，需要非沙箱 shell
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
