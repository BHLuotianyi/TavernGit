# TavernGit Security Architecture & Threat Model

TavernGit exposes real `git` to browser extensions inside SillyTavern. Because `git` has historical features designed for local developer convenience (hooks, external helpers, symlinks, custom diff drivers, config includes, arbitrary protocols), an unconfined wrapper would grant arbitrary code execution or filesystem escape.

---

## 1. Threat Model

### Trust Boundaries

1. **In-page consent stops overreaching or buggy extensions:**
   Every extension shares the browser origin. Without user consent (or an explicit revocable grant), an extension cannot read, mutate, fetch, or push repositories. The consent dialog enforces `event.isTrusted`, shows the detected script origin from the call stack alongside the declared caller identity (flagging `"unverified"` when mismatched or absent), and serializes prompts one at a time.
   An approval is single-use and bound to a hash of the caller, repository path, argv, stdin payload, binary mode, and the scope the dialog displayed (classes, destructive flag, remote hosts, tier, zone). If any of these differs when the command is retried — for example because a remote was pointed at another host in between — the approval is void (`TG_CONSENT_EXPIRED`).
2. **Server-side hard confinement holds even against a malicious same-origin extension:**
   Because any extension running in the SillyTavern page can call `fetch('/api/plugins/taverngit/...')` directly with the session CSRF header, the server never trusts the browser for path containment, command safety, environment hygiene, repository configuration safety, sensitive-file protection, or server-tier authorization.
3. **Server-tier out-of-band confirmation (`needsConsoleCode`):**
   If a malicious page script could silently `POST /consent` for a `server`-tier write (for example into `src/`, `plugins/`, or `server.js`), it could modify Node code and achieve arbitrary execution on the next SillyTavern restart. Therefore, any non-`read` operation on a `server`-tier repository requires a 6-digit one-time code printed **only** to the SillyTavern server `stdout`. The code is never returned by any HTTP endpoint or written to the audit log, and 3 failed attempts invalidate the pending request. Because a script could keep opening new requests, there is also a global budget: 10 wrong codes within 10 minutes (across all requests) lock server-tier approvals for 15 minutes and print a warning to the server console.
4. **Access control:**
   When `req.user` is present (SillyTavern >= 1.12), all routes require `req.user.profile.admin === true` (`403 TG_ADMIN_REQUIRED`). On SillyTavern 1.11.x (single-user mode without `req.user`), access is permitted and CSRF protection is enforced by SillyTavern.

---

## 2. Defense-in-Depth Hardening Layers

### Layer 1: Environment Isolation & Command-Scope Config (`server-plugin/lib/git-env.mjs`)

Every `git` process spawns with `shell: false`, `windowsHide: true`, and an environment built from an empty object.

#### Inherited Variables (`PASSTHROUGH`)

Only variables required to locate the binary, load system libraries/Android APK wrappers, resolve TLS CA bundles, use HTTP proxies, or format timezone are copied from `process.env` (case-insensitively on Windows):

- `PATH`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`
- `LD_LIBRARY_PATH`, `PREFIX`, `ANDROID_ROOT`, `ANDROID_DATA`
- `GIT_EXEC_PATH`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `SSL_CERT_FILE`, `SSL_CERT_DIR`
- `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (and their lowercase variants `http_proxy`, `https_proxy`, `no_proxy`, `all_proxy`)
- `TZ`

Host `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `SSH_*`, and `GIT_*` (except `GIT_EXEC_PATH`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`) are **never** inherited.

#### Fixed Sandbox Variables

