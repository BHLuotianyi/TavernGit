# TavernGit

Sandboxed, consent-gated Git for SillyTavern extensions.

TavernGit gives SillyTavern add-ons a shared, audited Git engine backed by real `git` (system `git` on Linux, macOS, and Android/Termux; user-provided MinGit on Windows). Every repository path is confined to the SillyTavern root via virtual zones, commands pass through a strict allowlist and sanitized environment, and users approve operations through an in-UI consent dialog.

## Quick Start

1. **Install the UI extension** in SillyTavern via **Extensions -> Install extension** using the repository URL:
   `https://github.com/BHLuotianyi/TavernGit`
   *(Note: SillyTavern 1.12.0–1.12.x only discover third-party UI extensions per user under `data/<handle>/extensions/`, e.g. `data/default-user/extensions/TavernGit`. The **Install extension** button handles this automatically; if installing manually on those versions, place the folder there instead of `public/scripts/extensions/third-party/`.)*
2. **Install the server plugin** into `<SillyTavern>/plugins/taverngit` using either layout:
   - **Copy install:** copy the `server-plugin/` directory from this repo to `<SillyTavern>/plugins/taverngit/`.
   - **Clone install (supports ST plugin auto-update):** clone this repo into `<SillyTavern>/plugins/taverngit`:
     ```sh
     git clone https://github.com/BHLuotianyi/TavernGit <SillyTavern>/plugins/taverngit
     ```
3. **Enable server plugins** in `<SillyTavern>/config.yaml`:
   ```yaml
   enableServerPlugins: true
   ```
4. **Ensure `git` (>= 2.32.0) is available:**
   - **Linux / macOS / Termux:** install system `git` (e.g. `sudo apt install git`, `xcode-select --install`, or `pkg install git` on Termux).
   - **Windows:** download `MinGit-<ver>-64-bit.zip` (or `-arm64.zip`) from [Git for Windows releases](https://github.com/git-for-windows/git/releases/latest) and extract it so `git.exe` sits at:
     - Copy install: `SillyTavern/plugins/taverngit/mingit/cmd/git.exe`
     - Clone install: `SillyTavern/plugins/taverngit/server-plugin/mingit/cmd/git.exe`
5. **Restart SillyTavern** and open **Extensions -> TavernGit** to verify the status panel shows no warnings.

## Supported Versions & Platforms

| Component | Requirement | Notes |
|---|---|---|
| SillyTavern | `>= 1.11.1` | Verified on 1.11.1 and 1.12.0 (Node 20), and 1.19.0 (Node 26); configured in `manifest.json#minimum_client_version`. |
| Node.js | `>= 18` | Zero external dependencies (`node:*` builtins only). |
| Git | `>= 2.32.0` | Required for `GIT_CONFIG_COUNT` and `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`. |
| Windows | MinGit only | System Git for Windows is never used so host configs/credential managers cannot leak in. |
| Linux / macOS / Termux | System `git` on `PATH` | Android APK wrappers using `GIT_EXEC_PATH` / `GIT_SSL_CAINFO` are supported. |
| TauriTavern | **Not supported** | TauriTavern has no Node server plugin runtime (`/api/*` returns 404). |

> **Note on older SillyTavern releases:** SillyTavern versions before ~1.12.x crash at startup on Node 22+/26 due to their bundled `yargs`. That is SillyTavern's own Node requirement, not TavernGit's—run those older SillyTavern releases on Node 18 or 20.

### SillyTavern Plugin Auto-Update

When `enableServerPluginsAutoUpdate` is enabled in SillyTavern (default `true`), ST runs `git pull` on plugin directories that are git repositories (clone-install mode). Runtime state (`state/`, holding grants, credentials, identity config, and the audit log) and MinGit (`mingit/`) live next to the server plugin entry:

- **Copy install:** `plugins/taverngit/state/` and `plugins/taverngit/mingit/`
- **Clone install:** `plugins/taverngit/server-plugin/state/` and `plugins/taverngit/server-plugin/mingit/`

Both `server-plugin/state/` and `server-plugin/mingit/` are listed in `.gitignore` so runtime files stay untracked and do not interfere with clone-install updates.

## Virtual Zones & Risk Tiers

All paths passed to TavernGit must use `@<zone>/<path>` syntax. Zones name directories; permissions and risk come from the resolved SillyTavern-relative path.

| Zone | Target | Availability |
|---|---|---|
| `@ST` | SillyTavern root | Always |
| `@STdata` | `DATA_ROOT` | Resolved in order: `globalThis.DATA_ROOT` (ST >= 1.12.4), else top-level `dataRoot:` in `<ST>/config.yaml` (ST 1.12.0–1.12.3; `--dataRoot` CLI overrides are invisible there), else unavailable (ST 1.11.x, where user data lives in `public/`). Must lie strictly inside the ST root. |
| `@STuser` | `<DATA_ROOT>/<handle>` (`handle` defaults to `default-user` when `req.user` is absent) | Same as `@STdata` (unavailable on ST < 1.12) |
| `@SText` | `public/scripts/extensions/third-party` | Always |
| `@STplugins` | `plugins` | Always |

A repository's **risk tier** is the highest tier of its root and any tier prefix contained inside it:

- **`data`** (`<data>/**`, excluding `<data>/*/extensions/**`): chats, characters, user data.
- **`frontend`** (`public/**` and `<data>/*/extensions/**`): browser scripts and UI extensions.
- **`server`** (everything else: `src/`, `plugins/`, `node_modules/`, root files, `@ST` itself): code and configuration executed by Node with system privileges.

## Consent, Grants & Server-Tier Confirmation

Every Git action is classified into one or more classes (`read`, `write`, `fetch`, `push`) plus a `destructive` flag:

- **One-time or remembered grants:** `read`, `write`, and `fetch` can be remembered per `(caller, class, zone)`; `push` can be remembered per `(caller, remote host)`.
- **Never remembered:** `destructive` actions (e.g. `reset --hard`, `push --force`, `clean -f`, `restore` on worktree) and non-`read` actions on `server`-tier repositories always prompt.
- **Server-tier non-read confirmation code:** Mutating or network operations on a `server`-tier repo display a red warning banner and require a 6-digit one-time code printed only to the SillyTavern server console (`stdout`). Browser JavaScript cannot read server `stdout`, preventing a same-origin extension from forging approval to modify server code.

## Credentials & Commit Identity

Runtime state lives in `<serverPluginDir>/state/` (`plugins/taverngit/state/` for copy-install, `plugins/taverngit/server-plugin/state/` for clone-install):

- **Commit identity:** Configured in **Extensions -> TavernGit** and written to `<serverPluginDir>/state/gitconfig` (defaults to `TavernGit <taverngit@localhost>`).
- **HTTPS credentials:** Remote URLs must use `https://` with no embedded `user:pass@`. Personal access tokens are added in the TavernGit settings panel, stored server-side in `<serverPluginDir>/state/credentials.json` (mode `0600`), never sent back to the browser, and injected per command via `GIT_CONFIG_COUNT` `http.https://<host>/.extraHeader`.

## Documentation

- [Caller & HTTP API Reference](docs/api.md) — `globalThis.TavernGit`, HTTP endpoints, allowlist, and all error codes.
- [Security & Threat Model](docs/security.md) — sandbox layers, environment isolation, config audit, sensitive-path guard, and CVEs mitigated.
- [Changelog](CHANGELOG.md) — release history.
- [中文文档](README.zh-CN.md)

## License

[GPL-3.0](LICENSE)
