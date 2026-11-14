/**
 * Command policy: the allowlist parser that decides which git argv may run
 * and how risky it is. This is the security boundary for arguments.
 *
 * Everything not declared here is forbidden: global options (`-c`, `-C`,
 * `--git-dir`, ...) cannot appear because `args[0]` must be an allowlisted
 * subcommand, aliases cannot run, and any undeclared option of a subcommand
 * is rejected by name. Declared tokens are passed to git unchanged, so what
 * was validated is exactly what runs.
 */
import { fail } from './errors.mjs';

const MAX_TOKEN = 4096;
const MAX_TEXT = 65536;
const STRATEGIES = 'enum(ort,recursive,resolve,octopus,ours,subtree)';
const REMOTE_NAME = /^[A-Za-z0-9._/-]+$/;

// ---------------------------------------------------------------------------
// Value validators

/**
 * Validate an HTTPS remote URL and return its lowercased `host[:port]`.
 * Characters on which URL parsers disagree (`\`, `@`, whitespace, non-ASCII)
 * are rejected outright, so the host we show in the consent dialog and scope
 * credentials to is the host git connects to. Userinfo is never allowed:
 * credentials belong in the server-side store.
 * @param {string} value
 * @returns {string} host
 */
export function validateUrl(value) {
    if (typeof value !== 'string' || value.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(value) || /[\\@]/.test(value)) {
        fail('TG_FORBIDDEN_URL', 'Remote URLs must be plain https:// URLs without credentials');
    }
    // Literal prefix: WHATWG parsing also accepts `https:host` and `HTTPS://host`,
    // which git reads as an scp-style path or as an unknown transport.
    if (!value.startsWith('https://')) fail('TG_FORBIDDEN_URL', `Only https:// remotes are allowed: ${value}`);
    let url;
    try {
        url = new URL(value);
    } catch {
        fail('TG_FORBIDDEN_URL', `Not a valid URL: ${value}`);
    }
    if (url.username || url.password) fail('TG_FORBIDDEN_URL', 'URLs must not contain credentials');
    if (!/^([a-z0-9.-]+|\[[0-9a-f:.]+\])$/i.test(url.hostname)) fail('TG_FORBIDDEN_URL', `Unsupported host name: ${url.hostname}`);
    return url.host.toLowerCase();
}

/** True when a remote argument is a URL rather than a configured remote name. */
export function looksLikeUrl(value) {
    return value.includes(':');
}

