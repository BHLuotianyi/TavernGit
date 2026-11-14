/**
 * Repository layout and configuration guards. Before any git command runs on
 * an existing repository, we verify it uses a standard worktree or bare layout
 * contained within the SillyTavern root and contains only allowlisted config
 * keys (blocking hooks, external diff/filter/textconv programs, includes, etc.).
 * Repository paths inside another repository's git directory are refused for
 * every command, `init` and `clone` included.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';
import { isCaseInsensitivePlatform, isInside, realpathLoose } from './paths.mjs';
import { WRITABLE_CONFIG, configKeyAllowed, validateUrl } from './policy.mjs';
import { runGit } from './runner.mjs';

/**
 * Config keys permitted inside a repository's `.git/config` (and
 * `config.worktree`). Any key not matching one of these patterns causes
 * `TG_UNSAFE_REPO_CONFIG`; the server never edits repo config automatically.
 */
export const AUDIT_ALLOWED = [
    ...WRITABLE_CONFIG,
    /^core\.(repositoryformatversion|bare|logallrefupdates|precomposeunicode|symlinks|quotepath|fscache|protectntfs|protecthfs|sharedrepository|compression|loosecompression|bigfilethreshold|untrackedcache|splitindex|commitgraph|multipackindex|checkstat|trustctime|preloadindex|abbrev|warnambiguousrefs|deltabasecachelimit|packedgitlimit|packedgitwindowsize|sparsecheckout|sparsecheckoutcone|whitespace)$/,
    /^extensions\..+$/,
    /^remote\..+\.(mirror|prunetags|promisor|partialclonefilter|skipdefaultupdate|skipfetchall)$/,
    /^branch\..+\.description$/,
    /^merge\.(renames|renamelimit|log)$/,
    /^fetch\.(writecommitgraph|parallel)$/,
    /^(gc|pack|index|i18n|color|status|advice|feature|gui)\..+$/,
    /^diff\.(context|interhunkcontext|mnemonicprefix|noprefix|relative|statgraphwidth|indentheuristic|colormoved|renamelimit|suppressblankempty)$/,
    /^rerere\.autoupdate$/,
    /^rebase\.(autosquash|autostash|stat|updaterefs|missingcommitscheck|abbreviatecommands)$/,
    /^checkout\.(defaultremote|workers|thresholdforparallelism)$/,
    /^maintenance\.(auto|strategy)$/,
    /^receive\.(denycurrentbranch|denydeletecurrent|denynonfastforwards|denydeletes)$/,
    /^lfs\.repositoryformatversion$/,
    /^log\.(date|decorate|abbrevcommit|follow|showroot)$/,
];

/**
 * Keys inside the wildcard sections of `AUDIT_ALLOWED` whose value is a shell
 * command (`gc.recentObjectsHook`). They are rejected even though the section
 * as a whole is allowed.
 */
const AUDIT_DENIED = [/^(gc|pack)\..*hook$/];

/** Git's own limit on how deep alternates of alternates are followed. */
const MAX_ALTERNATE_DEPTH = 5;

/** True for a git config boolean that is on (a key without a value counts as true). */
export function configTrue(value) {
    return value === null || /^(true|yes|on|1)$/i.test(value.trim());
}

/** True when `dir` has the shape of a git directory (bare repository or `.git`). */
function looksLikeGitDir(dir) {
    const has = (name, kind) => {
        try {
            return fs.statSync(path.join(dir, name))[kind]();
        } catch {
            return false;
        }
    };
    return has('HEAD', 'isFile') && has('objects', 'isDirectory') && has('refs', 'isDirectory');
}

/**
 * Refuse a repository path that is a `.git` directory or lies inside any git
 * directory. Addressed as a repository, such a path would make another
 * repository's internals (config, hooks, sequencer state) the work tree, so
 * ordinary write commands could plant files git later executes.
 * @param {string} repoAbs Real path of the requested repository directory
 * @param {string} stRootReal Real path of the SillyTavern root
 * @param {boolean} caseInsensitive
 */
export function assertOutsideGitDir(repoAbs, stRootReal, caseInsensitive) {
    for (let dir = repoAbs; isInside(dir, stRootReal, caseInsensitive); dir = path.dirname(dir)) {
        // `.git` is matched without regard to case everywhere: over-matching is the safe direction.
        if (path.basename(dir).toLowerCase() === '.git' || (dir !== repoAbs && looksLikeGitDir(dir))) {
            fail('TG_UNSAFE_REPO_LAYOUT', 'Repository path lies inside a git directory');
        }
        if (path.dirname(dir) === dir) break;
    }
}

