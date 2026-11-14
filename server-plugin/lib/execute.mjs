/**
 * Sandboxed git command execution pipeline. Enforces request validation,
 * allowlist policy, repository layout and config audits, consent gates,
 * per-repo write serialization, sensitive-path guards, output sanitization,
 * and audit logging in strict order.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TavernGitError, fail } from './errors.mjs';
import { buildGitEnv } from './git-env.mjs';
import { isCaseInsensitivePlatform, isInside, realpathLoose, toPosixRel } from './paths.mjs';
import { analyzeCommand, validateUrl } from './policy.mjs';
import { assertOutsideGitDir, auditRepoConfig, configTrue, inspectRepo } from './repo-guard.mjs';
import {
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    NETWORK_TIMEOUT_MS,
    runGit,
    withRepoLock,
} from './runner.mjs';
import { addSensitivePaths, indexSensitivePaths, pushSensitivePaths, untrackedSensitivePaths } from './sensitive-guard.mjs';
import { resolveDataRoot } from './st-root.mjs';
import { repoTier } from './tiers.mjs';
import { createZones, resolveVPath } from './vfs.mjs';

const CALLER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const CALLER_ORIGIN_RE = /^[^/\\]{1,128}$/;
const MAX_ARGS = 512;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Step 1: validate and normalize the `/exec` request payload.
 */
function validateRequest(body) {
    if (!isPlainObject(body)) fail('TG_BAD_REQUEST', 'Request body must be a JSON object');
    const { caller, repo, args, input, binary = false, timeoutMs, approvalId } = body;

    if (!isPlainObject(caller)) fail('TG_BAD_REQUEST', 'caller must be an object');
    if (typeof caller.id !== 'string' || !CALLER_ID_RE.test(caller.id)) {
        fail('TG_BAD_REQUEST', 'caller.id must be 1-64 alphanumeric/._- characters starting with alphanumeric');
    }
    if (typeof caller.name !== 'string' || caller.name.length === 0 || caller.name.length > 80) {
        fail('TG_BAD_REQUEST', 'caller.name must be a non-empty string of at most 80 characters');
    }
    const origin = caller.origin === undefined ? null : caller.origin;
    if (origin !== null && (typeof origin !== 'string' || !CALLER_ORIGIN_RE.test(origin))) {
        fail('TG_BAD_REQUEST', 'caller.origin must be null or a string of 1-128 characters without "/" or "\\"');
    }

    if (typeof repo !== 'string' || repo.length === 0) {
        fail('TG_BAD_REQUEST', 'repo must be a non-empty virtual path');
    }
    if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS || args.some((a) => typeof a !== 'string')) {
        fail('TG_BAD_REQUEST', `args must be a string array of length 1-${MAX_ARGS}`);
    }
    if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES)) {
        fail('TG_BAD_REQUEST', 'input must be a string of at most 32 MiB');
    }
    if (typeof binary !== 'boolean') {
        fail('TG_BAD_REQUEST', 'binary must be a boolean');
    }
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        fail('TG_BAD_REQUEST', 'timeoutMs must be a positive number');
    }
    if (approvalId !== undefined && typeof approvalId !== 'string') {
        fail('TG_BAD_REQUEST', 'approvalId must be a string');
    }

    return {
        caller: { id: caller.id, name: caller.name, origin },
        repo,
        args,
        input,
        binary,
        timeoutMs,
        approvalId,
    };
}

/**
 * Extract all configured values for an exact config key (preserving git's
 * last-wins order).
 */
function configValues(entries, exactKey) {
    const values = [];
    for (const entry of entries) {
        if (entry.key === exactKey && entry.value !== null) {
            values.push(entry.value);
        }
    }
    return values;
}

/**
 * URLs of the promisor remotes of a partial clone. Git fetches missing
 * objects from them on demand, during any command.
 */
function promisorUrls(entries) {
    const names = new Set();
    for (const entry of entries) {
        const promisor = /^remote\.(.+)\.promisor$/.exec(entry.key);
        if (promisor) {
            if (configTrue(entry.value)) names.add(promisor[1]);
            else names.delete(promisor[1]);
        } else if (entry.key === 'extensions.partialclone' && entry.value) {
            names.add(entry.value);
        }
    }
    return [...names].flatMap((name) => configValues(entries, `remote.${name}.url`));
}