// Padding atoms in pretty formats (`%<(N)`, `%>(N)`, `%><(N)`, `%>>(N)`,
// `%<|(N)`) are the CVE-2022-41903 heap overflow vector. Distros backport the
// fix without changing the version, so we cannot gate on version; we reject.
const PADDING_ATOM = /%(<|>|><|>>)(\||\()/;

const VALIDATORS = {
    int: (value) => /^\d{1,9}$/.test(value),
    text: (value) => !value.includes('\0') && value.length <= MAX_TEXT,
    // eslint-disable-next-line no-control-regex
    ref: (value) => !/[\x00-\x1f\x7f]/.test(value) && !value.startsWith('-') && value.length > 0 && value.length <= 1024,
    fmt: (value) => VALIDATORS.text(value) && !PADDING_ATOM.test(value),
    filter: (value) => /^(blob:none|blob:limit=\d+[kmg]?|tree:0)$/.test(value),
    url: (value) => Boolean(validateUrl(value)),
};

function checkValue(option, type, value) {
    const enumMatch = /^enum\((.*)\)$/.exec(type);
    const ok = enumMatch ? enumMatch[1].split(',').includes(value) : VALIDATORS[type](value);
    if (!ok) fail('TG_INVALID_ARGUMENT', `Invalid value for ${option}`);
}

// ---------------------------------------------------------------------------
// Option declarations

/**
 * Compile a spec. `flags` is a space-separated list of value-less options.
 * Each `valued` entry is `names[?]=type`: `names` are `|`-separated aliases,
 * `?` marks an optional value (only accepted attached: `--opt=v`, `-ov`).
 */
function spec({ flags = '', valued = [], pathspecs = true, minPositionals = 0, maxPositionals = Infinity }) {
    const options = new Map();
    for (const name of flags.split(/\s+/).filter(Boolean)) options.set(name, { valued: false });
    for (const entry of valued) {
        const [, names, optional, type] = /^([^?=]+)(\?)?=(.+)$/.exec(entry);
        for (const name of names.split('|')) options.set(name, { valued: true, optional: Boolean(optional), type });
    }
    return { options, pathspecs, minPositionals, maxPositionals };
}

/**
 * True when a positional or pathspec could make git touch files outside the
 * repository: absolute paths, Windows drive or UNC forms, and `..` segments.
 * (`git diff a b` silently becomes `--no-index` when a path is outside the
 * work tree, which would read arbitrary files.)
 */
function escapesRepo(value) {
    if (/^([/\\]|[A-Za-z]:)/.test(value)) return true;
    return value.split(/[/\\]/).includes('..');
}

function checkOperand(value, kind) {
    if (value.includes('\0') || value.length > MAX_TOKEN) fail('TG_INVALID_ARGUMENT', `Invalid ${kind}`);
    if (escapesRepo(value)) fail('TG_FORBIDDEN_ARGUMENT', `${kind} must stay inside the repository: ${value}`);
}

/**
 * Take the value of `name` from its own token. Such a value must not look
 * like an option: where git treats the value as optional it would read the
 * token as another option, one this policy never validated. The attached
 * form (`--opt=value`, `-ovalue`) is unambiguous and stays available.
 */
function takeDetachedValue(tokens, index, name, label) {
    if (index >= tokens.length) fail('TG_INVALID_ARGUMENT', `${label}: ${name} needs a value`);
    const value = tokens[index];
    if (value.startsWith('-')) {
        fail('TG_INVALID_ARGUMENT', `${label}: a value for ${name} that starts with "-" must be attached to the option`);
    }
    return value;
}

/**
 * Parse tokens against a compiled spec. `optionTokens` are the tokens that
 * form options and their values, in order, as they were given.
 * @returns {{ opts: Array<{name: string, value?: string}>, optionTokens: string[], positionals: string[], pathspecs: string[], dashDash: boolean }}
 */
function parse(tokens, compiled, label) {
    const opts = [];
    const optionTokens = [];
    const positionals = [];
    const pathspecs = [];
    let dashDash = false;

    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (dashDash) {
            checkOperand(token, 'pathspec');
            pathspecs.push(token);
            continue;
        }
        if (token === '--') {
            if (!compiled.pathspecs) fail('TG_FORBIDDEN_ARGUMENT', `${label} does not take "--" pathspecs`);
            dashDash = true;
            continue;
        }
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            const name = eq < 0 ? token : token.slice(0, eq);
            const option = compiled.options.get(name);
            if (!option) fail('TG_FORBIDDEN_OPTION', `${label}: option ${name} is not allowed`);
            optionTokens.push(token);
            if (!option.valued) {
                if (eq >= 0) fail('TG_FORBIDDEN_OPTION', `${label}: option ${name} does not take a value`);
                opts.push({ name });
            } else if (eq >= 0) {
                const value = token.slice(eq + 1);
                checkValue(name, option.type, value);
                opts.push({ name, value });
            } else if (option.optional) {
                opts.push({ name });
            } else {
                const value = takeDetachedValue(tokens, ++i, name, label);
                checkValue(name, option.type, value);
                opts.push({ name, value });
                optionTokens.push(value);
            }
            continue;
        }
        if (token.startsWith('-') && token.length > 1) {
            // Short options: letters are flags until one takes a value; the
            // rest of the token (or the next token) is that value.
            optionTokens.push(token);
            for (let j = 1; j < token.length; j += 1) {
                const name = `-${token[j]}`;
                const option = compiled.options.get(name);
                if (!option) fail('TG_FORBIDDEN_OPTION', `${label}: option ${name} is not allowed`);
                if (!option.valued) {
                    opts.push({ name });
                    continue;
                }
                let value = token.slice(j + 1);
                if (!value && !option.optional) {
                    value = takeDetachedValue(tokens, ++i, name, label);
                    optionTokens.push(value);
                }
                if (value) checkValue(name, option.type, value);
                opts.push(value ? { name, value } : { name });
                break;
            }
            continue;
        }
        if (token.startsWith('-')) fail('TG_INVALID_ARGUMENT', `${label}: "-" is not allowed`);
        checkOperand(token, 'argument');
        positionals.push(token);
    }

    if (positionals.length < compiled.minPositionals) fail('TG_INVALID_ARGUMENT', `${label}: missing argument`);
    if (positionals.length > compiled.maxPositionals) fail('TG_INVALID_ARGUMENT', `${label}: too many arguments`);
    return { opts, optionTokens, positionals, pathspecs, dashDash };
}

// ---------------------------------------------------------------------------
// Classification helpers

/** Mutable analysis record shared by the classifiers. */
function newAnalysis(subcommand) {
    return {
        subcommand,
        argv: [],
        classes: new Set(),
        destructive: false,
        destructiveReasons: [],
        network: { urls: [], remoteNames: [], implicit: null, push: false },
        pushRefspecs: [],
        pushFlags: [],
        needsSensitivePreCheck: false,
        needsUntrackedPreCheck: false,
        needsSensitivePostCheck: null,
        mode: 'repo',
        cloneUrl: null,
        requiresInput: false,
        checkoutTarget: null,
        cloneOptions: [],
        addPreCheck: null,
    };
}

function has(parsed, ...names) {
    return parsed.opts.some((opt) => names.includes(opt.name));
}

function present(parsed, ...names) {
    return parsed.opts.filter((opt) => names.includes(opt.name)).map((opt) => opt.name);
}

function markDestructive(analysis, ...reasons) {
    analysis.destructive = true;
    for (const reason of reasons) {
        if (!analysis.destructiveReasons.includes(reason)) analysis.destructiveReasons.push(reason);
    }
}

