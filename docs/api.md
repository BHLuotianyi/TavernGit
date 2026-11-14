# TavernGit API Reference

This document covers the browser caller API (`globalThis.TavernGit`), the HTTP endpoints mounted at `/api/plugins/taverngit`, the command allowlist (`server-plugin/lib/policy.mjs`), and all error codes.

---

## 1. Browser Caller API

TavernGit exposes a frozen object at `globalThis.TavernGit` and dispatches `window` `CustomEvent('taverngit:ready', { detail: api })` once installed.

### Waiting for TavernGit

```js
async function getTavernGit() {
    if (!globalThis.TavernGit) {
        await new Promise((resolve) => {
            window.addEventListener('taverngit:ready', () => resolve(), { once: true });
        });
    }
    await globalThis.TavernGit.ready;
    return globalThis.TavernGit;
}

const tg = await getTavernGit();
const git = tg.connect({ id: 'my-extension', name: 'My Extension' });

await git.init('@STuser/my-backup');
const st = await git.status('@STuser/my-backup');
console.log(st.branch, st.entries);
```

### Top-level Properties & Methods

| Member | Signature / Value | Description |
|---|---|---|
| `version` | `string` | UI extension version (e.g. `'0.1.0'`). |
| `protocol` | `number` | Wire protocol version (`1`). Must match the server plugin. |
| `ready` | `Promise<Status>` | Startup status probe promise. |
| `zones` | `readonly string[]` | `['@ST', '@STdata', '@STuser', '@SText', '@STplugins']` (frozen). |
| `TavernGitError` | `typeof TavernGitError` | Error class with `.code`, `.details`, and `.consent`. |
| `errorCodes` | `Readonly<Record<string, string>>` | All server and client error code constants. |
| `getStatus(opts?)` | `({ refresh?: boolean }) => Promise<Status>` | Fetch plugin, git, platform, zone, and user status. |
| `resolve(path)` | `(vpath: string) => Promise<{ display, alias, tier, zone, exists }>` | Resolve a virtual path without running git. |
| `connect(caller)` | `({ id: string, name: string }) => Client` | Create a bound caller client. `id` must match `/^[a-z0-9][a-z0-9._-]{0,63}$/i`; `name` max 80 chars. |

### Client Methods (`tg.connect({ id, name })`)

Every client method captures the caller script origin synchronously from the call stack (`detectCallerOrigin`), sends `POST /exec`, handles `TG_CONSENT_REQUIRED` via the in-page consent queue, and retries with the resulting `approvalId`. After every `git()` call settles (whether it resolves or rejects), TavernGit dispatches a `window` `CustomEvent('taverngit:activity')` (informational; used by the settings panel to refresh grants and the audit log).

#### `client.git(repo, args, options?)`

Run an allowlisted git command. Returns `{ exitCode, stdout, stderr, durationMs, warnings }`. A non-zero git exit code resolves normally from `client.git()`.

- `repo`: `string` — virtual path (`@ST...`).
- `args`: `string[]` — git arguments (`1..512` strings), starting with an allowlisted subcommand.
- `options`: `{ input?: string, binary?: boolean, timeoutMs?: number }`:
  - `input`: stdin string up to 32 MiB (required for `apply`).
  - `binary`: when `true`, `stdout` is base64-encoded.
  - `timeoutMs`: clamped by server policy up to `1800000` ms (defaults: `120000` ms local, `600000` ms network).

#### Convenience Helpers

All helpers below wrap `client.git()` and throw `TavernGitError('TG_GIT_FAILED', stderr, { exitCode, stdout, stderr })` if `exitCode !== 0`:

