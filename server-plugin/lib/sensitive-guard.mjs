/**
 * Sensitive path guard. Prevents secrets (e.g. `secrets.json`, `config.yaml`,
 * `data/_storage/**`, TavernGit state) from entering the index, commits,
 * stashes, or pushes. All git invocations run inside the caller's sandbox env.
 */
import { fail } from './errors.mjs';
import { runGit } from './runner.mjs';
import { isSensitive } from './tiers.mjs';

function toStRel(repoRel, filePath) {
    return repoRel ? `${repoRel}/${filePath}` : filePath;
}

function filterSensitive(paths, repoRel, tierCtx) {
    const found = [];
    const seen = new Set();
    for (const relPath of paths) {
        if (!relPath || seen.has(relPath)) continue;
        if (isSensitive(toStRel(repoRel, relPath), tierCtx)) {
            seen.add(relPath);
            found.push(relPath);
        }
    }
    return found;
}

/**
 * List any staged (cached) paths in the index that match sensitive-path rules.
 * @param {{ gitPath: string, env: Record<string,string>, cwd: string, repoRel: string, tierCtx: object }} repo
 * @returns {Promise<string[]>}
 */
export async function indexSensitivePaths({ gitPath, env, cwd, repoRel, tierCtx }) {
    const result = await runGit({
        gitPath,
        args: ['ls-files', '-z', '--cached'],
        cwd,
        env,
    });
    if (result.exitCode !== 0) {
        fail('TG_INTERNAL', `Failed to inspect staged files: ${result.stderr.trim()}`);
    }
    return filterSensitive(result.stdout.split('\0'), repoRel, tierCtx);
}

/**
 * List any untracked (non-ignored) paths in the working tree that match
 * sensitive-path rules (used before `stash -u`).
 * @param {{ gitPath: string, env: Record<string,string>, cwd: string, repoRel: string, tierCtx: object }} repo
 * @returns {Promise<string[]>}
 */
export async function untrackedSensitivePaths({ gitPath, env, cwd, repoRel, tierCtx }) {
    const result = await runGit({
        gitPath,
        args: ['ls-files', '-z', '--others', '--exclude-standard'],
        cwd,
        env,
    });
    if (result.exitCode !== 0) {
        fail('TG_INTERNAL', `Failed to inspect untracked files: ${result.stderr.trim()}`);
    }
    return filterSensitive(result.stdout.split('\0'), repoRel, tierCtx);
}

/**
 * List the sensitive files an `add` would start tracking, before git runs.
 * Staging hashes a file into the object store, where its content stays even
 * after the path is unstaged again, so the unstage post-check alone is too late.
 * @param {{ gitPath: string, env: Record<string,string>, cwd: string, repoRel: string, tierCtx: object }} repo
 * @param {{ pathspecs: string[], all: boolean, includeIgnored: boolean }} options from `analysis.addPreCheck`
 * @returns {Promise<string[]>}
 */
export async function addSensitivePaths({ gitPath, env, cwd, repoRel, tierCtx }, { pathspecs, all, includeIgnored }) {
    // Without pathspecs `add` stages nothing unless `-A` is given.
    if (pathspecs.length === 0 && !all) return [];
    const args = ['ls-files', '-z', '--others'];
    // `add -f` also takes ignored files.
    if (!includeIgnored) args.push('--exclude-standard');
    if (pathspecs.length > 0) args.push('--', ...pathspecs);
    const result = await runGit({ gitPath, args, cwd, env });
    if (result.exitCode !== 0) {
        // Fail closed: `add` would reject the same pathspecs.
        fail('TG_INVALID_ARGUMENT', `Cannot determine the files to add: ${result.stderr.trim()}`);
    }
    return filterSensitive(result.stdout.split('\0'), repoRel, tierCtx);
}

/**
 * Check commit objects reachable by a push for sensitive paths before any
 * network connection is opened. For configured remote names, objects already
 * known on `--remotes=<remoteName>` are excluded; for URL remotes, the entire
 * reachable history of the pushed sources is inspected.
 * @param {{ gitPath: string, env: Record<string,string>, cwd: string, repoRel: string, tierCtx: object }} repo
 * @param {{ remoteName?: string|null, refspecs?: string[], flags?: string[] }} options
 * @returns {Promise<string[]>}
 */
export async function pushSensitivePaths({ gitPath, env, cwd, repoRel, tierCtx }, { remoteName = null, refspecs = [], flags = [] }) {
    // Ref-selection options and revisions are kept apart so every caller-chosen
    // revision goes after `--end-of-options` and can never be read as an option.
    const selectors = [];
    const revisions = [];
    if (flags.includes('--mirror')) {
        selectors.push('--all');
    } else {
        if (flags.includes('--all') || flags.includes('--branches')) selectors.push('--branches');
        if (flags.includes('--tags')) selectors.push('--tags');
        for (const refspec of refspecs) {
            const clean = refspec.startsWith('+') ? refspec.slice(1) : refspec;
            const src = clean.split(':')[0];
            if (!src) continue;
            if (src.includes('*')) selectors.push(`--glob=${src}`);
            else revisions.push(src);
        }
        if (selectors.length === 0 && revisions.length === 0) {
            // Refspecs consisting only of deletions (`:branch`) push no objects.
            if (refspecs.length > 0) return [];
            revisions.push('HEAD');
        }
    }

    const args = ['rev-list', '--objects'];
    // `--not` applies to what follows it, so the exclusion is opened and closed
    // before the sources.
    if (remoteName) args.push('--not', `--remotes=${remoteName}`, '--not');
    args.push(...selectors);
    if (revisions.length > 0) args.push('--end-of-options', ...revisions);

    const result = await runGit({ gitPath, args, cwd, env });
    if (result.exitCode !== 0) {
        // Fail closed: a push whose objects we cannot enumerate is not pushed.
        // (git push would fail on the same unresolvable source anyway.)
        fail('TG_INVALID_ARGUMENT', `Cannot determine the objects to push: ${result.stderr.trim()}`);
    }

    const candidatePaths = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line) continue;
        const space = line.indexOf(' ');
        if (space === -1) continue;
        const filePath = line.slice(space + 1);
        if (filePath) candidatePaths.push(filePath);
    }
    return filterSensitive(candidatePaths, repoRel, tierCtx);
}