function destructiveIf(analysis, parsed, ...names) {
    const found = present(parsed, ...names);
    if (found.length) markDestructive(analysis, ...found);
}

/**
 * Record a remote argument: a configured remote name (resolved to a host by
 * the executor from repo config) or an https URL.
 */
function addRemote(analysis, value) {
    if (looksLikeUrl(value)) {
        validateUrl(value);
        analysis.network.urls.push(value);
    } else if (REMOTE_NAME.test(value)) {
        analysis.network.remoteNames.push(value);
    } else {
        fail('TG_INVALID_ARGUMENT', `Not a remote name or URL: ${value}`);
    }
}

const read = (analysis) => analysis.classes.add('read');
const write = (analysis) => analysis.classes.add('write');

// ---------------------------------------------------------------------------
// The allowlist (docs/api.md mirrors this table; keep both in step)

const LOG_FLAGS = '--oneline --all --branches --tags --remotes --first-parent --no-merges --merges --reverse --graph --no-decorate --stat --shortstat --numstat --name-only --name-status -p --patch -i --regexp-ignore-case --abbrev-commit --no-abbrev-commit --follow -z --topo-order --date-order --left-right --cherry-pick --boundary --no-color';

/** Inserted right after the (sub-)subcommand: never run external diff or textconv programs. */
const NO_EXTERNAL_DIFF = ['--no-ext-diff', '--no-textconv'];