| Method | Signature | Behavior / Return |
|---|---|---|
| `init` | `(repo, { initialBranch?, bare? }?)` | Runs `git init` at `repo`. |
| `clone` | `(url, dest, { depth?, branch?, singleBranch?, noTags?, bare?, filter? }?)` | Calls `git(dest, ['clone', ...opts, url])`. |
| `status` | `(repo)` | Runs `status --porcelain=v2 --branch -z`; returns `{ branch: { oid, head, upstream, ahead, behind }, entries: [{ type, index, worktree, path, origPath? }] }` where `type` is `'changed' \| 'renamed' \| 'unmerged' \| 'untracked' \| 'ignored'`. |
| `log` | `(repo, { maxCount = 50, ref?, path? }?)` | Runs `log -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s`; returns `[{ hash, parents, authorName, authorEmail, authorDate, subject }]`. |
| `add` | `(repo, paths)` | Stages `paths` (`add -- ...paths`). |
| `commit` | `(repo, message, { amend?, allowEmpty? }?)` | Commits staged changes with `--message=<message>`. |
| `diff` | `(repo, { cached?, paths? }?)` | Returns diff `stdout` string. |
| `fetch` | `(repo, remote = 'origin')` | Runs `git fetch <remote>`. |
| `pull` | `(repo, remote?, branch?)` | Runs `git pull [remote [branch]]`. |
| `push` | `(repo, remote, refspecs = [], { setUpstream?, forceWithLease? }?)` | Runs `git push` (`remote` required). |

---

## 2. HTTP API

Base path: `/api/plugins/taverngit`. All routes require an authenticated admin user when `req.user` is present (SillyTavern >= 1.12), returning `403 TG_ADMIN_REQUIRED` otherwise. State-changing routes require SillyTavern's CSRF header (`x-csrf-token`).

Success responses return `{ ok: true, ...payload }`. Error responses return:

```json
{
  "ok": false,
  "error": {
    "code": "TG_...",
    "message": "Human-readable explanation",
    "details": {}
  },
  "consent": {}
}
```

`consent` is included only on HTTP `409` with `TG_CONSENT_REQUIRED`.

### Endpoints

| Route | Request Body / Query | Success Payload (`{ ok: true, ... }`) |
|---|---|---|
| `GET /status[?refresh=1]` | Query `refresh=1` re-detects git binary. | `{ plugin: { version, versionCode, protocol }, git: { available, source, version, minVersion, reason?, hint? }, platform, dataRootInside, dataRootFound, zones: [{ name, available, display }], user: { handle, admin } }` |
| `POST /exec` | `{ caller: { id, name, origin }, repo, args, input?, binary?, timeoutMs?, approvalId? }` | `{ exitCode, stdout, stderr, durationMs, warnings: [{ code, paths }] }` |
| `POST /consent` | `{ requestId, decision: 'allow' \| 'deny', remember: boolean, consoleCode? }` | `{ approvalId }` |
| `POST /resolve` | `{ path }` | `{ display, alias, tier, zone, exists }` |
| `GET /grants` | — | `{ grants: [{ id, callerKey, callerName, cls, zone?, host? }] }` |
| `DELETE /grants/:id` | — | `{ removed: boolean }` |
| `DELETE /grants` | — | `{ removed: number }` *(count of grants removed)* |
| `GET /credentials` | — | `{ credentials: [{ id, host, username, createdAt }] }` *(tokens are never returned)* |
| `POST /credentials` | `{ host, username, token }` | `{ credential: { id, host, username, createdAt } }` |
| `DELETE /credentials/:id` | — | `{ removed: boolean }` |
| `GET /identity` | — | `{ identity: { name, email } }` |
| `POST /identity` | `{ name, email }` | `{ identity: { name, email } }` |
| `GET /audit?limit=N` | Query `limit <= 500` | `{ entries }` *(newest first)* |

- In `POST /exec`, `repo` must not be a `.git` directory or any path inside a git directory (`422 TG_UNSAFE_REPO_LAYOUT`), for every command including `init` and `clone`. A repository without a `.git` directory must set `core.bare = true` (`422 TG_UNSUPPORTED_REPO_LAYOUT`).
- Audit entries are bounded: strings longer than 512 characters and lists longer than 64 items are cut short (a long `argv` ends with `"… N more"`).
- In `GET /status`, `dataRootFound` is `false` when no data root is configured or present (for example on SillyTavern 1.11.x, where user data lives in `public/`), and `dataRootInside` indicates whether a resolved data root lies strictly inside the SillyTavern root.
- In `GET /audit`, each entry's `decision` is one of:
  - `'approved'`: request carried a single-use `approvalId` (consumed first even if "Remember" also created a covering grant);
  - `'grant'`: covered directly by a saved grant with no dialog;
  - `'denied'`: user denied the request via `POST /consent`;
  - `'rejected'`: rejected during validation, command policy, or repository guard before consent (`TG_CONSENT_REQUIRED` itself is not audited).

### `TG_CONSENT_REQUIRED` Payload (`409 Conflict`)

