# 更新日志

Release notes 由对应版本段生成；最新版本在前。
英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

## 0.1.4 - 2026-09-25

### 变更

- 声明对宿主的兼容性：`peerDependencies` 与 `engines.dsh` 都要求 `>=0.1.5-rc.1`，peer 标 optional 以免 npm 去装宿主。宿主启动预检不满足时会禁用本插件，此前没有声明就无从判断。
- 依赖改为宿主提供：`dsh-llm` / `dsh-shell` / `dsh-subprocess` / `dsh-timeout` / `dsh-tools` / `schemastery` 从 `dependencies` 移到 `peerDependencies`（范围 `>=0.1.5-0`，标 optional），具体版本进 `devDependencies`。作为依赖时插件会自带一份，宿主升级后解析到的仍是旧一代副本。

## 0.1.3 - 2026-09-20

### 修复

- 插件以默认导出挂载时缺少 `inject`：0.1.1 起根入口默认导出插件函数，而 dsh 只从这个默认导出读元数据，`inject` 仅作命名导出等于未声明上下文，整个 boot 直接失败（`cannot get property "systemPrompt" without inject`）。现在把 `inject` 挂到函数本身（`apply.inject = inject`）。
- **0.1.1 与 0.1.2 装到机器上会让 dsh 无法启动**，请改用 0.1.3；0.1.0 不受影响，因为它没有默认导出。
- `publish.yml` 的发版检查只断言过插件形状（默认导出为函数），新增的单测断言现在同时锁定 `inject` 随函数走，而发版检查会跑这套单测。

## 0.1.2 - 2026-09-20

### 修复

- `ProgramFiles` 缺失时的 Git Bash 发现回退写成了 `"C:\Program Files"`（单反斜杠）：JS 求值后是 `C:Program Files`，不是目录，于是这类宿主上六个候选路径全部失效、并报「找不到 Git for Windows」。已改为合法转义，并新增断言锁定组合后的候选路径与顺序。

### 变更

- 模块文档不再用 `@module` 标签引用一个从未发布的包名：那个名字出现在本包源码里只会误导读者。

## 0.1.1 - 2026-09-18

### 变更

- 根入口改为导出插件函数本身（`export default apply`），只提供命名导出的模块不被任何按插件形状校验的工具认作插件。

## 0.1.0 - 2026-09-18

### 新增

- 新增 `winbash` 工具：在 Windows 上以 Git for Windows 的 bash 执行 `bash -c`，返回 stdout、stderr 与退出码。
- Git Bash 自动发现（`usr\bin` 优先于 `bin` 包装器）与 PATH 修复（`usr\bin`、`mingw64\bin`、`cmd` 前置）。
- 有界输出窗口与 spill 文件、环境擦除、deadline 驱动的整树终止，以及走宿主 `ctx.jobs` 的后台任务。
- 包内声明 `dsh.bundle`，安装即挂载工具行。

### 安全

- 命令在文件沙箱之外执行（MSYS 无法在 ACL 受限 token 下启动），工具描述写明，且不提供 `sandbox_permissions` 升级面。
- 不替换任何服务：`pwsh`、权限预设与 `fs` 工具的沙箱和审批策略不受影响。