| Variable | Value | Purpose |
|---|---|---|
| `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME` | `<state>/home` | Empty private home directory; hides host `~/.gitconfig` and `~/.git-credentials`. |
| `TMPDIR`, `TMP`, `TEMP` | `<state>/tmp` | Private temporary directory. |
| `GIT_CONFIG_GLOBAL` | `<state>/gitconfig` | Holds only the TavernGit commit identity (`user.name`, `user.email`); `<state>` is `plugins/taverngit/state` (copy-install) or `plugins/taverngit/server-plugin/state` (clone-install). |
| `GIT_CONFIG_SYSTEM` / `GIT_CONFIG_NOSYSTEM` | `<mingit>/etc/gitconfig` (if MinGit on `win32` and present), else `GIT_CONFIG_NOSYSTEM=1` | Keeps MinGit's bundled CA/TLS settings while blocking host `/etc/gitconfig`. |
| `GIT_CEILING_DIRECTORIES` | `dirname(stRoot)` | Prevents git from discovering repositories above the SillyTavern root. |
| `GIT_TERMINAL_PROMPT` | `0` | Never block waiting for interactive password/TTY prompts. |
| `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR` | `:` | Neutralizes editor invocation. |
| `GIT_MERGE_AUTOEDIT` | `no` | Prevents interactive merge commit message prompts. |
| `GIT_PAGER`, `PAGER` | `cat` | Prevents spawning an external pager. |
| `GIT_ALLOW_PROTOCOL` | `https` | Blocks `ssh://`, `file://`, `ext::`, `git://`, etc. |
| `GIT_PROTOCOL_FROM_USER` | `0` | Disables user-supplied protocol handlers. |
| `GIT_OPTIONAL_LOCKS` | `0` | Avoids index lock side effects on read commands. |
| `GIT_TEMPLATE_DIR` | `<state>/template` | Empty template directory so `init`/`clone` never copy default sample hooks. |
| `GIT_NO_REPLACE_OBJECTS` | `1` | Ignores `refs/replace/*` object substitution. |
| `GIT_ATTR_NOSYSTEM` | `1` | Ignores host system gitattributes. |
| `LC_ALL`, `LANG` | `C` | Deterministic machine-parseable output. |
| `GIT_NO_LAZY_FETCH` | `1` (omitted for commands approved as network commands) | Git >= 2.45: a partial clone does not contact its promisor remote on its own during local commands. |

#### Command-Scope Config (`GIT_CONFIG_COUNT`)

`GIT_CONFIG_COUNT` has higher precedence than local repo config and system/global config, overriding dangerous settings even if an entry slipped past disk checks:

1. `core.hooksPath=<state>/hooks-empty` (disables `.git/hooks/*` execution)
2. `core.fsmonitor=false` (disables fsmonitor daemon execution)
3. `core.symlinks=false` (prevents checking out symlinks that escape the ST root)
4. `core.protectNTFS=true`
5. `core.protectHFS=true`
6. `core.pager=cat`
7. `core.editor=:`
8. `core.quotePath=false`
9. `credential.helper=` (empty string resets any inherited credential helpers)
10. `protocol.allow=never`
11. `protocol.https.allow=always`
12. `submodule.recurse=false`
13. `fetch.recurseSubmodules=false`
14. `commit.gpgSign=false`
15. `tag.gpgSign=false`
16. `push.gpgSign=false`
17. `log.showSignature=false`
18. `gc.autoDetach=false` (prevents background `gc` outliving timeouts)
19. `maintenance.auto=false`
20. `i18n.logOutputEncoding=UTF-8`
21. `core.longpaths=true` *(set on `win32` only)*
22. `http.https://<host>/.extraHeader=Authorization: Basic <base64(user:token)>` *(injected per network command only for hosts matching target remotes in `credentials.json`; never placed in `argv`)*

---

### Layer 2: Command Allowlist & Argument Validation (`server-plugin/lib/policy.mjs`)