```json
{
  "ok": false,
  "error": { "code": "TG_CONSENT_REQUIRED", "message": "..." },
  "consent": {
    "requestId": "uuid",
    "caller": { "id": "devtest", "name": "Dev", "origin": "my-ext" },
    "repo": { "display": "@ST/data/default-user/repo", "alias": "@STuser/repo", "tier": "data", "zone": "STuser" },
    "argv": ["status"],
    "classes": ["read"],
    "destructive": false,
    "destructiveReasons": [],
    "hosts": [],
    "needsConsoleCode": false,
    "rememberable": [{ "cls": "read", "zone": "STuser" }]
  }
}
```

- `classes` is sorted alphabetically.
- `rememberable` is empty (`[]`) when `destructive` is `true` or when `repo.tier === 'server'` and `classes` includes any class other than `'read'`.
- In a partial clone (a repository whose config names promisor remotes), every command carries the `fetch` class and lists the promisor hosts in `hosts`, because git fetches missing objects on demand.
- The `approvalId` obtained for a request is only valid while `classes`, `destructive`, `hosts`, `repo.tier` and `repo.zone` are still what this payload showed; otherwise the retry fails with `TG_CONSENT_EXPIRED`.
- `warnings` entries in `POST /exec` use code `TG_SENSITIVE_PATH_TRACKED`.

---

## 3. Command Allowlist (`server-plugin/lib/policy.mjs`)