const COMMANDS = {
    status: {
        spec: spec({
            flags: '-s --short -b --branch --long -z --ahead-behind --no-ahead-behind --renames --no-renames --show-stash',
            valued: ['--porcelain?=enum(v1,v2)', '-u|--untracked-files?=enum(no,normal,all)', '--ignored?=enum(traditional,no,matching)'],
        }),
        classify: read,
    },
    log: {
        spec: spec({
            flags: LOG_FLAGS,
            valued: ['-n|--max-count=int', '--skip=int', '--since|--after|--until|--before=text', '--author|--committer|--grep=text',
                '--decorate?=enum(short,full,no)', '-U|--unified?=int', '--format|--pretty?=fmt', '--date=text'],
        }),
        inject: NO_EXTERNAL_DIFF,
        classify: read,
    },
    show: {
        spec: spec({
            flags: '--stat --name-only --name-status -p --patch --no-patch -s --oneline --abbrev-commit -z',
            valued: ['--format|--pretty?=fmt', '--date=text', '-U|--unified?=int'],
        }),
        inject: NO_EXTERNAL_DIFF,
        classify: read,
    },
    diff: {
        spec: spec({
            flags: '--cached --staged --stat --numstat --shortstat --name-only --name-status -w --ignore-all-space -b --ignore-space-change --ignore-blank-lines -M --find-renames -C --find-copies -R --minimal --patience --histogram --merge-base -z --check --exit-code --quiet',
            valued: ['-U|--unified?=int', '--diff-filter=text', '--diff-algorithm=enum(myers,minimal,patience,histogram)', '--word-diff?=enum(plain,porcelain,none)'],
        }),
        inject: NO_EXTERNAL_DIFF,
        classify: read,
    },
    'ls-files': {
        spec: spec({ flags: '-c --cached -m --modified -o --others -d --deleted -i --ignored --exclude-standard -s --stage -u --unmerged -z --full-name --error-unmatch --directory --no-empty-directory --eol' }),
        classify: read,
    },
    'ls-tree': {
        spec: spec({ flags: '-r -d -t -l --long -z --name-only --name-status --full-name --full-tree', valued: ['--abbrev?=int'] }),
        classify: read,
    },
    'rev-parse': {
        spec: spec({
            flags: '--verify -q --quiet --symbolic-full-name --is-inside-work-tree --is-bare-repository --is-shallow-repository --show-toplevel --git-dir --absolute-git-dir --show-prefix --show-cdup --symbolic --all --branches --tags --remotes',
            valued: ['--short?=int', '--abbrev-ref?=enum(strict,loose)', '--default=ref'],
        }),
        classify: read,
    },
    'rev-list': {
        spec: spec({ flags: '--count --all --branches --tags --left-right --first-parent --no-merges --reverse', valued: ['-n|--max-count=int', '--since|--until=text'] }),
        classify: read,
    },
    'merge-base': {
        spec: spec({ flags: '--is-ancestor --all --fork-point --independent --octopus' }),
        classify: read,
    },
    describe: {
        spec: spec({ flags: '--tags --all --long --always --dirty --exact-match --contains', valued: ['--abbrev?=int', '--match|--exclude=text'] }),
        classify: read,
    },
    'cat-file': {
        spec: spec({ flags: '-t -s -p -e' }),
        classify: read,
    },
    blame: {
        spec: spec({
            flags: '-l -t -s -e -w -M -C --porcelain --line-porcelain --incremental --root --show-name --show-number --reverse --first-parent',
            valued: ['-L=text', '--date=text'],
        }),
        inject: ['--no-textconv'],
        classify: read,
    },
    shortlog: {
        spec: spec({ flags: '-s --summary -n --numbered -e --email', valued: ['--group=enum(author,committer)'] }),
        classify: read,
    },
    grep: {
        spec: spec({
            flags: '-n --line-number -i --ignore-case -w --word-regexp -v --invert-match -c --count -l --files-with-matches -L --files-without-match -E -F -G -P -h -H --heading --break --cached -z --and --or --not',
            valued: ['-e=text', '-A|-B|-C=int', '--max-depth=int'],
        }),
        classify: read,
    },
    'check-ignore': {
        spec: spec({ flags: '-v --verbose -n --non-matching --no-index -z' }),
        classify: read,
    },
    'check-attr': {
        spec: spec({ flags: '-a --all --cached -z' }),
        classify: read,
    },
    'count-objects': {
        spec: spec({ flags: '-v -H', pathspecs: false, maxPositionals: 0 }),
        classify: read,
    },
    branch: {
        spec: spec({
            flags: '-a --all -r --remotes -v --list --show-current -d --delete -D -m --move -M -c --copy -C -f --force --unset-upstream --track --no-track',
            valued: ['--contains|--no-contains|--merged|--no-merged|--points-at=ref', '--sort=text', '--format=fmt', '-u|--set-upstream-to=ref'],
        }),
        classify(analysis, parsed) {
            const mutating = has(parsed, '-d', '--delete', '-D', '-m', '--move', '-M', '-c', '--copy', '-C', '-f', '--force',
                '--unset-upstream', '--track', '--no-track', '-u', '--set-upstream-to');
            if (!mutating && (parsed.positionals.length === 0 || has(parsed, '--list'))) return read(analysis);
            write(analysis);
            destructiveIf(analysis, parsed, '-D', '-M', '-C', '-f', '--force');
        },
    },
    tag: {
        spec: spec({
            flags: '-l --list -a -d --delete -f --force',
            valued: ['-n?=int', '--sort=text', '--contains|--points-at=ref', '--format=fmt', '-m=text'],
        }),
        classify(analysis, parsed) {
            const deleting = has(parsed, '-d', '--delete');
            if (!deleting && (has(parsed, '-l', '--list') || parsed.positionals.length === 0)) return read(analysis);
            write(analysis);
            destructiveIf(analysis, parsed, '-d', '--delete', '-f', '--force');
        },
    },
    remote: { subcommands: true },
    reflog: { subcommands: true },
    stash: { subcommands: true },
    config: {
        spec: spec({
            flags: '-l --list -z --null --name-only --get --get-all --get-regexp --unset --unset-all --add --replace-all --local',
            pathspecs: false,
            maxPositionals: 3,
        }),
        classify: classifyConfig,
    },
    clean: {
        spec: spec({ flags: '-n --dry-run -f --force -d -x -X -q', valued: ['-e=text'] }),
        classify(analysis, parsed) {
            if (has(parsed, '-n', '--dry-run')) return read(analysis);
            write(analysis);
            markDestructive(analysis, 'clean');
        },
    },
    init: {
        spec: spec({ flags: '-q --quiet --bare', valued: ['-b|--initial-branch=ref', '--object-format=enum(sha1,sha256)'], pathspecs: false, maxPositionals: 0 }),
        classify(analysis) {
            write(analysis);
            analysis.mode = 'init';
        },
    },
    add: {
        spec: spec({ flags: '-A --all -u --update -N --intent-to-add -v --verbose -n --dry-run --ignore-errors --renormalize -f --force', valued: ['--chmod=enum(+x,-x)'] }),
        classify(analysis, parsed) {
            write(analysis);
            analysis.needsSensitivePostCheck = 'unstage';
            // Every other form can stage a file git does not track yet; the
            // executor vets those files before git hashes them into the object store.
            if (!has(parsed, '-u', '--update', '--renormalize', '-n', '--dry-run')) {
                analysis.addPreCheck = {
                    pathspecs: [...parsed.positionals, ...parsed.pathspecs],
                    all: has(parsed, '-A', '--all'),
                    includeIgnored: has(parsed, '-f', '--force'),
                };
            }
        },
    },
    rm: {
        spec: spec({ flags: '--cached -r -q --quiet -f --force -n --dry-run --ignore-unmatch' }),
        classify(analysis, parsed) {
            write(analysis);
            if (!has(parsed, '--cached', '-n', '--dry-run')) markDestructive(analysis, 'rm (deletes working tree files)');
        },
    },
    mv: {
        spec: spec({ flags: '-k -n --dry-run -v -f --force' }),
        classify(analysis, parsed) {
            write(analysis);
            destructiveIf(analysis, parsed, '-f', '--force');
            analysis.needsSensitivePostCheck = 'unstage';
        },
    },
    commit: {
        spec: spec({
            flags: '-a --all --amend --allow-empty --allow-empty-message --no-edit -q --quiet -s --signoff --no-verify --reset-author --only -o -i --include',
            valued: ['-m|--message=text', '--author=text', '--date=text', '-C|--reuse-message=ref', '--fixup=ref', '--squash=ref'],
        }),
        classify(analysis) {
            write(analysis);
            analysis.needsSensitivePreCheck = true;
        },
    },
    checkout: {
        spec: spec({
            flags: '-q --quiet -f --force -m --merge --detach --track --no-track --ours --theirs',
            valued: ['-b=ref', '-B=ref', '--orphan=ref', '--conflict=enum(merge,diff3,zdiff3)'],
        }),
        classify(analysis, parsed) {
            write(analysis);
            destructiveIf(analysis, parsed, '-f', '--force', '-B', '--ours', '--theirs');
            if (parsed.pathspecs.length) markDestructive(analysis, 'checkout -- <paths> (discards changes)');
            if (parsed.positionals.length >= 2) markDestructive(analysis, 'checkout <tree> <paths> (overwrites files)');
            // `checkout <x>` switches branches when x is a commit and discards
            // changes when x is a path; the executor resolves which it is.
            if (parsed.positionals.length === 1 && !parsed.dashDash && !has(parsed, '-b', '-B', '--orphan')) {
                analysis.checkoutTarget = parsed.positionals[0];
            }
        },
    },
    switch: {
        spec: spec({ flags: '-q --quiet -f --force --discard-changes --detach --track --no-track -m --merge', valued: ['-c|--create=ref', '-C|--force-create=ref', '--orphan=ref'], pathspecs: false }),
        classify(analysis, parsed) {
            write(analysis);
            destructiveIf(analysis, parsed, '-f', '--force', '--discard-changes', '-C', '--force-create');
        },
    },
    restore: {
        spec: spec({ flags: '-S --staged -W --worktree --ours --theirs -m --merge -q --quiet', valued: ['-s|--source=ref'] }),
        classify(analysis, parsed) {
            write(analysis);
            const onlyStaged = has(parsed, '-S', '--staged') && !has(parsed, '-W', '--worktree');
            if (!onlyStaged) markDestructive(analysis, 'restore (overwrites working tree files)');
        },
    },
    reset: {
        spec: spec({ flags: '--soft --mixed --keep --hard --merge -q --quiet' }),
        classify(analysis, parsed) {
            write(analysis);
            destructiveIf(analysis, parsed, '--hard', '--merge');
        },
    },
    merge: {
        spec: spec({
            flags: '--no-ff --ff --ff-only --squash --no-commit --commit --abort --continue --quit --allow-unrelated-histories --no-edit -q --quiet --stat --no-stat --log --no-log',
            valued: ['-m=text', `-s|--strategy=${STRATEGIES}`, '-X|--strategy-option=text'],
        }),
        classify: writeWithSensitiveChecks,
    },
    rebase: {
        spec: spec({
            flags: '--abort --continue --skip --quit --autostash --no-autostash --rebase-merges --keep-empty --root -q --quiet --update-refs',
            valued: ['--onto=ref', `-s|--strategy=${STRATEGIES}`, '-X=text'],
        }),
        classify: writeWithSensitiveChecks,
    },
    'cherry-pick': {
        spec: spec({ flags: '-n --no-commit -x --abort --continue --skip --quit --allow-empty --ff -s --signoff', valued: ['-m|--mainline=int', `--strategy=${STRATEGIES}`, '-X=text'] }),
        classify: writeWithSensitiveChecks,
    },
    revert: {
        spec: spec({ flags: '-n --no-commit -x --abort --continue --skip --quit --allow-empty --ff -s --signoff', valued: ['-m|--mainline=int', `--strategy=${STRATEGIES}`, '-X=text'] }),
        classify: writeWithSensitiveChecks,
    },
    apply: {
        spec: spec({
            flags: '--check --stat --numstat --summary --cached --index -R --reverse -3 --3way --recount',
            valued: ['--whitespace=enum(nowarn,warn,fix,error,error-all)', '-p=int'],
            pathspecs: false,
            maxPositionals: 0,
        }),
        // The patch always comes from the request body on stdin.
        append: ['-'],
        classify(analysis, parsed) {
            analysis.requiresInput = true;
            // These options turn off applying (unless --apply, which is not allowed).
            if (has(parsed, '--check', '--stat', '--numstat', '--summary')) return read(analysis);
            write(analysis);
            analysis.needsSensitivePostCheck = 'unstage';
        },
    },
    gc: {
        spec: spec({ flags: '--aggressive --auto -q --quiet', valued: ['--prune?=text'], pathspecs: false, maxPositionals: 0 }),
        classify(analysis, parsed) {
            write(analysis);
            destructiveIf(analysis, parsed, '--prune');
        },
    },
    clone: {
        spec: spec({
            flags: '--single-branch --no-single-branch --no-tags --bare -n --no-checkout -q --quiet',
            valued: ['--depth=int', '-b|--branch=ref', '--shallow-since=text', '--shallow-exclude=ref', '--filter=filter', '-o|--origin=ref'],
            pathspecs: false,
            minPositionals: 1,
            maxPositionals: 1,
        }),
        classify(analysis, parsed) {
            const [url] = parsed.positionals;
            if (!looksLikeUrl(url)) fail('TG_FORBIDDEN_URL', 'clone needs an https:// URL');
            validateUrl(url);
            analysis.classes.add('fetch');
            write(analysis);
            analysis.mode = 'clone';
            analysis.cloneUrl = url;
            analysis.cloneOptions = parsed.optionTokens;
            analysis.network.urls.push(url);
        },
    },
    fetch: {
        spec: spec({
            flags: '--all --append -a --prune -p --prune-tags -P --tags -t --no-tags -n --dry-run -q --quiet -v -f --force --atomic --unshallow --set-upstream --refetch --no-write-fetch-head',
            valued: ['--depth=int', '--deepen=int', '--shallow-since=text', '--shallow-exclude=ref', '--filter=filter', '-j|--jobs=int'],
            pathspecs: false,
        }),
        classify(analysis, parsed) {
            analysis.classes.add('fetch');
            destructiveIf(analysis, parsed, '-f', '--force', '-P', '--prune-tags');
            remoteAndRefspecs(analysis, parsed, has(parsed, '--all'));
            for (const refspec of parsed.positionals.slice(1)) {
                if (refspec.startsWith('+')) markDestructive(analysis, `forced refspec ${refspec}`);
            }
        },
    },
    pull: {
        spec: spec({
            flags: '--all --prune -p --tags --no-tags -q --quiet -v --unshallow -r --no-rebase --ff --no-ff --ff-only --squash --no-commit --commit --autostash --no-autostash --allow-unrelated-histories --stat --no-stat --log --no-log',
            valued: ['--rebase?=enum(true,false,merges)', '--depth=int', '--deepen=int', `-s|--strategy=${STRATEGIES}`, '-X=text'],
            pathspecs: false,
        }),
        classify(analysis, parsed) {
            analysis.classes.add('fetch');
            writeWithSensitiveChecks(analysis);
            remoteAndRefspecs(analysis, parsed, has(parsed, '--all'));
        },
    },
    push: {
        spec: spec({
            flags: '--all --branches --tags --follow-tags --no-follow-tags -u --set-upstream -d --delete -f --force --force-if-includes -n --dry-run -q --quiet -v --atomic --prune --mirror --no-verify --porcelain',
            valued: ['--force-with-lease?=text', '-o|--push-option=text'],
            pathspecs: false,
        }),
        classify: classifyPush,
    },
    'ls-remote': {
        spec: spec({ flags: '--heads --branches -t --tags --refs -q --quiet --exit-code --symref --get-url', valued: ['--sort=text'], pathspecs: false }),
        classify(analysis, parsed) {
            analysis.classes.add('fetch');
            if (parsed.positionals.length) addRemote(analysis, parsed.positionals[0]);
            else analysis.network.implicit = 'default';
        },
    },
};

