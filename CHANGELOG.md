# 更新日志

Release notes 由对应版本段生成；最新版本在前。
英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

## 0.1.1 - 2026-09-18

### 变更

- 根入口补上 default 导出（`export default apply`），与 `dsh-ballast` / `dsh-treekeeper` 同形。此前只有命名导出：按包名加载的 bundle 仍能工作，但任何按 default 形状检查插件的工具都会判定它不是插件。

## 0.1.0 - 2026-09-18

### 新增

- 新增 `winbash` 工具：在 Windows 上以 Git for Windows 的 bash 执行 `bash -c`，返回 stdout、stderr 与退出码。
- Git Bash 自动发现（`usr\bin` 优先于 `bin` 包装器）与 PATH 修复（`usr\bin`、`mingw64\bin`、`cmd` 前置）。
- 有界输出窗口与 spill 文件、环境擦除、deadline 驱动的整树终止，以及走宿主 `ctx.jobs` 的后台任务。
- 包内声明 `dsh.bundle`，安装即挂载工具行。

### 安全

- 命令在文件沙箱之外执行（MSYS 无法在 ACL 受限 token 下启动），工具描述写明，且不提供 `sandbox_permissions` 升级面。
- 不替换任何服务：`pwsh`、权限预设与 `fs` 工具的沙箱和审批策略不受影响。