/**
 * Check `alternates` so an object store cannot reference objects outside
 * the SillyTavern root (e.g. via relative `..` or absolute paths). Git also
 * follows the alternates of an alternate, so those are checked the same way.
 */
function checkAlternates(objectsDir, stRootReal, caseInsensitive, depth = 0) {
    if (depth > MAX_ALTERNATE_DEPTH) return;
    const alternatesPath = path.join(objectsDir, 'info', 'alternates');
    let stat;
    try {
        stat = fs.lstatSync(alternatesPath);
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
        throw error;
    }
    if (!stat.isFile()) {
        fail('TG_UNSAFE_REPO_LAYOUT', 'Repository alternates entry is not a regular file');
    }
    const { real: realAlt } = realpathLoose(alternatesPath);
    if (!isInside(realAlt, stRootReal, caseInsensitive)) {
        fail('TG_UNSAFE_REPO_LAYOUT', 'Repository alternates file resolves outside SillyTavern root');
    }
    const raw = fs.readFileSync(alternatesPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const resolved = path.resolve(objectsDir, trimmed);
        const { real } = realpathLoose(resolved);
        if (!isInside(real, stRootReal, caseInsensitive)) {
            fail('TG_UNSAFE_REPO_LAYOUT', `Repository alternate object store lies outside SillyTavern root: ${trimmed}`);
        }
        checkAlternates(real, stRootReal, caseInsensitive, depth + 1);
    }
}

/**
 * Entries of the git directory may themselves be symlinks (`objects`, `refs`,
 * `index`, ...); none may lead out of the SillyTavern root. A dangling link is
 * refused too, because git would create its target wherever it points.
 */
function checkGitDirSymlinks(gitDir, stRootReal, caseInsensitive) {
    for (const entry of fs.readdirSync(gitDir, { withFileTypes: true })) {
        if (!entry.isSymbolicLink()) continue;
        let real = null;
        try {
            real = fs.realpathSync.native(path.join(gitDir, entry.name));
        } catch {
            // Dangling or unreadable: handled as unsafe below.
        }
        if (real === null || !isInside(real, stRootReal, caseInsensitive)) {
            fail('TG_UNSAFE_REPO_LAYOUT', `Repository git directory entry "${entry.name}" is a symlink that leaves the SillyTavern root or is broken`);
        }
    }
}

/**
 * Inspect a repository directory and verify its layout is safe and supported.
 * @param {string} repoAbs Real path of the repository directory
 * @param {string} stRootReal Real path of the SillyTavern root
 * @param {boolean} [caseInsensitive]
 * @returns {{ kind: 'worktree'|'bare', gitDir: string, workTree?: string }}
 */