function writeWithSensitiveChecks(analysis) {
    write(analysis);
    analysis.needsSensitivePreCheck = true;
    analysis.needsSensitivePostCheck = 'warn';
}

function remoteAndRefspecs(analysis, parsed, all) {
    if (all) analysis.network.implicit = 'all';
    else if (parsed.positionals.length) addRemote(analysis, parsed.positionals[0]);
    else analysis.network.implicit = 'default';
}

/** Lowercased-key regexes for `git config` writes (and part of the audit allowlist). */
export const WRITABLE_CONFIG = [
    /^user\.(name|email)$/,
    /^core\.(autocrlf|eol|safecrlf|ignorecase|filemode|longpaths)$/,
    /^init\.defaultbranch$/,
    /^pull\.(rebase|ff)$/,
    /^merge\.(ff|conflictstyle)$/,
    /^push\.(default|autosetupremote|followtags)$/,
    /^fetch\.(prune|prunetags)$/,
    /^gc\.auto$/,
    /^rerere\.enabled$/,
    /^diff\.(renames|algorithm)$/,
    /^status\.showuntrackedfiles$/,
    /^i18n\.(commitencoding|logoutputencoding)$/,
    /^remote\.pushdefault$/,
    /^remote\..+\.(url|pushurl|fetch|push|tagopt|prune)$/,
    /^branch\..+\.(remote|pushremote|merge|rebase)$/,
];

