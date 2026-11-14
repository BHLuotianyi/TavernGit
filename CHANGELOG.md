# Changelog

All notable changes to TavernGit are documented in this file.

## [Unreleased]

### Security
- **Option values:** options whose value git treats as optional (`--pretty`/`--format` of `log`, `show`, `reflog`; `-U`/`--unified`; `--abbrev`; `gc --prune`) now take a value only in attached form, and any other option value passed as its own token must not start with `-`. Previously such a token was validated as a value while git parsed it as an option the allowlist never saw.
- **Repository paths:** a `.git` directory, or any path inside a git directory, is refused as `repo` for every command (`TG_UNSAFE_REPO_LAYOUT`); a repository without a `.git` directory must set `core.bare = true`. `init` checks an existing `.git` entry before re-initializing.
- **Layout and config audit:** symlinks directly inside the git directory and alternates of alternates must stay inside the SillyTavern root; command-valued keys in otherwise allowed config sections (`gc.recentObjectsHook`) are rejected.
- **Sensitive paths:** `add` is vetted before git runs, so a sensitive file is never hashed into the object store; `push` refspec sources can no longer be read as `rev-list` options.
- **Consent:** an approval is also bound to the classes, destructive flag, hosts, tier and zone shown in the dialog. Commands in a partial clone are classified `fetch` with the promisor hosts listed; other commands run with `GIT_NO_LAZY_FETCH=1`.
- **URLs:** remote URLs must start with the literal `https://`.
- **Audit log:** entries are bounded in size, and a torn line no longer makes `GET /audit` fail.

### Fixed
- `clone` options placed after the URL were dropped without notice.
- Commit identity values containing `#` or `;` were cut short by git; they are now written quoted.
- Credentials saved for `host:443` never matched a remote; the default port is normalized away.
- A slow git detection could overwrite the result of a later `GET /status?refresh=1`.
- `stash show -p` now gets `--no-ext-diff --no-textconv` like the other diff-producing commands.
- `client.commit()` passes the message as `--message=<message>`, so messages starting with `-` work.
- `DELETE /grants` is documented as returning a count; unused `settings.zoneOk` translation removed.

### Changed
- **CI:** tests run on Linux with Node 18, 20, 22, 24 and 26, and on macOS and Windows with Node 24; the Windows job now runs the git integration tests against the runner's Git for Windows. A separate job checks that every version file carries the same version. Actions are pinned to commit SHAs and kept current by Dependabot.
- **Releases:** a `v*` tag must match the version files and have a `## [x.y.z]` section in this file; the full checks run before publishing, the release notes are that section, and tags with a pre-release suffix are published as pre-releases. New commands: `node tools/version.mjs check` and `notes <tag>`.

## [0.1.0] - 2026-11-13

### Added
- **Server plugin (`server-plugin/`):** zero-dependency Node >= 18 plugin (`id: 'taverngit'`) exposing `/api/plugins/taverngit`, verified on SillyTavern 1.11.1 and 1.12.0 (Node 20) and 1.19.0 (Node 26), including stream JSON body parsing when global `bodyParser` is absent, `config.yaml` `dataRoot` fallback for ST 1.12.0–1.12.3, `dataRootFound` in `/status`, and admin-only access guard when `req.user` is present.
- **Virtual zones & risk tiers:** `@ST`, `@STdata`, `@STuser`, `@SText`, and `@STplugins` path resolution with realpath containment inside the SillyTavern root and fixed `data` / `frontend` / `server` risk classification.
- **Git discovery & isolated runner:** Windows MinGit detection (`mingit/cmd/git.exe` next to the plugin entry), system `git` detection on Linux/macOS/Termux (`>= 2.32.0`), isolated environment with `GIT_CONFIG_COUNT` overrides, global concurrency limit (4), per-repo write/network mutex, process-tree kills, 32 MiB output cap, and `stRoot` output sanitization.
- **Command policy & repository guards:** strict allowlist for 44 git subcommands, sub-subcommand tables (`remote`, `reflog`, `stash`), `WRITABLE_CONFIG` whitelist, CVE-2022-41903 format padding atom rejection, repository layout & `.git/config` audit, and sensitive-path pre/post/fail-closed push guards.
- **Consent, credentials, identity & audit stores:** per-caller/zone and per-host revocable grants, 6-digit server console confirmation codes for `server`-tier writes/network ops, server-side HTTPS credential store (`<state>/credentials.json`, mode `0600`), commit identity config (`<state>/gitconfig`), and rotating JSONL audit log (`<state>/audit.jsonl`).
- **Frontend UI & public API:** frozen `globalThis.TavernGit` API (`connect`, `git`, `init`, `clone`, `status`, `log`, `add`, `commit`, `diff`, `fetch`, `pull`, `push`, `resolve`, `getStatus`), `taverngit:ready` and `taverngit:activity` events, serialized `<dialog>` consent prompt with `isTrusted` guard and mobile layout, settings drawer, and `en` / `zh-cn` localization.
- **Tooling & docs:** `tools/version.mjs`, GitHub Actions CI/release workflows, `README.md`, `README.zh-CN.md`, `docs/api.md`, and `docs/security.md`.
