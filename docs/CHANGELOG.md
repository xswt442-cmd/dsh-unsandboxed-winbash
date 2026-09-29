# 更新日志

Release notes 由对应版本段生成；最新版本在前。
英文版见 [CHANGELOG.en.md](CHANGELOG.en.md)。

## Unreleased

### 修复

- `@deepseek-ai/dsh-llm`、`dsh-shell`、`dsh-subprocess`、`dsh-timeout`、`dsh-tools` 的依赖范围加上 `^0.2.0-0`：宿主为 0.2 时安装本插件解析到同代组件，不再落到 0.1 代副本。

### 维护

- 锁文件解析到 `0.2.0-rc.2`，`npm test` 与 `npm run test:e2e` 在该代依赖上通过；ci 新增一格把本 bundle 注册进临时 profile，在 `@0.1.5-rc.3` 与 `@0.2.0-rc.1` 宿主上启动到 shell 应答 200。

## 0.1.6 - 2026-09-29

### 变更

- `CHANGELOG.md`、`CHANGELOG.en.md`、`RELEASING.md` 移入 `docs/`，仓库根目录只留两份 README、`LICENSE` 与 `AGENTS.md`；npm 包内的两份 CHANGELOG 按新路径发布。

## 0.1.5 - 2026-09-28

### 修复

- 参数校验先判类型：非字符串的 `command` / `description` 返回校验错误，不再抛 `TypeError`；`enableRunInBackground: false` 的拒绝路径有单元测试覆盖。
- 宿主收到 `SIGINT` / `SIGBREAK` 时，本插件先终止 Git Bash 进程树再退出，且仅在本插件是该信号唯一监听者时接管；Windows 上清理完成后由本进程结束自身。

### 变更

- 测试分为 `test/unit/`（`npm test`，不启动进程）与 `test/e2e/`（`npm run test:e2e`，使用真实 Git Bash），并有一例检查拦住未被任何脚本收集的测试文件。
- 整树终止的单元测试覆盖子孙未被终止的判定；e2e 断言孙进程随树终止，并新增一例以真实宿主进程验证退出清理。
- `docs:check` 由本仓 `scripts/check-docs.mjs` 执行，无外部依赖；比较范围含中英 CHANGELOG 的小节条目数与 `Unreleased`，CI 的 `--base` 为全 0 SHA 时跳过成对检查。
- `RELEASING.md` 与实际流程一致：发布由 `v*` tag 触发 OIDC Trusted Publishing，不含手工 `npm publish` 步骤。

### 维护

- npm 包不含 `RELEASING.md`；`package.json` 补上 `homepage` 与 `bugs`，`description` 为中英对照；新增 `.gitattributes`，补齐 `.gitignore`。
- 发布 CI 统一 `npm ci --ignore-scripts` 并缓存 npm，tag 必须指向 `main` 上的提交；发布拆为 checks / npm / GitHub release 三个 job，仅未运行测试的 job 持有仓库写权限。

## 0.1.4 - 2026-09-25

### 变更

- 声明对宿主的兼容性：`peerDependencies` 与 `engines.dsh` 都要求 `>=0.1.5-rc.1`，peer 标 optional 以免 npm 去装宿主。宿主启动预检据此决定是否禁用本插件。
- 六个 `@deepseek-ai/*` 包与 `schemastery` 不再作为 `dependencies` 自带，改为宿主提供的 optional peer 加 devDependency。

## 0.1.3 - 2026-09-20

### 修复

- `inject` 现在挂在插件的默认导出上：dsh 从默认导出读元数据，缺它整个 boot 直接失败（`cannot get property "systemPrompt" without inject`）。
- **0.1.1 与 0.1.2 装到机器上会让 dsh 无法启动**，请改用 0.1.3；0.1.0 不受影响。

## 0.1.2 - 2026-09-20

### 修复

- 未设置 `ProgramFiles` 的宿主上，Git Bash 发现回退到合法的 Windows 路径，六个候选目录能正常解析。一例断言锁定组合后的候选路径与顺序。

### 变更

- 模块文档不再用 `@module` 标签引用一个从未发布的包名。

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