/** True when `key` matches one of `patterns` (case-insensitive, as git keys are). */
export function configKeyAllowed(key, patterns) {
    return patterns.some((pattern) => new RegExp(pattern.source, 'i').test(key));
}

function classifyConfig(analysis, parsed) {
    const [key, value] = parsed.positionals;
    // New-style `git config get/set/...` (git 2.46+) would bypass the flag-based classification.
    if (key && /^(get|set|unset|list|rename-section|remove-section|edit)$/.test(key)) {
        fail('TG_FORBIDDEN_ARGUMENT', `config sub-command "${key}" is not allowed; use --get/--unset/... instead`);
    }
    const unsetting = has(parsed, '--unset', '--unset-all');
    const isWrite = unsetting || has(parsed, '--add', '--replace-all') || parsed.positionals.length >= 2;
    if (!isWrite || has(parsed, '-l', '--list', '--get', '--get-all', '--get-regexp')) {
        if (isWrite) fail('TG_INVALID_ARGUMENT', 'config: cannot combine reading and writing options');
        return read(analysis);
    }
    if (!key) fail('TG_INVALID_ARGUMENT', 'config: missing key');
    if (!configKeyAllowed(key, WRITABLE_CONFIG)) fail('TG_FORBIDDEN_ARGUMENT', `config key ${key} cannot be written through TavernGit`);
    if (!unsetting && /^remote\..+\.(url|pushurl)$/i.test(key)) {
        if (value === undefined) fail('TG_INVALID_ARGUMENT', 'config: missing value');
        validateUrl(value);
    }
    write(analysis);
}

