# TavernGit

为 SillyTavern 扩展提供沙箱隔离、需要用户授权的 Git 能力。

TavernGit 由前端 UI 扩展与无依赖的 Node 服务端插件组成，底层调用真实的 `git`（Linux、macOS 与 Android/Termux 使用系统 `git`；Windows 使用用户自行放置的 MinGit）。所有仓库路径均被限制在 SillyTavern 根目录内，命令参数、环境变量与仓库配置均经过严格白名单校验，并由用户通过弹窗确认操作。

## 快速开始

1. **安装前端扩展**：在 SillyTavern 中打开 **扩展 -> 安装扩展**，填入仓库地址：
   `https://github.com/BHLuotianyi/TavernGit`
   *（说明：SillyTavern 1.12.0–1.12.x 仅按用户从 `data/<handle>/extensions/`（如 `data/default-user/extensions/TavernGit`）发现第三方前端扩展。使用 **安装扩展** 按钮会自动处理该路径；若在这些版本上手动安装，请将目录放置到该位置而非 `public/scripts/extensions/third-party/`。）*
2. **安装服务端插件**至 `<SillyTavern>/plugins/taverngit`（支持以下两种方式之一）：
   - **复制安装**：将本仓库中的 `server-plugin/` 目录复制到 `<SillyTavern>/plugins/taverngit/`。
   - **克隆安装（支持 ST 插件自动更新）**：将本仓库克隆到 `<SillyTavern>/plugins/taverngit`：
     ```sh
     git clone https://github.com/BHLuotianyi/TavernGit <SillyTavern>/plugins/taverngit
     ```
3. **启用服务端插件**：在 `<SillyTavern>/config.yaml` 中设置：
   ```yaml
   enableServerPlugins: true
   ```