export function inspectRepo(repoAbs, stRootReal, caseInsensitive = isCaseInsensitivePlatform()) {
    const dotGit = path.join(repoAbs, '.git');
    let dotGitStat = null;
    try {
        dotGitStat = fs.lstatSync(dotGit);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    let kind;
    let gitDir;
    let workTree;

    if (dotGitStat) {
        // Gitfiles (worktrees/submodules) and symlinked `.git` dirs can point out of root.
        if (!dotGitStat.isDirectory()) {
            fail('TG_UNSUPPORTED_REPO_LAYOUT', 'Unsupported .git layout (gitfiles and symlinks are not allowed)');
        }
        kind = 'worktree';
        gitDir = dotGit;
        workTree = repoAbs;
    } else {
        let headStat;
        let objectsStat;
        let configStat;
        try {
            headStat = fs.lstatSync(path.join(repoAbs, 'HEAD'));
            objectsStat = fs.lstatSync(path.join(repoAbs, 'objects'));
            configStat = fs.lstatSync(path.join(repoAbs, 'config'));
        } catch {
            fail('TG_NOT_A_REPOSITORY', 'Path is not a git repository');
        }
        if (!headStat.isFile() || !objectsStat.isDirectory() || !configStat.isFile()) {
            fail('TG_NOT_A_REPOSITORY', 'Path is not a git repository');
        }
        kind = 'bare';
        gitDir = repoAbs;
    }

    const { real: realGitDir } = realpathLoose(gitDir);
    if (!isInside(realGitDir, stRootReal, caseInsensitive)) {
        fail('TG_UNSAFE_REPO_LAYOUT', 'Repository git directory resolves outside SillyTavern root');
    }

    if (fs.existsSync(path.join(realGitDir, 'commondir'))) {
        fail('TG_UNSUPPORTED_REPO_LAYOUT', 'Linked worktree repositories (commondir) are not supported');
    }

    checkGitDirSymlinks(realGitDir, stRootReal, caseInsensitive);
    checkAlternates(path.join(realGitDir, 'objects'), stRootReal, caseInsensitive);

    return kind === 'worktree'
        ? { kind, gitDir: realGitDir, workTree }
        : { kind, gitDir: realGitDir };
}

/**
 * Parse `--list --null` output from `git config --file` into `{ key, value }` pairs.
 */
async function readConfigFile({ gitPath, env, filePath }) {
    if (!fs.existsSync(filePath)) return [];
    // `--file` does not follow includes, and `--no-includes` enforces it explicitly.
    const result = await runGit({
        gitPath,
        args: ['config', '--file', filePath, '--no-includes', '--list', '--null'],
        cwd: path.dirname(filePath),
        env,
    });
    if (result.exitCode !== 0) {
        fail('TG_UNSAFE_REPO_CONFIG', `Failed to parse repository config (${path.basename(filePath)}): ${result.stderr.trim()}`);
    }
    const entries = [];
    for (const record of result.stdout.split('\0')) {
        if (!record) continue;
        const nl = record.indexOf('\n');
        const key = nl === -1 ? record : record.slice(0, nl);
        const value = nl === -1 ? null : record.slice(nl + 1);
        entries.push({ key, value });
    }
    return entries;
}

/**
 * Audit `.git/config` (and `config.worktree` when `extensions.worktreeconfig` is enabled).
 * Returns the audited entries so callers can resolve remotes without re-reading config.
 * @param {{ gitPath: string, env: Record<string,string>, gitDir: string, kind?: 'worktree'|'bare' }} options
 * @returns {Promise<Array<{ key: string, value: string|null }>>}
 */
export async function auditRepoConfig({ gitPath, env, gitDir, kind }) {
    const entries = await readConfigFile({
        gitPath,
        env,
        filePath: path.join(gitDir, 'config'),
    });

    const worktreeConfigEnabled = entries.some(
        (entry) => entry.key.toLowerCase() === 'extensions.worktreeconfig' && configTrue(entry.value),
    );
    if (worktreeConfigEnabled) {
        const worktreeEntries = await readConfigFile({
            gitPath,
            env,
            filePath: path.join(gitDir, 'config.worktree'),
        });
        entries.push(...worktreeEntries);
    }

    const offenders = [];
    for (const entry of entries) {
        if (!configKeyAllowed(entry.key, AUDIT_ALLOWED) || configKeyAllowed(entry.key, AUDIT_DENIED)) {
            if (!offenders.includes(entry.key)) offenders.push(entry.key);
            continue;
        }
        if (/^remote\..+\.(url|pushurl)$/i.test(entry.key)) {
            if (entry.value === null) {
                if (!offenders.includes(entry.key)) offenders.push(entry.key);
                continue;
            }
            try {
                validateUrl(entry.value);
            } catch {
                if (!offenders.includes(entry.key)) offenders.push(entry.key);
            }
        }
    }

    if (offenders.length > 0) {
        fail(
            'TG_UNSAFE_REPO_CONFIG',
            `Repository config contains disallowed keys (${offenders.join(', ')}). Remove these settings manually from the repository config to use it with TavernGit.`,
            { keys: offenders },
        );
    }

    if (kind === 'bare') {
        // Git runs with GIT_DIR set and no work tree here. Unless the repository
        // says it is bare, git takes the directory itself as the work tree and
        // write commands would edit the repository's own internals.
        const bare = entries.filter((entry) => entry.key.toLowerCase() === 'core.bare').pop();
        if (!bare || !configTrue(bare.value)) {
            fail('TG_UNSUPPORTED_REPO_LAYOUT', 'A repository without a .git directory must set core.bare = true');
        }
    }

    return entries;
}
