# dsh-unsandboxed-winbash

[English](./README.md) | [中文](./README.zh.md)

在 Windows 上给 dsh 加一个 **Git Bash（MSYS2）** 工具（`winbash`）。

## 为什么需要它

在 Windows 上，dsh 官方**不提供任何 bash 工具**。`@deepseek-ai/dsh-base` 在 `win32` 上把执行器和工具一起关掉了：

```yaml
- id: bash-sandbox
  name: '@deepseek-ai/dsh-bash-sandbox'
  disabled: !!js process.platform === 'win32'
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'
```

把它们打开也没用，因为 Windows 沙箱装不下 MSYS2。以下均在 Windows 11（Git for Windows 2.53、dsh 0.1.5-rc.1）的沙箱内工具调用中实测：

| 尝试 | 结果 |
|---|---|
| `bash -c`（PATH 解析到 `C:\Windows\System32\bash.exe`） | 无输出，`Bash/Service/CreateInstance/E_ACCESSDENIED` |
| `wsl.exe -e bash -c` | `Wsl/Service/CreateInstance/E_ACCESSDENIED` |
| `C:\Program Files\Git\usr\bin\bash.exe -c` | `fatal error - couldn't create signal pipe, Win32 error 5` |
| `C:\Program Files\Git\bin\sh.exe` | 同上，`Win32 error 5` |

MSYS2 必须为信号处理创建命名管道，而沙箱的受限 token 拒绝创建。这是沙箱本身的性质，不是配置问题，所以本工具做唯一可行的事：在文件沙箱**之外**启动 Git Bash。

## 三处命名不一致是刻意的

| 位置 | 取值 | 原因 |
|---|---|---|
| npm 包 | `dsh-unsandboxed-winbash` | 名字点明关键性质：这条路径不在沙箱内。 |
| 仓库 | `dsh-unsandboxed-winbash` | 同上。 |
| 工具 id 与工具名 | `winbash` | 会话记录与系统提示里已经在用这个名字。改工具名会让所有提到它的提示与记录失效，所以名字不变。 |

## 安装

```powershell
dsh plugin --profile web add dsh-unsandboxed-winbash
```

包内声明了 `dsh.bundle`，bundle 补丁会自己挂上工具行——不需要手工改 `cordis.patch.yml`。装完需重启 dsh：插件模块无法热替换（Node 的 ESM 缓存没有失效机制），所以编辑或升级只在重启后生效。

Git Bash 从 Git for Windows 的常见安装位置自动发现，优先新式布局（`usr\bin\bash.exe` 先于 `bin\bash.exe` 包装器）。Git 装在别处时，在 `tool-winbash` 行上设置 `bashPath`。

## 配置（`tool-winbash` 行）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `bashPath` | `''` | 显式指定 Git Bash 路径；留空则自动发现。 |
| `gitPathPrefix` | `true` | 把 Git 的 `usr\bin`、`mingw64\bin`、`cmd` 前置到 `PATH`。 |
| `extraPath` | `''` | 额外 `PATH` 前缀，`;` 分隔，排在最前。 |
| `timeoutMs` | `120000` | 命令默认超时。 |
| `maxTimeoutMs` | `600000` | 单次调用超时上限。 |
| `maxOutputBytes` | `64000` | 保留的输出窗口；其余写入 spill 文件。 |
| `maxSpillBytes` | `67108864` | spill 文件上限。 |
| `drainMs` | `250` | 子进程退出后等待输出排空的上限。 |
| `enableRunInBackground` | `true` | 是否允许 `run_in_background` 调用。 |

`gitPathPrefix` 不是装饰：Windows 的 `PATH` 通常只有 `Git\cmd`，不前置的话 `ls`、`grep`、`sed`、`awk`、`find`、`sleep`、`wc` 全部 `command not found`。

## 边界

- **命令本身不受文件沙箱约束。** 它跑在沙箱之外，这正是它存在的理由。工具自身的 description 写明了这一点，并且刻意**不提供** `sandbox_permissions` 升级面——没有可升级的起点。
- **其它一切保持原样。** `pwsh`、权限预设、`/permission` 命令与 `fs` 工具都不受影响，因为本插件不替换任何服务，只新增一个工具。
- **需要受限、可审计的文件改动，请用 `fs` 工具。**

## 测试

两套，因为两半的要求不同：

```sh
npm test          # 纯单元：PATH 组合、环境擦除、有界输出收集器
npm run test:e2e  # 会启动 Git Bash：需要非沙箱 shell
```

`npm test` 在沙箱内的工具调用里也能通过。`npm run test:e2e` 不能：它启动真实 Git Bash 进程并往系统临时目录写 spill 文件，这两件事受限 token 都拒绝。请在普通终端里跑，或用本插件自己的工具跑。

两个测试文件都由 `npm run tests:split` 从 `../winbash/test/exec.test.mjs` 生成，所以要改请改原始文件（或生成器），不要改生成出来的两半。

## 与 `winbash` 的关系

`../winbash` 是私有的、针对本机部署的那一份，同时承载着产出本工具的排查记录（控制台窗口考古、沙箱临时目录修复、`permission-presets` 守卫事故）。本仓库是可发布形态：有 bundle 声明、只含一个工具、不含任何 profile 专属设置，并附上"必须在沙箱外运行"的实测依据。

## License

[MIT](./LICENSE)
