/**
 * Risk tiers and sensitive paths. Both are fixed rules over ST-root-relative
 * posix paths; zone names never influence them, so a request cannot lower its
 * tier by choosing a different zone spelling.
 */

/** Ordered from least to most dangerous. */
export const TIERS = Object.freeze(['data', 'frontend', 'server']);

/**
 * @typedef {{ dataRel: string|null, serverPluginRel: string|null, caseInsensitive: boolean }} TierContext
 */

function splitRel(rel) {
    return rel ? rel.split('/') : [];
}

function segmentEquals(a, b, caseInsensitive) {
    return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Segment glob: `*` matches exactly one segment, a trailing `**` matches any
 * number (including zero) of remaining segments. Node 18 has no
 * `path.matchesGlob`, and only these two forms are needed.
 * @param {string} rel posix path
 * @param {string} pattern posix glob
 * @param {boolean} [caseInsensitive]
 */
export function matchGlob(rel, pattern, caseInsensitive = false) {
    const parts = splitRel(rel);
    const globs = splitRel(pattern);
    for (let i = 0; i < globs.length; i += 1) {
        if (globs[i] === '**') return true;
        if (i >= parts.length) return false;
        if (globs[i] !== '*' && !segmentEquals(parts[i], globs[i], caseInsensitive)) return false;
    }
    return parts.length === globs.length;
}

/** True when `rel` matches `pattern` itself or lies below a match. */
function underGlob(rel, pattern, caseInsensitive) {
    return matchGlob(rel, `${pattern}/**`, caseInsensitive);
}

/**
 * True when some path matching `pattern` lies strictly inside `repoRel`, i.e.
 * `repoRel` matches a proper prefix of the pattern.
 */
function containsGlob(repoRel, pattern, caseInsensitive) {
    const repo = splitRel(repoRel);
    const globs = splitRel(pattern);
    if (repo.length >= globs.length) return false;
    return repo.every((part, i) => globs[i] === '*' || segmentEquals(part, globs[i], caseInsensitive));
}

/** Tier rules more specific first; the first match decides a path's tier. */
function tierRules({ dataRel }) {
    const rules = [];
    if (dataRel) {
        // User-installed extensions are loaded into the page like public/.
        rules.push({ glob: `${dataRel}/*/extensions`, tier: 'frontend' });
        rules.push({ glob: dataRel, tier: 'data' });
    }
    rules.push({ glob: 'public', tier: 'frontend' });
    return rules;
}

/**
 * Tier of a single path. Anything not covered by a rule (src/, plugins/,
 * node_modules/, root files, default/, the root itself) is `server`.
 * @param {string} rel
 * @param {TierContext} ctx
 */
export function pathTier(rel, ctx) {
    for (const rule of tierRules(ctx)) {
        if (underGlob(rel, rule.glob, ctx.caseInsensitive)) return rule.tier;
    }
    return 'server';
}

/**
 * Tier of a repository: the maximum of its root's tier and the tier of every
 * rule prefix inside it. A repo at the user directory contains
 * `extensions/`, so it is `frontend` even though its root is `data`.
 * @param {string} repoRel
 * @param {TierContext} ctx
 */
export function repoTier(repoRel, ctx) {
    let rank = TIERS.indexOf(pathTier(repoRel, ctx));
    for (const rule of tierRules(ctx)) {
        if (containsGlob(repoRel, rule.glob, ctx.caseInsensitive)) rank = Math.max(rank, TIERS.indexOf(rule.tier));
    }
    return TIERS[rank];
}

/** Globs of files that must never be staged, committed, pushed or listed. */
export function sensitiveGlobs({ dataRel, serverPluginRel }) {
    const globs = ['secrets.json', 'config.yaml'];
    if (dataRel) globs.push(`${dataRel}/cookie-secret.txt`, `${dataRel}/*/secrets.json`, `${dataRel}/_storage/**`);
    // TavernGit's own state holds credentials and grants.
    if (serverPluginRel) globs.push(`${serverPluginRel}/state/**`);
    return globs;
}

/**
 * @param {string} rel ST-relative posix path of a file
 * @param {TierContext} ctx
 */
export function isSensitive(rel, ctx) {
    return sensitiveGlobs(ctx).some((glob) => matchGlob(rel, glob, ctx.caseInsensitive));
}