function classifyPush(analysis, parsed) {
    analysis.classes.add('push');
    analysis.network.push = true;
    const [remote, ...refspecs] = parsed.positionals;
    if (!remote) fail('TG_PUSH_REMOTE_REQUIRED', 'push needs an explicit remote name or URL');
    addRemote(analysis, remote);
    destructiveIf(analysis, parsed, '-f', '--force', '--force-with-lease', '-d', '--delete', '--prune', '--mirror');
    for (const refspec of refspecs) {
        if (refspec.startsWith('+')) markDestructive(analysis, `forced refspec ${refspec}`);
        if (refspec.startsWith(':')) markDestructive(analysis, `deleting refspec ${refspec}`);
        const source = refspec.replace(/^\+/, '').split(':')[0];
        // The source is handed to `rev-list` by the sensitive-path guard.
        if (source.startsWith('-')) fail('TG_INVALID_ARGUMENT', `Invalid refspec: ${refspec}`);
        // Stash commits carry untracked files past the sensitive-path guard.
        if (source === 'stash' || source === 'refs/stash') fail('TG_FORBIDDEN_ARGUMENT', 'Pushing the stash is not allowed');
    }
    analysis.pushRefspecs = refspecs;
    analysis.pushFlags = present(parsed, '--all', '--branches', '--tags', '--mirror');
}

// ---------------------------------------------------------------------------
// Commands with sub-subcommands

const REMOTE_SUBCOMMANDS = {
    'get-url': { spec: spec({ flags: '--push --all', pathspecs: false, minPositionals: 1, maxPositionals: 1 }), classify: read },
    show: {
        spec: spec({ flags: '-n', pathspecs: false, minPositionals: 1 }),
        classify(analysis, parsed) {
            // Without -n, `remote show` contacts every remote.
            if (!has(parsed, '-n')) fail('TG_FORBIDDEN_ARGUMENT', 'remote show is only allowed with -n');
            read(analysis);
        },
    },
    add: {
        spec: spec({ flags: '-f --tags --no-tags', valued: ['-t=ref', '-m=ref'], pathspecs: false, minPositionals: 2, maxPositionals: 2 }),
        classify(analysis, parsed) {
            const [name, url] = parsed.positionals;
            if (!REMOTE_NAME.test(name) || looksLikeUrl(name)) fail('TG_INVALID_ARGUMENT', `Invalid remote name: ${name}`);
            validateUrl(url);
            write(analysis);
            if (has(parsed, '-f')) {
                analysis.classes.add('fetch');
                analysis.network.urls.push(url);
            }
        },
    },
    rename: { spec: spec({ pathspecs: false, minPositionals: 2, maxPositionals: 2 }), classify: write },
    remove: {
        spec: spec({ pathspecs: false, minPositionals: 1, maxPositionals: 1 }),
        classify(analysis) {
            write(analysis);
            markDestructive(analysis, 'remote remove');
        },
    },
    'set-head': {
        spec: spec({ flags: '-a --auto -d --delete', pathspecs: false, minPositionals: 1, maxPositionals: 2 }),
        classify(analysis, parsed) {
            write(analysis);
            if (has(parsed, '-a', '--auto')) {
                analysis.classes.add('fetch');
                addRemote(analysis, parsed.positionals[0]);
            }
        },
    },
    'set-branches': { spec: spec({ flags: '--add', pathspecs: false, minPositionals: 2 }), classify: write },
    'set-url': {
        spec: spec({ flags: '--push --add --delete', pathspecs: false, minPositionals: 2, maxPositionals: 3 }),
        classify(analysis, parsed) {
            // With --delete the second operand is a regex, not a URL.
            if (!has(parsed, '--delete')) validateUrl(parsed.positionals[1]);
            else if (parsed.positionals.length !== 2) fail('TG_INVALID_ARGUMENT', 'remote set-url --delete takes <name> <regex>');
            write(analysis);
        },
    },
    prune: {
        spec: spec({ flags: '-n --dry-run', pathspecs: false, minPositionals: 1 }),
        classify(analysis, parsed) {
            analysis.classes.add('fetch');
            write(analysis);
            for (const name of parsed.positionals) addRemote(analysis, name);
        },
    },
    update: {
        spec: spec({ flags: '-p --prune', pathspecs: false }),
        classify(analysis, parsed) {
            analysis.classes.add('fetch');
            if (!parsed.positionals.length) analysis.network.implicit = 'all';
            for (const name of parsed.positionals) addRemote(analysis, name);
        },
    },
};
REMOTE_SUBCOMMANDS.rm = REMOTE_SUBCOMMANDS.remove;