`args[0]` must be an allowlisted subcommand. Global options (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`, `--namespace`) and git aliases are always rejected with `TG_FORBIDDEN_COMMAND`. Any undeclared option is rejected with `TG_FORBIDDEN_OPTION`.

### Value Validators & Operand Rules

- **Positionals & pathspecs:** String tokens at most `4096` characters, no NUL bytes. Any positional or pathspec that could escape the repository — starting with `/`, `\`, `[A-Za-z]:` (absolute, UNC, or Windows drive paths), or containing a `..` segment — is rejected with `TG_FORBIDDEN_ARGUMENT`.
- **`int`:** `/^\d{1,9}$/`
- **`text`:** no `\0`, length <= `65536`
- **`ref`:** no control chars (`\x00-\x1f`, `\x7f`), does not start with `-`, length `1..1024`
- **`fmt`:** `text`, and rejects padding atoms matching `/%(<|>|><|>>)(\||\()/` (CVE-2022-41903 mitigation)
- **`enum(...)`:** exact match against listed values
- **`filter`:** `/^(blob:none|blob:limit=\d+[kmg]?|tree:0)$/`
- **`url`:** must start with the literal `https://` (<= `4096` chars, ASCII only), no `\`, `@`, or userinfo (`username`/`password`), hostname must be ASCII hostname or bracketed IPv6; returns lowercased `host[:port]`.
- **Optional values (`?=type`):** accepted only in attached form (`--opt=val`, `-oval`). These are the options whose value git itself treats as optional; a following token is never taken as their value.
- **Separate-token values:** for every other valued option, a value passed as its own token must not start with `-` (`TG_INVALID_ARGUMENT`). Attach such values instead: `--message=-wip`, `-m-wip`, `-e-pattern`.

### Top-Level Commands

| Subcommand | Allowed Flags | Allowed Valued Options | Pathspecs (`--`) / Notes | Classes & Destructive Rule |
|---|---|---|---|---|
| `status` | `-s --short -b --branch --long -z --ahead-behind --no-ahead-behind --renames --no-renames --show-stash` | `--porcelain?=enum(v1,v2)`, `-u\|--untracked-files?=enum(no,normal,all)`, `--ignored?=enum(traditional,no,matching)` | Yes | `read` |
| `log` | `--oneline --all --branches --tags --remotes --first-parent --no-merges --merges --reverse --graph --no-decorate --stat --shortstat --numstat --name-only --name-status -p --patch -i --regexp-ignore-case --abbrev-commit --no-abbrev-commit --follow -z --topo-order --date-order --left-right --cherry-pick --boundary --no-color` | `-n\|--max-count=int`, `--skip=int`, `--since\|--after\|--until\|--before=text`, `--author\|--committer\|--grep=text`, `--decorate?=enum(short,full,no)`, `-U\|--unified?=int`, `--format\|--pretty?=fmt`, `--date=text` | Yes; injects `--no-ext-diff --no-textconv` | `read` |
| `show` | `--stat --name-only --name-status -p --patch --no-patch -s --oneline --abbrev-commit -z` | `--format\|--pretty?=fmt`, `--date=text`, `-U\|--unified?=int` | Yes; injects `--no-ext-diff --no-textconv` | `read` |
| `diff` | `--cached --staged --stat --numstat --shortstat --name-only --name-status -w --ignore-all-space -b --ignore-space-change --ignore-blank-lines -M --find-renames -C --find-copies -R --minimal --patience --histogram --merge-base -z --check --exit-code --quiet` | `-U\|--unified?=int`, `--diff-filter=text`, `--diff-algorithm=enum(myers,minimal,patience,histogram)`, `--word-diff?=enum(plain,porcelain,none)` | Yes; injects `--no-ext-diff --no-textconv` (`--no-index` forbidden) | `read` |
| `ls-files` | `-c --cached -m --modified -o --others -d --deleted -i --ignored --exclude-standard -s --stage -u --unmerged -z --full-name --error-unmatch --directory --no-empty-directory --eol` | — | Yes | `read` |
| `ls-tree` | `-r -d -t -l --long -z --name-only --name-status --full-name --full-tree` | `--abbrev?=int` | Yes | `read` |
| `rev-parse` | `--verify -q --quiet --symbolic-full-name --is-inside-work-tree --is-bare-repository --is-shallow-repository --show-toplevel --git-dir --absolute-git-dir --show-prefix --show-cdup --symbolic --all --branches --tags --remotes` | `--short?=int`, `--abbrev-ref?=enum(strict,loose)`, `--default=ref` | Yes | `read` |
| `rev-list` | `--count --all --branches --tags --left-right --first-parent --no-merges --reverse` | `-n\|--max-count=int`, `--since\|--until=text` | Yes | `read` |
| `merge-base` | `--is-ancestor --all --fork-point --independent --octopus` | — | Yes | `read` |
| `describe` | `--tags --all --long --always --dirty --exact-match --contains` | `--abbrev?=int`, `--match\|--exclude=text` | Yes | `read` |
| `cat-file` | `-t -s -p -e` | — | Yes | `read` |
| `blame` | `-l -t -s -e -w -M -C --porcelain --line-porcelain --incremental --root --show-name --show-number --reverse --first-parent` | `-L=text`, `--date=text` | Yes; injects `--no-textconv` | `read` |
| `shortlog` | `-s --summary -n --numbered -e --email` | `--group=enum(author,committer)` | Yes | `read` |
| `grep` | `-n --line-number -i --ignore-case -w --word-regexp -v --invert-match -c --count -l --files-with-matches -L --files-without-match -E -F -G -P -h -H --heading --break --cached -z --and --or --not` | `-e=text`, `-A\|-B\|-C=int`, `--max-depth=int` | Yes (`--untracked`, `--no-index`, `-O`, `-f` forbidden) | `read` |
| `check-ignore` | `-v --verbose -n --non-matching --no-index -z` | — | Yes | `read` |
| `check-attr` | `-a --all --cached -z` | — | Yes | `read` |
| `count-objects` | `-v -H` | — | No pathspecs, max 0 positionals | `read` |
| `branch` | `-a --all -r --remotes -v --list --show-current -d --delete -D -m --move -M -c --copy -C -f --force --unset-upstream --track --no-track` | `--contains\|--no-contains\|--merged\|--no-merged\|--points-at=ref`, `--sort=text`, `--format=fmt`, `-u\|--set-upstream-to=ref` | Yes (`-vv` accepted as `-v -v`) | `read` when no mutating option (`-d`/`--delete`/`-D`/`-m`/`--move`/`-M`/`-c`/`--copy`/`-C`/`-f`/`--force`/`--unset-upstream`/`--track`/`--no-track`/`-u`/`--set-upstream-to`) and (0 positionals or `--list`); else `write`. Destructive if `-D`, `-M`, `-C`, `-f`, `--force` |
| `tag` | `-l --list -a -d --delete -f --force` | `-n?=int`, `--sort=text`, `--contains\|--points-at=ref`, `--format=fmt`, `-m=text` | Yes (`-s`, `-u`, `-F` forbidden) | `read` when not deleting (`-d`/`--delete`) and (`-l`/`--list` or 0 positionals); else `write`. Destructive if `-d`, `--delete`, `-f`, `--force` |
| `remote` | *(see sub-subcommand table below)* | — | No pathspecs | Per sub-subcommand |
| `reflog` | *(see sub-subcommand table below)* | — | No pathspecs | `read` |
| `stash` | *(see sub-subcommand table below)* | — | Per sub-subcommand | Per sub-subcommand |
| `config` | `-l --list -z --null --name-only --get --get-all --get-regexp --unset --unset-all --add --replace-all --local` | — | No pathspecs, max 3 positionals; injects `--local`; rejects new-style `get`/`set`/`unset`/`list`/`rename-section`/`remove-section`/`edit` | `read` for `--list`/`--get*` or 0–1 positionals without write flags; else `write` if key matches `WRITABLE_CONFIG` (and `url` validator for `remote.*.url`/`pushurl`) |
| `clean` | `-n --dry-run -f --force -d -x -X -q` | `-e=text` | Yes (`-i` forbidden) | `read` if `-n`/`--dry-run`; else `write` + `destructive` |
| `init` | `-q --quiet --bare` | `-b\|--initial-branch=ref`, `--object-format=enum(sha1,sha256)` | No pathspecs, max 0 positionals; mode `init` | `write` |
| `add` | `-A --all -u --update -N --intent-to-add -v --verbose -n --dry-run --ignore-errors --renormalize -f --force` | `--chmod=enum(+x,-x)` | Yes; sensitive pre-check on the untracked files it would stage (not for `-u`, `--renormalize`, `-n`) + post-check `unstage` | `write` |
| `rm` | `--cached -r -q --quiet -f --force -n --dry-run --ignore-unmatch` | — | Yes | `write`; `destructive` unless `--cached`, `-n`, or `--dry-run` |
| `mv` | `-k -n --dry-run -v -f --force` | — | Yes; post-check `unstage` | `write`; `destructive` if `-f`/`--force` |
| `commit` | `-a --all --amend --allow-empty --allow-empty-message --no-edit -q --quiet -s --signoff --no-verify --reset-author --only -o -i --include` | `-m\|--message=text`, `--author=text`, `--date=text`, `-C\|--reuse-message=ref`, `--fixup=ref`, `--squash=ref` | Yes; sensitive pre-check | `write` |
| `checkout` | `-q --quiet -f --force -m --merge --detach --track --no-track --ours --theirs` | `-b=ref`, `-B=ref`, `--orphan=ref`, `--conflict=enum(merge,diff3,zdiff3)` | Yes | `write`; `destructive` if `-f`, `--force`, `-B`, `--ours`, `--theirs`, any pathspec after `--`, or >= 2 positionals. For a single positional `<x>` (without `--`, `-b`, `-B`, `--orphan`), the executor runs `rev-parse --verify -q <x>^{commit}`: if it fails, `<x>` is treated as a path and marked `destructive` |
| `switch` | `-q --quiet -f --force --discard-changes --detach --track --no-track -m --merge` | `-c\|--create=ref`, `-C\|--force-create=ref`, `--orphan=ref` | No pathspecs | `write`; `destructive` if `-f`, `--force`, `--discard-changes`, `-C`, `--force-create` |
| `restore` | `-S --staged -W --worktree --ours --theirs -m --merge -q --quiet` | `-s\|--source=ref` | Yes | `write` when `-S`/`--staged` without `-W`/`--worktree`; else `write` + `destructive` |
| `reset` | `--soft --mixed --keep --hard --merge -q --quiet` | — | Yes | `write`; `destructive` if `--hard` or `--merge` |
| `merge` | `--no-ff --ff --ff-only --squash --no-commit --commit --abort --continue --quit --allow-unrelated-histories --no-edit -q --quiet --stat --no-stat --log --no-log` | `-m=text`, `-s\|--strategy=enum(ort,recursive,resolve,octopus,ours,subtree)`, `-X\|--strategy-option=text` | Yes; sensitive pre-check + post-check `warn` | `write` |
| `rebase` | `--abort --continue --skip --quit --autostash --no-autostash --rebase-merges --keep-empty --root -q --quiet --update-refs` | `--onto=ref`, `-s\|--strategy=enum(ort,recursive,resolve,octopus,ours,subtree)`, `-X=text` | Yes; sensitive pre-check + post-check `warn` (`-i`, `-x`, `--edit-todo` forbidden) | `write` |
| `cherry-pick` | `-n --no-commit -x --abort --continue --skip --quit --allow-empty --ff -s --signoff` | `-m\|--mainline=int`, `--strategy=enum(ort,recursive,resolve,octopus,ours,subtree)`, `-X=text` | Yes; sensitive pre-check + post-check `warn` (`-e`, `-S` forbidden) | `write` |
| `revert` | `-n --no-commit -x --abort --continue --skip --quit --allow-empty --ff -s --signoff` | `-m\|--mainline=int`, `--strategy=enum(ort,recursive,resolve,octopus,ours,subtree)`, `-X=text` | Yes; sensitive pre-check + post-check `warn` (`-e`, `-S` forbidden) | `write` |
| `apply` | `--check --stat --numstat --summary --cached --index -R --reverse -3 --3way --recount` | `--whitespace=enum(nowarn,warn,fix,error,error-all)`, `-p=int` | No pathspecs, max 0 positionals; requires `input` on stdin; appends `-`; post-check `unstage` (for write) | `read` if `--check`, `--stat`, `--numstat`, or `--summary`; else `write` |
| `gc` | `--aggressive --auto -q --quiet` | `--prune?=text` | No pathspecs, max 0 positionals | `write`; `destructive` if `--prune` |
| `clone` | `--single-branch --no-single-branch --no-tags --bare -n --no-checkout -q --quiet` | `--depth=int`, `-b\|--branch=ref`, `--shallow-since=text`, `--shallow-exclude=ref`, `--filter=filter`, `-o\|--origin=ref` | No pathspecs, exactly 1 positional (`https://` `url`); options may stand before or after it; the destination is always `repo`; mode `clone` | `fetch` + `write` |
| `fetch` | `--all --append -a --prune -p --prune-tags -P --tags -t --no-tags -n --dry-run -q --quiet -v -f --force --atomic --unshallow --set-upstream --refetch --no-write-fetch-head` | `--depth=int`, `--deepen=int`, `--shallow-since=text`, `--shallow-exclude=ref`, `--filter=filter`, `-j\|--jobs=int` | No pathspecs | `fetch`; `destructive` if `-f`, `--force`, `-P`, `--prune-tags`, or refspec starting with `+` |
| `pull` | `--all --prune -p --tags --no-tags -q --quiet -v --unshallow -r --no-rebase --ff --no-ff --ff-only --squash --no-commit --commit --autostash --no-autostash --allow-unrelated-histories --stat --no-stat --log --no-log` | `--rebase?=enum(true,false,merges)`, `--depth=int`, `--deepen=int`, `-s\|--strategy=enum(ort,recursive,resolve,octopus,ours,subtree)`, `-X=text` | No pathspecs; sensitive pre-check + post-check `warn` | `fetch` + `write` |
| `push` | `--all --branches --tags --follow-tags --no-follow-tags -u --set-upstream -d --delete -f --force --force-if-includes -n --dry-run -q --quiet -v --atomic --prune --mirror --no-verify --porcelain` | `--force-with-lease?=text`, `-o\|--push-option=text` | No pathspecs; 1st positional required (`TG_PUSH_REMOTE_REQUIRED`); rejects `stash`/`refs/stash` refspec source and sources starting with `-` | `push`; `destructive` if `-f`, `--force`, `--force-with-lease`, `-d`, `--delete`, `--prune`, `--mirror`, or refspec starting with `+` or `:` |
| `ls-remote` | `--heads --branches -t --tags --refs -q --quiet --exit-code --symref --get-url` | `--sort=text` | No pathspecs; defaults to repo's branch remote or `origin` | `fetch` |

### Sub-Subcommand Tables

#### `remote`

| Sub-subcommand | Flags / Valued Options | Positionals | Classes & Rules |
|---|---|---|---|
| *(bare `remote`)* | `-v` | `0` | `read` |
| `get-url` | `--push --all` | `1` | `read` |
| `show` | `-n` | `>= 1` | `read`; requires `-n` (`TG_FORBIDDEN_ARGUMENT` otherwise) |
| `add` | `-f --tags --no-tags`; `-t=ref`, `-m=ref` | `2` (`<name> <url>`) | `write` (+ `fetch` if `-f`); validates remote name and `https://` URL |
| `rename` | — | `2` | `write` |
| `remove` / `rm` | — | `1` | `write` + `destructive` |
| `set-head` | `-a --auto -d --delete` | `1..2` | `write` (+ `fetch` if `-a`/`--auto`) |
| `set-branches` | `--add` | `>= 2` | `write` |
| `set-url` | `--push --add --delete` | `2..3` (`2` for `--delete`) | `write`; validates URL unless `--delete` |
| `prune` | `-n --dry-run` | `>= 1` | `fetch` + `write` |
| `update` | `-p --prune` | `>= 0` | `fetch` (all remotes if no positional given) |

#### `reflog`

| Sub-subcommand | Flags / Valued Options | Positionals | Classes |
|---|---|---|---|
| *(bare `reflog`)* / `show` | `--oneline`; `-n=int`, `--format?=fmt`, `--date=text` | `0..1` | `read` |
| `exists` | — | `1` | `read` |

#### `stash`

| Sub-subcommand | Flags / Valued Options | Pathspecs / Positionals | Classes & Rules |
|---|---|---|---|
| *(bare `stash`)* / `push` | `-u --include-untracked -k --keep-index --staged -q`; `-m\|--message=text` | Pathspecs yes, `0` positionals | `write`; untracked sensitive pre-check if `-u`/`--include-untracked` |
| `list` | — | No pathspecs, `0` positionals | `read` |
| `show` | `-p --patch --stat --name-only` | No pathspecs, `0..1`; injects `--no-ext-diff --no-textconv` | `read` |
| `apply` | `--index -q` | No pathspecs, `0..1` | `write` |
| `pop` | `--index -q` | No pathspecs, `0..1` | `write` |
| `branch` | — | No pathspecs, `1..2` | `write` |
| `drop` | `-q` | No pathspecs, `0..1` | `write` + `destructive` |
| `clear` | — | No pathspecs, `0` | `write` + `destructive` |

### Writable Config Keys (`WRITABLE_CONFIG`)

Only keys matching these case-insensitive patterns may be modified via `git config` (all other keys are rejected with `TG_FORBIDDEN_ARGUMENT`):

- `^user\.(name|email)$`
- `^core\.(autocrlf|eol|safecrlf|ignorecase|filemode|longpaths)$`
- `^init\.defaultbranch$`
- `^pull\.(rebase|ff)$`
- `^merge\.(ff|conflictstyle)$`
- `^push\.(default|autosetupremote|followtags)$`
- `^fetch\.(prune|prunetags)$`
- `^gc\.auto$`
- `^rerere\.enabled$`
- `^diff\.(renames|algorithm)$`
- `^status\.showuntrackedfiles$`
- `^i18n\.(commitencoding|logoutputencoding)$`
- `^remote\.pushdefault$`
- `^remote\..+\.(url|pushurl|fetch|push|tagopt|prune)$`
- `^branch\..+\.(remote|pushremote|merge|rebase)$`

---

## 4. Error Codes

### Server Error Codes (`server-plugin/lib/constants.mjs`)

| Code | HTTP Status | Meaning |
|---|---|---|
| `TG_BAD_REQUEST` | `400` | Malformed request body, invalid `caller` fields, or invalid `args`/`input` shape. |
| `TG_ADMIN_REQUIRED` | `403` | Authenticated SillyTavern user is not an admin (`req.user.profile.admin !== true`). |
| `TG_BAD_INSTALL_LOCATION` | `503` | Server plugin could not locate the SillyTavern root (`server.js` + `package.json` `name === "sillytavern"`). |
| `TG_GIT_UNAVAILABLE` | `503` | Git cannot run (see `details.reason` for `TG_MINGIT_MISSING`, `TG_GIT_MISSING`, or `TG_GIT_TOO_OLD`). |
| `TG_MINGIT_MISSING` | `503` | Windows: `<serverPluginDir>/mingit/cmd/git.exe` was not found or failed `--version`. |
| `TG_GIT_MISSING` | `503` | Non-Windows: executable `git` was not found on `PATH` or failed `--version`. |
| `TG_GIT_TOO_OLD` | `503` | Detected git version is older than `2.32.0`. |
| `TG_INVALID_PATH` | `400` | Virtual path syntax is invalid (bad zone, `\`, control chars, `:`, or `..` segment). |
| `TG_PATH_OUTSIDE_ROOT` | `403` | Path (or symlink inside it) resolves outside the SillyTavern root. |
| `TG_ZONE_UNAVAILABLE` | `404` | Zone such as `@STdata` or `@STuser` is unavailable (e.g. ST 1.11.x with no data root, or `dataRoot` unset / outside ST root). |
| `TG_NOT_A_REPOSITORY` | `404` | Target directory is neither a worktree repository nor a bare repository. |
| `TG_DEST_NOT_EMPTY` | `409` | `clone` destination already exists and is not an empty directory. |
| `TG_UNSUPPORTED_REPO_LAYOUT` | `422` | Repository uses a `.git` gitfile (worktree/submodule) or `commondir`, or has no `.git` directory and does not set `core.bare = true`. |
| `TG_UNSAFE_REPO_LAYOUT` | `422` | Repository path is a `.git` directory or lies inside a git directory; or the repository's `gitDir`, a symlink directly inside it, or an `objects/info/alternates` entry leads outside the SillyTavern root. |
| `TG_UNSAFE_REPO_CONFIG` | `422` | Repository `.git/config` (or `config.worktree`) contains non-allowlisted keys (`details.keys`) or invalid remote URLs. |
| `TG_FORBIDDEN_COMMAND` | `422` | Subcommand or sub-subcommand is not allowlisted (or global options/aliases were passed). |
| `TG_FORBIDDEN_OPTION` | `422` | Option flag or option name is not allowlisted for the subcommand. |
| `TG_FORBIDDEN_ARGUMENT` | `422` | Argument violates policy (e.g. path escaping repo, disallowed config key, pushing `stash`). |
| `TG_INVALID_ARGUMENT` | `400` | Invalid option value, an option value starting with `-` that is not attached to its option, missing operand, too many operands, unknown remote name, a `push` refspec source starting with `-`, or `add`/`push` pre-check enumeration failure (`ls-files` / `rev-list --objects` failed closed). |
| `TG_FORBIDDEN_URL` | `422` | Remote URL is not plain `https://` or contains embedded credentials / unsupported characters. |
| `TG_PUSH_REMOTE_REQUIRED` | `422` | `git push` called without an explicit remote name or URL. |
| `TG_SENSITIVE_PATH` | `422` | Sensitive file (e.g. `secrets.json`, `config.yaml`) matched during a pre-check (`add` included, before anything is staged), the `add`/`mv`/`apply` post-check, or the `push` history check (`details.paths`). |
| `TG_SENSITIVE_PATH_TRACKED` | *(warning)* | Returned in `warnings[]` (not an error) when `merge`/`rebase`/`cherry-pick`/`revert`/`pull` leaves a sensitive path tracked. |
| `TG_CONSENT_REQUIRED` | `409` | No covering grant or valid `approvalId`; response includes `consent` summary for the UI dialog. |
| `TG_CONSENT_DENIED` | `403` | User denied the consent request (`POST /consent`). |
| `TG_CONSENT_EXPIRED` | `410` | Pending request expired (5 min), `approvalId` expired (120 s) / already consumed / mismatched (including a repository whose classes, hosts or tier changed after the prompt), or 3 wrong console codes invalidated the request. |
| `TG_CONSOLE_CODE_INVALID` | `403` | Supplied 6-digit server console confirmation code did not match. |
| `TG_TIMEOUT` | `504` | Git process exceeded `timeoutMs` and its process tree was killed. |
| `TG_OUTPUT_TOO_LARGE` | `413` | Combined `stdout` + `stderr` exceeded the 32 MiB output cap. |
| `TG_INTERNAL` | `500` | Unexpected internal server error. |

### Client-Only Error Codes (`src/errors.js`)

| Code | Meaning |
|---|---|
| `TG_SERVER_PLUGIN_MISSING` | Server returned HTTP 404 without a TavernGit error JSON body (server plugin not installed/enabled, or running on TauriTavern). |
| `TG_PROTOCOL_MISMATCH` | Server plugin `protocol` does not match the UI extension's `PROTOCOL_VERSION`. Update both parts. |
| `TG_GIT_FAILED` | A high-level client helper (`init`, `clone`, `status`, `log`, `add`, `commit`, `diff`, `fetch`, `pull`, `push`) received a non-zero `exitCode` from git. |
