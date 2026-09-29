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

Windows 上的 Git Bash（MSYS2）工具插件。它向会话新增一个 `winbash` 工具，直接以 Git for Windows 的 bash 执行命令并修好 MSYS 的 PATH；命令在**文件沙箱之外执行**，工具描述也写明了这一点。

## 为什么需要它

Windows 上的 dsh 不提供 bash 工具：`@deepseek-ai/dsh-base` 在 `win32` 上禁用了 `dsh-bash-sandbox` 与 `dsh-tool-bash`。

Git Bash 也无法在 dsh 的文件沙箱内启动。受限 token 会拒绝 MSYS 创建信号处理所需的命名管道。

沙箱内的调用结果（Windows 11，dsh 0.1.5-rc.1）：

| 尝试 | 结果 |
| --- | --- |
| `bash -c`（PATH 解析到 `C:\Windows\System32\bash.exe`） | `Bash/Service/CreateInstance/E_ACCESSDENIED` |
| `wsl.exe -e bash -c` | `Wsl/Service/CreateInstance/E_ACCESSDENIED` |
| `C:\Program Files\Git\usr\bin\bash.exe -c` | `fatal error - couldn't create signal pipe, Win32 error 5` |

## 功能

- 新增 `winbash` 工具：以 `bash -c` 执行命令，返回 stdout、stderr 与退出码。
- 非零退出码作为命令结果返回，工具调用本身不失败。
- Git Bash 只按 Git for Windows 的常见安装位置发现，不查询 PATH。
- 把 Git 的 `usr\bin`、`mingw64\bin`、`cmd` 目录前置到子进程 PATH。
- 结果保留输出末尾约 `maxOutputBytes` 字节，超出的部分写入 spill 文件并在结果里给出路径。
- 截断按字符边界进行，多字节字符不会被切成乱码。
- 子进程环境经 `@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv` 擦除。
- deadline 到期或调用被中止时按整棵进程树终止（`taskkill /T /F`）。
- 一次运行在子进程的 `exit` 事件上结算，输出继续排空至多 `drainMs` 毫秒。
- 子进程以隐藏窗口方式启动，不弹出控制台窗口。
- `run_in_background: true` 经宿主的 `ctx.jobs` 注册任务，输出可增量读取。

## 安装

```powershell
# 从 npm 安装并注册到 web profile（推荐）
dsh plugin --profile web add dsh-unsandboxed-winbash

# 仅下载 npm package
npm install dsh-unsandboxed-winbash

# 或从 GitHub 安装
dsh plugin --profile web add github:xswt442-cmd/dsh-unsandboxed-winbash
```

包内声明 `dsh.bundle`，工具行由 bundle 补丁挂载，不需要修改 `cordis.patch.yml`。

安装后重启 DSH Web 生效。

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
        graceMs: 3000         # 整棵进程树终止后升级为 SIGKILL 的宽限
        timeoutMs: 120000     # 命令默认超时
        maxTimeoutMs: 600000
        maxOutputBytes: 64000
        maxSpillBytes: 67108864
        enableRunInBackground: true
```

Git Bash 的自动发现顺序：

| 顺序 | 路径 |
| --- | --- |
| 1 | `%ProgramFiles%\Git\usr\bin\bash.exe` |
| 2 | `%ProgramFiles%\Git\bin\bash.exe` |
| 3 | `%LOCALAPPDATA%\Programs\Git\usr\bin\bash.exe` |
| 4 | `%LOCALAPPDATA%\Programs\Git\bin\bash.exe` |
| 5 | `%ProgramFiles(x86)%\Git\usr\bin\bash.exe` |
| 6 | `%ProgramFiles(x86)%\Git\bin\bash.exe` |

显式配置的 `bashPath` 优先于发现结果。

未发现 Git Bash 且未配置 `bashPath` 时，报错出现在 `winbash` 的调用上。插件挂载不受影响。

## 安全与边界

- 命令在文件沙箱之外执行，破坏性命令同样不受限制。
- 工具描述写明这一边界，注册的参数列表中没有 `sandbox_permissions`。
- 本插件不替换任何服务，只新增一个工具。
- `pwsh`、权限预设、`/permission` 命令与 `fs` 工具仍受各自的沙箱与审批策略约束。
- 需要受限、可审计的文件改动请用 `fs` 工具。
- 名字含 `KEY`、`PASSWORD`、`SECRET`、`TOKEN` 的环境变量与全部父进程 `DSH_*` 变量都不传给子进程；子进程收到的是 `dshEnv` 提供的 `DSH_*` 事实与 Git 运行所需的变量。
- 超时或被中止时按整棵进程树终止。
- 后台任务在宿主退出时同步清理进程树。

## 平台与兼容性

| 项目 | 要求 |
| --- | --- |
| 平台 | Windows（`win32`） |
| DSH | `>=0.1.5-rc.3` |
| Node.js | `>=20` |
| 依赖 | Git for Windows（提供 Git Bash） |

其他平台不需要本插件。`dsh-tool-bash` 与 `dsh-bash-sandbox` 在非 `win32` 平台默认启用。

## 开发与验证

修改后运行：

```powershell
npm test          # 纯单元，不启动进程，沙箱内亦可
npm run test:e2e  # 启动真实 Git Bash，需要非沙箱 shell
npm run docs:check
npm pack --dry-run
```

## License

[MIT](./LICENSE)