- `args[0]` must match a key in `COMMANDS`. Global git flags (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`) and git aliases cannot run.
- Every option is matched against explicit per-subcommand `flags` and `valued` declarations; undeclared options throw `TG_FORBIDDEN_OPTION`.
- Option values are consumed the way git consumes them, so no token is validated as a value while git reads it as an option. Options whose value git treats as optional (`--pretty`/`--format` of `log`, `show` and `reflog`, `-U`/`--unified`, `--abbrev`, `gc --prune`, ...) take a value only in attached form (`--opt=value`, `-ovalue`). For every other valued option, a value passed as its own token must not start with `-` (`TG_INVALID_ARGUMENT`); attach it instead (`--message=-wip`, `-m-wip`).
- `log`, `show`, `diff`, and `stash show` automatically receive `--no-ext-diff --no-textconv`; `blame` receives `--no-textconv`; `config` receives `--local` and rejects git 2.46+ sub-commands (`get`, `set`, `unset`, `list`, `rename-section`, `remove-section`, `edit`).
- `apply` forbids `--directory`, `--unsafe-paths`, and `--reject`, reads patches solely from stdin (`-`), and runs a sensitive-path post-check.
- `fmt` options reject padding atoms matching `/%(<|>|><|>>)(\||\()/`.
- Positionals and pathspecs cannot contain `\0`, exceed `4096` chars, start with `/` or `\` or `[A-Za-z]:`, or contain `..` segments (`TG_FORBIDDEN_ARGUMENT`), preventing arguments like `git diff a b` from reading files outside the repository.
- Remote URLs must start with the literal `https://` and be plain ASCII with no `\`, `@`, or embedded userinfo (`TG_FORBIDDEN_URL`). Forms a URL parser would normalize to https (`https:host`, `HTTPS://host`) are rejected because git reads them differently.
- The source side of a `push` refspec must not start with `-` (`TG_INVALID_ARGUMENT`); the sensitive-path guard also passes sources to `rev-list` after `--end-of-options`.

---

### Layer 3: Repository Layout & Config Audit (`server-plugin/lib/repo-guard.mjs`)

For every command, `init` and `clone` included:

- **Repository path (`assertOutsideGitDir`):** the resolved path must not be a `.git` directory and must not lie inside a git directory, whether a `.git` directory or a bare repository (`TG_UNSAFE_REPO_LAYOUT`). Addressed as a repository, such a path would make another repository's internals (config, hooks, sequencer state) a work tree that ordinary write commands can edit.
- `init` on a directory that already has a `.git` entry runs the layout inspection below first, so a gitfile or symlink cannot redirect the re-initialization.

Before running any command against an existing repository:

1. **Layout inspection (`inspectRepo`):**
   - Accepts only worktree repositories with a real `.git` directory (`lstat`, not a symlink) or bare repositories (`HEAD` file, `objects/` directory, and `config` file).
   - Rejects `.git` gitfiles (worktrees/submodules) and repositories with `<gitDir>/commondir` (`TG_UNSUPPORTED_REPO_LAYOUT`).
   - Verifies that `realpath(gitDir)`, every symlink directly inside the git directory (`objects`, `refs`, `index`, ...; a broken link counts as unsafe), and every non-comment entry of `<gitDir>/objects/info/alternates` resolve inside `stRoot` (`TG_UNSAFE_REPO_LAYOUT`). Alternates of alternates are followed to git's own depth limit.
2. **Config audit (`auditRepoConfig`):**
   - Parses `<gitDir>/config` with `git config --file <gitDir>/config --list --null` (which does not follow `include` / `includeIf`), plus `<gitDir>/config.worktree` if `extensions.worktreeconfig` is enabled.
   - Every key must match `AUDIT_ALLOWED` (safe `core.*`, `extensions.*`, `remote.*`, `branch.*`, `merge.*`, `fetch.*`, `gc/pack/index/i18n/color/status/advice/feature/gui.*`, `diff.*`, `rerere.*`, `rebase.*`, `checkout.*`, `maintenance.*`, `receive.*`, `lfs.repositoryformatversion`, `log.*`).
   - Inside those wildcard sections, keys whose value is a shell command are still rejected (`AUDIT_DENIED`: `gc.*hook` / `pack.*hook`, e.g. `gc.recentObjectsHook`).
   - A repository without a `.git` directory must set `core.bare = true` (`TG_UNSUPPORTED_REPO_LAYOUT`). Git runs there with `GIT_DIR` set and no work tree; without `core.bare` it would take the directory itself as the work tree.
   - Keys such as `include.*`, `includeIf.*`, `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `core.pager`, `core.editor`, `core.askpass`, `core.worktree`, `filter.*`, `diff.*.textconv`, `diff.*.command`, `diff.external`, `merge.*.driver`, `remote.*.uploadpack`, `remote.*.receivepack`, `credential.*`, `alias.*`, `url.*`, `http.*`, `gpg.*`, `submodule.*`, `uploadpack.*`, and `protocol.*` fail with `TG_UNSAFE_REPO_CONFIG` (`details.keys`).
   - Every `remote.*.url` and `remote.*.pushurl` is re-validated via `validateUrl()`.
   - TavernGit never auto-edits a repository's `.git/config`; the user must remove offending keys manually.
3. **Partial clones:** if the audited config names promisor remotes (`remote.<name>.promisor`, `extensions.partialClone`), every command on that repository is classified `fetch` and the promisor hosts are added to the consent summary, because git fetches missing objects on demand. Commands that are not network commands run with `GIT_NO_LAZY_FETCH=1`.

---

### Layer 4: Virtual Path Containment & Output Sanitization (`server-plugin/lib/vfs.mjs`, `execute.mjs`)

- Every path uses `@zone/rel` syntax (`@ST`, `@STdata`, `@STuser`, `@SText`, `@STplugins`).
- `parseVPath` rejects `\`, control characters, `:`, and `..` segments (`TG_INVALID_PATH`).
- `resolveVPath` joins the path to the zone root, resolves the deepest existing ancestor through symlinks (`realpathLoose`), and checks lexical containment (`isInside`, case-insensitive on `win32` and `darwin`) under `realpath(stRoot)` (`TG_PATH_OUTSIDE_ROOT`).
- For `init` and `clone`, after `mkdir`, realpath containment is re-verified before spawning git to prevent TOCTOU symlink swaps.
- Non-binary `stdout` and `stderr` have occurrences of the real `stRoot` path (both `/` and `\` separator forms, case-insensitive on `win32`) replaced with `@ST`.

---

### Layer 5: Risk Tiers & Sensitive-Path Guard (`server-plugin/lib/tiers.mjs`, `sensitive-guard.mjs`)

Risk tiers (`data` < `frontend` < `server`) are derived strictly from SillyTavern-relative POSIX paths (never from the requested zone alias):

- `<data>/*/extensions/**` -> `frontend`
- `<data>/**` -> `data`
- `public/**` -> `frontend`
- Everything else (including `@ST` itself, `src/`, `plugins/`, `node_modules/`, root config/scripts) -> `server`

A repository's tier is the maximum of its own path tier and any tier rule prefix nested inside it (for example, a repo at `@STuser` contains `extensions/`, so its tier is `frontend`).

**Sensitive globs** (`isSensitive`):

- `secrets.json`
- `config.yaml`
- `<data>/cookie-secret.txt`
- `<data>/*/secrets.json`
- `<data>/_storage/**`
- `<serverPluginRel>/state/**`

Enforcement in the execution pipeline:

- **Pre-check (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `pull`):** `git ls-files -z --cached` must contain no sensitive paths (`422 TG_SENSITIVE_PATH`). Read commands, `rm`, `reset`, and `restore --staged` are exempt so users can inspect or unstage accidents.
- **Pre-check (`add`):** before git runs, `git ls-files -z --others [--exclude-standard] [-- <pathspecs>]` lists the untracked files the command would start tracking (`--exclude-standard` is dropped for `add -f`; `add -u`, `--renormalize` and `--dry-run` are exempt). A sensitive match refuses the whole command (`422 TG_SENSITIVE_PATH`): staging a file writes its content into the object store, where it would remain after unstaging.
- **Untracked pre-check (`stash -u` / `stash push -u`):** `git ls-files -z --others --exclude-standard` must contain no sensitive paths before stashing untracked files.
- **Push history check (`push`):** `git rev-list --objects [--not --remotes=<remoteName> --not] <ref selectors> --end-of-options <sources...>` (no exclusion for URL remotes) checks every object reachable by the push before any network connection is made. This check **fails closed**: if `rev-list --objects` exits non-zero and cannot enumerate the pushed objects, the push is refused with `TG_INVALID_ARGUMENT` before any network access. Pushing `stash` or `refs/stash` is forbidden outright.
- **Post-check `unstage` (`add`, `mv`, `apply`):** if sensitive paths are staged afterwards, runs `git reset -q -- <paths>` and rejects with `422 TG_SENSITIVE_PATH`.
- **Post-check `warn` (`merge`, `rebase`, `cherry-pick`, `revert`, `pull`):** attaches `warnings: [{ code: 'TG_SENSITIVE_PATH_TRACKED', paths }]` to the response.

---

### Layer 6: Process Execution Bounds (`server-plugin/lib/runner.mjs`)

- **Global concurrency:** FIFO semaphore capped at `4` concurrent git processes.
- **Per-repo mutual exclusion:** `withRepoLock(repoReal)` serializes `write`, `destructive`, `fetch`, and `push` pipelines per repository; `read` commands run without waiting on the lock.
- **Timeouts & output cap:** defaults to `120 s` (`600 s` for network commands, max `1800 s`); combined `stdout` + `stderr` capped at `32 MiB`. Exceeding either kills the entire process tree (`process.kill(-pid, 'SIGKILL')` on POSIX; `taskkill.exe /PID <pid> /T /F` on Windows) and returns `504 TG_TIMEOUT` or `413 TG_OUTPUT_TOO_LARGE`.

---

## 3. CVEs Mitigated by Design

| CVE | Vulnerability Class | TavernGit Mitigation |
|---|---|---|
| **CVE-2022-24765** | Git directory discovery traversing parent directories owned by other users. | `GIT_CEILING_DIRECTORIES=dirname(stRoot)`, explicit `GIT_DIR` / `GIT_WORK_TREE` on `repo` mode, and `realpath` containment inside `stRoot`. |
| **CVE-2022-39253** | Local `git clone` / submodule traversal copying or linking sensitive files via `file://` or symlinks. | `GIT_ALLOW_PROTOCOL=https`, `protocol.allow=never`, `core.symlinks=false`, `submodule.recurse=false`, `fetch.recurseSubmodules=false`, and rejecting `.git` gitfiles. |
| **CVE-2022-41903** | Heap overflow / arbitrary write via pretty-format padding atoms (`%<(...)`, `%>(...)`, `%><(...)`, `%>>(...)`, `%<|(...)`). | `fmt` validator in `policy.mjs` rejects `/%(<|>|><|>>)(\||\()/` regardless of installed git version (accounts for distro backports). |
| **CVE-2023-25652** | `git apply --reject` writing `.rej` files across symlinks or outside the repository. | `apply` forbids `--directory`, `--unsafe-paths`, and `--reject`, disables `core.symlinks`, reads patches only from stdin (`-`), and runs `unstage` sensitive-path post-checks. |
| **CVE-2024-32002 / CVE-2024-32004** | RCE during `clone` via submodule + symlink interactions or malicious repository helpers/hooks. | `core.symlinks=false`, `core.protectNTFS=true`, `core.protectHFS=true`, `core.hooksPath=<state>/hooks-empty`, `submodule.recurse=false`, `GIT_TEMPLATE_DIR=<state>/template`, and full `.git/config` key whitelisting. |