const REFLOG_SUBCOMMANDS = {
    show: { spec: spec({ flags: '--oneline', valued: ['-n=int', '--format?=fmt', '--date=text'], pathspecs: false, maxPositionals: 1 }), classify: read },
    exists: { spec: spec({ pathspecs: false, minPositionals: 1, maxPositionals: 1 }), classify: read },
};

const STASH_PUSH = {
    spec: spec({ flags: '-u --include-untracked -k --keep-index --staged -q', valued: ['-m|--message=text'], maxPositionals: 0 }),
    classify(analysis, parsed) {
        write(analysis);
        // Untracked files go into the stash commit; vet them first.
        if (has(parsed, '-u', '--include-untracked')) analysis.needsUntrackedPreCheck = true;
    },
};

const STASH_SUBCOMMANDS = {
    push: STASH_PUSH,
    list: { spec: spec({ pathspecs: false, maxPositionals: 0 }), classify: read },
    show: { spec: spec({ flags: '-p --patch --stat --name-only', pathspecs: false, maxPositionals: 1 }), inject: NO_EXTERNAL_DIFF, classify: read },
    apply: { spec: spec({ flags: '--index -q', pathspecs: false, maxPositionals: 1 }), classify: write },
    pop: { spec: spec({ flags: '--index -q', pathspecs: false, maxPositionals: 1 }), classify: write },
    branch: { spec: spec({ pathspecs: false, minPositionals: 1, maxPositionals: 2 }), classify: write },
    drop: {
        spec: spec({ flags: '-q', pathspecs: false, maxPositionals: 1 }),
        classify(analysis) {
            write(analysis);
            markDestructive(analysis, 'stash drop');
        },
    },
    clear: {
        spec: spec({ pathspecs: false, maxPositionals: 0 }),
        classify(analysis) {
            write(analysis);
            markDestructive(analysis, 'stash clear');
        },
    },
};

/**
 * Pick the sub-subcommand entry. `bare` handles the form with no
 * sub-subcommand (`git remote -v`, `git reflog`, `git stash -u`).
 */
function subcommandEntry(subcommand, rest) {
    const first = rest[0];
    const named = first !== undefined && !first.startsWith('-');
    const tables = { remote: REMOTE_SUBCOMMANDS, reflog: REFLOG_SUBCOMMANDS, stash: STASH_SUBCOMMANDS };
    if (named) {
        const entry = Object.hasOwn(tables[subcommand], first) ? tables[subcommand][first] : null;
        if (!entry) fail('TG_FORBIDDEN_COMMAND', `git ${subcommand} ${first} is not allowed`);
        return { entry, label: `${subcommand} ${first}`, prefix: [first], tokens: rest.slice(1) };
    }
    const bare = {
        remote: { spec: spec({ flags: '-v', pathspecs: false, maxPositionals: 0 }), classify: read },
        reflog: REFLOG_SUBCOMMANDS.show,
        stash: STASH_PUSH,
    }[subcommand];
    return { entry: bare, label: subcommand, prefix: [], tokens: rest };
}

// ---------------------------------------------------------------------------

/**
 * Validate and classify a git argv.
 * @param {unknown} args e.g. `['commit', '-m', 'msg']`
 * @returns {ReturnType<typeof newAnalysis>}
 */
export function analyzeCommand(args) {
    if (!Array.isArray(args) || args.length === 0 || args.some((token) => typeof token !== 'string')) {
        fail('TG_BAD_REQUEST', 'args must be a non-empty array of strings');
    }
    const [subcommand, ...rest] = args;
    if (typeof subcommand !== 'string' || !Object.hasOwn(COMMANDS, subcommand)) {
        fail('TG_FORBIDDEN_COMMAND', `git ${String(subcommand)} is not allowed (global options and aliases are never allowed)`);
    }
    const command = COMMANDS[subcommand];
    const { entry, label, prefix, tokens } = command.subcommands
        ? subcommandEntry(subcommand, rest)
        : { entry: command, label: subcommand, prefix: [], tokens: rest };

    const parsed = parse(tokens, entry.spec, label);
    const analysis = newAnalysis(subcommand);
    entry.classify(analysis, parsed);

    let passed = tokens;
    if (subcommand === 'config') passed = tokens.filter((token) => token !== '--local');
    analysis.argv = [subcommand, ...(subcommand === 'config' ? ['--local'] : []), ...prefix, ...(entry.inject ?? []), ...passed, ...(entry.append ?? [])];
    return analysis;
}