4. **准备 `git`（>= 2.32.0）**：
   - **Linux / macOS / Termux**：安装系统 `git`（例如 `sudo apt install git`、`xcode-select --install`，Termux 使用 `pkg install git`）。
   - **Windows**：从 [Git for Windows 发布页](https://github.com/git-for-windows/git/releases/latest) 下载 `MinGit-<ver>-64-bit.zip`（或 `-arm64.zip`），解压使 `git.exe` 位于：
     - 复制安装：`SillyTavern/plugins/taverngit/mingit/cmd/git.exe`
     - 克隆安装：`SillyTavern/plugins/taverngit/server-plugin/mingit/cmd/git.exe`
5. **重启 SillyTavern**，在 **扩展 -> TavernGit** 面板确认状态无警告。

## 版本与平台支持

| 组件 | 要求 | 说明 |
|---|---|---|
| SillyTavern | `>= 1.11.1` | 已在 1.11.1 与 1.12.0（Node 20）以及 1.19.0（Node 26）实测验证；对应配置位于 `manifest.json#minimum_client_version`。 |
| Node.js | `>= 18` | 零第三方依赖，仅使用 `node:*` 内置模块。 |
| Git | `>= 2.32.0` | 依赖 `GIT_CONFIG_COUNT` 及 `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`。 |
| Windows | 仅支持 MinGit | 从不回退到系统 Git for Windows，避免宿主机配置与凭据管理器泄露进沙箱。 |
| Linux / macOS / Termux | `PATH` 中的系统 `git` | 兼容使用 `GIT_EXEC_PATH` / `GIT_SSL_CAINFO` 的 Android APK 封装环境。 |
| TauriTavern | **不支持** | TauriTavern 无 Node 服务端插件运行时（`/api/*` 返回 404）。 |

> **关于旧版 SillyTavern 的 Node 版本说明：** 约 1.12.x 之前的 SillyTavern 版本因内置 `yargs` 兼容问题会在 Node 22+/26 下启动崩溃。这是 SillyTavern 自身的 Node 版本要求而非 TavernGit 的限制，请使用 Node 18 或 20 运行这些旧版 SillyTavern。

### SillyTavern 插件自动更新

当 SillyTavern 启用 `enableServerPluginsAutoUpdate`（默认 `true`）时，启动期间会对作为 git 仓库安装的插件目录（克隆安装模式）执行 `git pull`。运行时状态目录 `state/`（存放授权、凭据、身份配置与审计日志）与 `mingit/` 均位于服务端插件入口旁：

- **复制安装**：`plugins/taverngit/state/` 与 `plugins/taverngit/mingit/`
- **克隆安装**：`plugins/taverngit/server-plugin/state/` 与 `plugins/taverngit/server-plugin/mingit/`

`.gitignore` 已忽略 `server-plugin/state/` 和 `server-plugin/mingit/`，确保克隆安装模式下的运行时数据保持未跟踪状态，不会阻碍插件自动更新。

## 虚拟区域（Zones）与风险分级（Tiers）

API 中的路径必须采用 `@<zone>/<path>` 格式。区域只用于定位目录，权限与风险等级一律根据解析后的 SillyTavern 相对路径计算。

| 区域 | 映射目录 | 可用条件 |
|---|---|---|
| `@ST` | SillyTavern 根目录 | 始终可用 |
| `@STdata` | `DATA_ROOT` | 按顺序解析：`globalThis.DATA_ROOT`（ST >= 1.12.4），否则读取 `<ST>/config.yaml` 顶层 `dataRoot:`（ST 1.12.0–1.12.3；该版本下命令行 `--dataRoot` 参数不可见），否则不可用（ST 1.11.x 将用户数据保存在 `public/`）。且必须严格位于 ST 根目录内。 |
| `@STuser` | `<DATA_ROOT>/<handle>`（无 `req.user` 时 `handle` 默认为 `default-user`） | 同 `@STdata`（ST < 1.12 不可用） |
| `@SText` | `public/scripts/extensions/third-party` | 始终可用 |
| `@STplugins` | `plugins` | 始终可用 |

仓库的**风险等级**取仓库根目录等级与其内部所含前缀路径等级的最大值：

- **`data`**（`<data>/**`，不含 `<data>/*/extensions/**`）：聊天记录、角色卡等用户数据。
- **`frontend`**（`public/**` 与 `<data>/*/extensions/**`）：浏览器端脚本与前端扩展。
- **`server`**（其余所有路径：`src/`、`plugins/`、`node_modules/`、根目录文件及 `@ST` 本身）：由 Node 以完整系统权限运行的服务端代码与配置。

## 授权机制与服务端确认码

每次 Git 调用会被分类为一个或多个操作类型（`read`、`write`、`fetch`、`push`）以及 `destructive`（破坏性）标记：

- **单次确认与持久授权**：`read`、`write`、`fetch` 可按 `(调用方, 操作类型, 区域)` 记住；`push` 可按 `(调用方, 远端主机)` 记住。
- **不可记住的操作**：任何 `destructive` 操作（如 `reset --hard`、`push --force`、`clean -f`、工作区 `restore`）以及 `server` 级仓库上的非 `read` 操作每次都会弹窗确认。
- **服务端级写入确认码**：在 `server` 级仓库执行修改或网络操作时，弹窗会显示红色警告，并要求输入仅打印在 SillyTavern 服务端控制台（`stdout`）中的 6 位一次性数字确认码。页面 JS 无法读取服务端控制台输出，从而防止同源恶意扩展伪造授权来篡改服务端代码。

## 凭据与提交身份

运行时状态保存在 `<serverPluginDir>/state/`（复制安装为 `plugins/taverngit/state/`，克隆安装为 `plugins/taverngit/server-plugin/state/`）：

- **提交身份**：在 **扩展 -> TavernGit** 中配置，写入 `<serverPluginDir>/state/gitconfig`（默认 `TavernGit <taverngit@localhost>`）。
- **HTTPS 凭据**：远端 URL 仅允许 `https://` 且禁止内嵌 `user:pass@`。访问令牌在 TavernGit 设置面板添加，保存在服务端 `<serverPluginDir>/state/credentials.json`（权限 `0600`），永不回传前端，仅在执行网络命令时通过 `GIT_CONFIG_COUNT` 的 `http.https://<host>/.extraHeader` 注入。

## 文档索引

- [调用方与 HTTP API 参考](docs/api.md) — `globalThis.TavernGit`、HTTP 接口、命令白名单及全部错误码。
- [安全模型与加固设计](docs/security.md) — 威胁模型、环境隔离、配置审计、敏感路径防护及缓解的 CVE 列表。
- [更新日志](CHANGELOG.md)
- [English README](README.md)

## 开发与发布

- `npm test` 运行全部测试（Node 内置测试运行器，无依赖）。git 集成测试需要 `PATH` 中有 git；Windows 上需将 `TAVERNGIT_TEST_GIT` 设为某个 `git.exe` 的路径。
- 发布流程：执行 `npm run version:set -- 0.2.0`，把 `CHANGELOG.md` 中的 `## [Unreleased]` 标题改为 `## [0.2.0] - <日期>`，提交后推送标签 `v0.2.0`。发布工作流会核对标签与版本文件及更新日志，重新运行全部检查，然后发布 GitHub Release，说明取自更新日志中的对应章节。

## 许可证

[GPL-3.0](LICENSE)