/**
 * Read the current branch name from `<gitDir>/HEAD`, or null when detached/unreadable.
 */
function readCurrentBranch(gitDir) {
    try {
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Resolve every remote target in `analysis.network` into lowercased `host[:port]`
 * strings using the already-audited repository config.
 */
function resolveNetworkHosts({ network, auditedConfig, gitDir }) {
    const hosts = [];
    const seen = new Set();
    const pushUrl = (url) => {
        const host = validateUrl(url);
        if (!seen.has(host)) {
            seen.add(host);
            hosts.push(host);
        }
    };

    for (const url of network.urls) {
        pushUrl(url);
    }

    const resolveNamed = (name, isPush) => {
        let urls = isPush ? configValues(auditedConfig, `remote.${name}.pushurl`) : [];
        if (urls.length === 0) urls = configValues(auditedConfig, `remote.${name}.url`);
        if (urls.length === 0) {
            fail('TG_INVALID_ARGUMENT', `Unknown remote: ${name}`);
        }
        for (const url of urls) pushUrl(url);
    };

    for (const name of network.remoteNames) {
        resolveNamed(name, network.push);
    }

    if (network.implicit === 'default') {
        const branch = readCurrentBranch(gitDir);
        const branchRemotes = branch ? configValues(auditedConfig, `branch.${branch}.remote`) : [];
        const defaultRemote = branchRemotes.length > 0 ? branchRemotes[branchRemotes.length - 1] : 'origin';
        resolveNamed(defaultRemote, false);
    } else if (network.implicit === 'all') {
        for (const entry of auditedConfig) {
            if (entry.key.startsWith('remote.') && entry.key.endsWith('.url') && entry.value !== null) {
                pushUrl(entry.value);
            }
        }
    }

    const resolvedRemoteName = network.push && network.remoteNames.length > 0
        ? network.remoteNames[0]
        : null;

    return { hosts, resolvedRemoteName };
}

/**
 * Replace occurrences of the real ST root path with `@ST` so server paths
 * never leak to callers in git output or diagnostics.
 */
function sanitizeOutput(text, stRoot, caseInsensitive) {
    if (!text) return text;
    const posixRoot = stRoot.split(path.sep).join('/');
    const winRoot = stRoot.split(path.sep).join('\\');
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [escape(posixRoot)];
    if (winRoot !== posixRoot) patterns.push(escape(winRoot));
    const re = new RegExp(patterns.join('|'), caseInsensitive ? 'gi' : 'g');
    return text.replace(re, '@ST');
}

/**
 * Create the sandboxed git command executor.
 * @param {object} deps
 * @param {string} deps.stRoot Real path of the SillyTavern root
 * @param {string} deps.stateDir Directory holding TavernGit state
 * @param {string} [deps.serverPluginDir] Real path of the server plugin directory
 * @param {string|null} [deps.serverPluginRel] Override for ST-relative plugin path
 * @param {{ real: string|null, inside: boolean, rel: string|null }|string} [deps.dataRoot] Override for DATA_ROOT
 * @param {() => Promise<object>} deps.getGitInfo
 * @param {object} deps.consent Consent manager
 * @param {object} deps.credentials Credential store
 * @param {object} deps.auditLog Audit log
 * @param {NodeJS.Platform} [deps.platform]
 * @param {NodeJS.ProcessEnv} [deps.processEnv]
 * @param {() => number} [deps.now]
 */
export function createExecutor(deps) {
    const {
        stRoot,
        stateDir,
        serverPluginDir,
        serverPluginRel: serverPluginRelOverride,
        dataRoot: dataRootOverride,
        getGitInfo,
        consent,
        credentials,
        auditLog,
        platform = process.platform,
        processEnv = process.env,
        now = Date.now,
    } = deps;

    const caseInsensitive = isCaseInsensitivePlatform(platform);

    let serverPluginRel = serverPluginRelOverride;
    if (serverPluginRel === undefined) {
        const pluginDirCandidate = serverPluginDir ?? path.dirname(stateDir);
        const { real: realPluginDir } = realpathLoose(pluginDirCandidate);
        serverPluginRel = isInside(realPluginDir, stRoot, caseInsensitive)
            ? toPosixRel(stRoot, realPluginDir)
            : null;
    }

    function getDataRoot() {
        if (dataRootOverride && typeof dataRootOverride === 'object') return dataRootOverride;
        return resolveDataRoot(stRoot, { caseInsensitive, dataRoot: dataRootOverride });
    }

    function requestContext(user) {
        const handle = user?.profile?.handle ?? 'default-user';
        const dataRoot = getDataRoot();
        const zones = createZones({ stRoot, dataRoot, handle });
        const tierCtx = { dataRel: dataRoot.rel, serverPluginRel, caseInsensitive };
        return { handle, dataRoot, zones, tierCtx };
    }

    /**
     * Resolve and describe a virtual path (used by `POST /resolve`).
     * @param {string} vpath
     * @param {{ user?: object }} [options]
     * @returns {{ display: string, alias: string, tier: string, zone: string, exists: boolean }}
     */
    function describePath(vpath, { user } = {}) {
        const { zones, tierCtx } = requestContext(user);
        const resolved = resolveVPath(vpath, zones, { stRoot, caseInsensitive });
        return {
            display: resolved.display,
            alias: resolved.alias,
            tier: repoTier(resolved.rel, tierCtx),
            zone: resolved.zone,
            exists: resolved.exists,
        };
    }

    /**
     * Execute one sandboxed git request through the full 12-step pipeline.
     * @param {object} body
     * @param {{ user?: object }} [options]
     * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, durationMs: number, warnings: Array<{ code: string, paths: string[] }> }>}
     */
    async function execute(body, { user } = {}) {
        let req = null;
        let analysis = null;
        let resolved = null;
        let classes = null;
        let tier = null;
        let consentDecision = null;

        try {
            // 1. Validate request shape.
            req = validateRequest(body);

            // 2. Verify git binary availability.
            const gitInfo = await getGitInfo();
            if (!gitInfo?.available) {
                fail('TG_GIT_UNAVAILABLE', `Git is not available (${gitInfo?.reason ?? 'unknown'})`, {
                    reason: gitInfo?.reason ?? 'TG_GIT_UNAVAILABLE',
                    hint: gitInfo?.hint,
                });
            }

            // 3. Policy allowlist and classification.
            analysis = analyzeCommand(req.args);
            if (analysis.requiresInput && req.input === undefined) {
                fail('TG_INVALID_ARGUMENT', `git ${analysis.subcommand} requires patch input on stdin`);
            }

            // 4. Resolve repository vpath and verify layout/config.
            const { zones, tierCtx } = requestContext(user);
            resolved = resolveVPath(req.repo, zones, { stRoot, caseInsensitive });
            assertOutsideGitDir(resolved.abs, stRoot, caseInsensitive);

            let repoInfo = null;
            let auditedConfig = [];
            const baseEnv = buildGitEnv({ stateDir, stRoot, gitInfo, platform, processEnv });
            let repoEnv = baseEnv;
            let lazyUrls = [];

            if (analysis.mode === 'repo') {
                if (!resolved.exists) {
                    fail('TG_NOT_A_REPOSITORY', `Repository path does not exist: ${resolved.display}`);
                }
                let stat;
                try {
                    stat = fs.statSync(resolved.abs);
                } catch {
                    fail('TG_NOT_A_REPOSITORY', `Repository path does not exist: ${resolved.display}`);
                }
                if (!stat.isDirectory()) {
                    fail('TG_NOT_A_REPOSITORY', `Repository path is not a directory: ${resolved.display}`);
                }
                repoInfo = inspectRepo(resolved.abs, stRoot, caseInsensitive);
                auditedConfig = await auditRepoConfig({
                    gitPath: gitInfo.path,
                    env: baseEnv,
                    gitDir: repoInfo.gitDir,
                    kind: repoInfo.kind,
                });
                repoEnv = {
                    ...baseEnv,
                    GIT_DIR: repoInfo.gitDir,
                    ...(repoInfo.kind === 'worktree' ? { GIT_WORK_TREE: repoInfo.workTree } : {}),
                };
                // A partial clone fetches missing objects on demand, so every
                // command in it is a network command towards its promisor remotes.
                lazyUrls = promisorUrls(auditedConfig);
                if (lazyUrls.length > 0) analysis.classes.add('fetch');
            } else if (analysis.mode === 'init') {
                if (resolved.exists) {
                    if (!fs.statSync(resolved.abs).isDirectory()) {
                        fail('TG_INVALID_PATH', `Init target exists and is not a directory: ${resolved.display}`);
                    }
                    // Re-initializing follows an existing `.git`; a gitfile or
                    // symlink there could lead git out of the root.
                    if (fs.lstatSync(path.join(resolved.abs, '.git'), { throwIfNoEntry: false })) {
                        inspectRepo(resolved.abs, stRoot, caseInsensitive);
                    }
                }
            } else if (analysis.mode === 'clone') {
                if (resolved.exists) {
                    const stat = fs.statSync(resolved.abs);
                    if (!stat.isDirectory() || fs.readdirSync(resolved.abs).length > 0) {
                        fail('TG_DEST_NOT_EMPTY', `Clone destination is not empty: ${resolved.display}`);
                    }
                }
            }

            // Resolve `checkout <x>` ambiguity before computing consent summary.
            if (analysis.checkoutTarget !== null) {
                const check = await runGit({
                    gitPath: gitInfo.path,
                    args: ['rev-parse', '--verify', '-q', '--end-of-options', `${analysis.checkoutTarget}^{commit}`],
                    cwd: resolved.abs,
                    env: repoEnv,
                    platform,
                });
                if (check.exitCode !== 0) {
                    analysis.destructive = true;
                    const reason = `checkout ${analysis.checkoutTarget} (discards changes)`;
                    if (!analysis.destructiveReasons.includes(reason)) {
                        analysis.destructiveReasons.push(reason);
                    }
                }
            }

            const { hosts: targetHosts, resolvedRemoteName } = resolveNetworkHosts({
                network: analysis.network,
                auditedConfig,
                gitDir: repoInfo?.gitDir,
            });
            // Every host the command may contact. Push grants are per host and
            // only ever concern the hosts pushed to, so those stay separate.
            const hosts = [...new Set([...targetHosts, ...lazyUrls.map(validateUrl)])];

            // 5. Compute tier, zone, classes, and console-code requirement.
            tier = repoTier(resolved.rel, tierCtx);
            const zone = resolved.zone;
            classes = [...analysis.classes].sort();
            const needsConsoleCode = tier === 'server' && classes.some((cls) => cls !== 'read');
            const rememberable = consent.rememberableFor({
                classes,
                destructive: analysis.destructive,
                tier,
                zone,
                hosts: targetHosts,
            });

            // 6. Build consent summary.
            const summary = {
                caller: req.caller,
                repo: { display: resolved.display, alias: resolved.alias, tier, zone },
                argv: analysis.argv,
                classes,
                destructive: analysis.destructive,
                destructiveReasons: analysis.destructiveReasons,
                hosts,
                needsConsoleCode,
                rememberable,
            };

            // 7. Consent check (never audited on TG_CONSENT_REQUIRED). The hash
            // covers what the dialog showed, so an approval lapses if the
            // repository changed underneath it (a remote now pointing at
            // another host, a branch name that became a path).
            const cKey = consent.callerKey(req.caller);
            const hash = consent.requestHash({
                callerKey: cKey,
                repoReal: resolved.abs,
                argv: analysis.argv,
                input: analysis.requiresInput ? req.input : undefined,
                binary: req.binary,
                scope: { classes, destructive: analysis.destructive, hosts, tier, zone },
            });

            // An explicit approval is consumed first even when "remember" has just
            // made the request covered: it is single-use and must not linger, and
            // the audit should record the user's click, not the new grant.
            if (req.approvalId) {
                consent.consumeApproval(req.approvalId, hash);
                consentDecision = 'approved';
            } else if (consent.isCovered({ classes, destructive: analysis.destructive, tier, zone, hosts: targetHosts }, cKey)) {
                consentDecision = 'grant';
            } else {
                const requestId = consent.createPending(summary, hash);
                const err = new TavernGitError('TG_CONSENT_REQUIRED', 'User consent is required to execute this git command');
                err.consent = { requestId, ...summary };
                throw err;
            }

            const isNonRead = analysis.destructive || classes.some((cls) => cls !== 'read');
            const runPipeline = async () => {
                // 8. Sensitive pre-checks (worktree repos only).
                const sensCtx = {
                    gitPath: gitInfo.path,
                    env: repoEnv,
                    cwd: resolved.abs,
                    repoRel: resolved.rel,
                    tierCtx,
                };
                if (repoInfo?.kind === 'worktree') {
                    if (analysis.needsSensitivePreCheck) {
                        const sensitive = await indexSensitivePaths(sensCtx);
                        if (sensitive.length > 0) {
                            fail(
                                'TG_SENSITIVE_PATH',
                                `Refusing to ${analysis.subcommand} while sensitive paths are staged: ${sensitive.join(', ')}`,
                                { paths: sensitive },
                            );
                        }
                    }
                    if (analysis.addPreCheck) {
                        const sensitive = await addSensitivePaths(sensCtx, analysis.addPreCheck);
                        if (sensitive.length > 0) {
                            fail(
                                'TG_SENSITIVE_PATH',
                                `Sensitive paths cannot be staged: ${sensitive.join(', ')}`,
                                { paths: sensitive },
                            );
                        }
                    }
                    if (analysis.needsUntrackedPreCheck) {
                        const sensitive = await untrackedSensitivePaths(sensCtx);
                        if (sensitive.length > 0) {
                            fail(
                                'TG_SENSITIVE_PATH',
                                `Refusing to stash untracked files containing sensitive paths: ${sensitive.join(', ')}`,
                                { paths: sensitive },
                            );
                        }
                    }
                    if (analysis.network.push) {
                        const sensitive = await pushSensitivePaths(sensCtx, {
                            remoteName: resolvedRemoteName,
                            refspecs: analysis.pushRefspecs,
                            flags: analysis.pushFlags,
                        });
                        if (sensitive.length > 0) {
                            fail(
                                'TG_SENSITIVE_PATH',
                                `Refusing to push commits containing sensitive paths: ${sensitive.join(', ')}`,
                                { paths: sensitive },
                            );
                        }
                    }
                }

                // 9. Spawn git.
                const isNetwork = analysis.classes.has('fetch') || analysis.classes.has('push');
                const extraConfig = isNetwork && hosts.length > 0 ? credentials.configEntriesFor(hosts) : [];
                const spawnEnv = buildGitEnv({
                    stateDir,
                    stRoot,
                    gitInfo,
                    platform,
                    processEnv,
                    extraConfig,
                    lazyFetch: isNetwork,
                });

                const defaultTimeout = isNetwork ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
                const timeoutMs = req.timeoutMs !== undefined
                    ? Math.min(Math.max(1, Math.trunc(req.timeoutMs)), MAX_TIMEOUT_MS)
                    : defaultTimeout;

                let spawnArgs;
                let spawnCwd;

                if (analysis.mode === 'repo') {
                    spawnEnv.GIT_DIR = repoInfo.gitDir;
                    if (repoInfo.kind === 'worktree') {
                        spawnEnv.GIT_WORK_TREE = repoInfo.workTree;
                    }
                    spawnArgs = analysis.argv;
                    spawnCwd = resolved.abs;
                } else if (analysis.mode === 'init') {
                    fs.mkdirSync(resolved.abs, { recursive: true });
                    // Re-check containment after mkdir to defeat symlink-swap TOCTOU races.
                    const recheck = resolveVPath(req.repo, zones, { stRoot, caseInsensitive });
                    assertOutsideGitDir(recheck.abs, stRoot, caseInsensitive);
                    if (!fs.statSync(recheck.abs).isDirectory()) {
                        fail('TG_INVALID_PATH', `Init target is not a directory: ${recheck.display}`);
                    }
                    spawnArgs = analysis.argv;
                    spawnCwd = recheck.abs;
                } else {
                    const parentAbs = path.dirname(resolved.abs);
                    fs.mkdirSync(parentAbs, { recursive: true });
                    // Re-check containment after mkdir to defeat symlink-swap TOCTOU races.
                    const recheck = resolveVPath(req.repo, zones, { stRoot, caseInsensitive });
                    assertOutsideGitDir(recheck.abs, stRoot, caseInsensitive);
                    if (recheck.exists) {
                        const stat = fs.statSync(recheck.abs);
                        if (!stat.isDirectory() || fs.readdirSync(recheck.abs).length > 0) {
                            fail('TG_DEST_NOT_EMPTY', `Clone destination is not empty: ${recheck.display}`);
                        }
                    }
                    // The destination always comes from `repo`, never from argv.
                    spawnArgs = ['clone', ...analysis.cloneOptions, '--', analysis.cloneUrl, recheck.abs];
                    spawnCwd = path.dirname(recheck.abs);
                }

                const result = await runGit({
                    gitPath: gitInfo.path,
                    args: spawnArgs,
                    cwd: spawnCwd,
                    env: spawnEnv,
                    input: analysis.requiresInput ? req.input : undefined,
                    binary: req.binary,
                    timeoutMs,
                    platform,
                });

                // 10. Sensitive post-checks (worktree repos only).
                const warnings = [];
                if (repoInfo?.kind === 'worktree') {
                    if (analysis.needsSensitivePostCheck === 'unstage') {
                        const sensitive = await indexSensitivePaths(sensCtx);
                        if (sensitive.length > 0) {
                            await runGit({
                                gitPath: gitInfo.path,
                                args: ['reset', '-q', '--', ...sensitive],
                                cwd: resolved.abs,
                                env: repoEnv,
                                platform,
                            });
                            fail(
                                'TG_SENSITIVE_PATH',
                                `Sensitive paths cannot be staged and were unstaged: ${sensitive.join(', ')}`,
                                { paths: sensitive },
                            );
                        }
                    } else if (analysis.needsSensitivePostCheck === 'warn') {
                        const sensitive = await indexSensitivePaths(sensCtx);
                        if (sensitive.length > 0) {
                            warnings.push({ code: 'TG_SENSITIVE_PATH_TRACKED', paths: sensitive });
                        }
                    }
                }

                // 11. Sanitize output.
                const stdout = req.binary ? result.stdout : sanitizeOutput(result.stdout, stRoot, caseInsensitive);
                const stderr = sanitizeOutput(result.stderr, stRoot, caseInsensitive);

                return {
                    exitCode: result.exitCode,
                    stdout,
                    stderr,
                    durationMs: result.durationMs,
                    warnings,
                };
            };

            const output = isNonRead
                ? await withRepoLock(resolved.abs, runPipeline)
                : await runPipeline();

            // 12. Audit and return result.
            await auditLog.append({
                ts: new Date(now()).toISOString(),
                callerId: req.caller.id,
                callerOrigin: req.caller.origin,
                repo: resolved.display,
                argv: analysis.argv,
                classes,
                tier,
                decision: consentDecision,
                exitCode: output.exitCode,
                durationMs: output.durationMs,
            });

            return output;
        } catch (err) {
            if (err instanceof TavernGitError && err.code === 'TG_CONSENT_REQUIRED') {
                throw err;
            }
            await auditLog.append({
                ts: new Date(now()).toISOString(),
                callerId: req?.caller?.id ?? (typeof body?.caller?.id === 'string' ? body.caller.id : null),
                callerOrigin: req?.caller?.origin ?? (typeof body?.caller?.origin === 'string' ? body.caller.origin : null),
                repo: resolved?.display ?? (typeof body?.repo === 'string' ? body.repo : null),
                argv: analysis?.argv ?? (Array.isArray(body?.args) ? body.args : []),
                classes: classes ?? [],
                tier: tier ?? null,
                decision: consentDecision ?? 'rejected',
                errorCode: err instanceof TavernGitError ? err.code : 'TG_INTERNAL',
            });
            throw err;
        }
    }

    return { execute, describePath };
}
