/**
 * Consent manager: handles persistent grants, pending consent requests,
 * out-of-band server-console confirmation codes, and single-use request-bound approvals.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fail } from './errors.mjs';
import { readJson, writeJsonAtomic } from './json-store.mjs';

const GRANTS_FILE = 'grants.json';
const PENDING_TTL_MS = 5 * 60 * 1000;
const APPROVAL_TTL_MS = 120 * 1000;
const MAX_PENDING = 50;
const MAX_CODE_FAILURES = 3;
// Per-request limits alone do not stop guessing: a page script can open new
// requests forever (each with a fresh code) at 3 guesses apiece. A global
// budget caps guesses across all requests; tripping it locks console-code
// approvals for a while and says so on the console.
const GLOBAL_CODE_FAILURES = 10;
const GLOBAL_CODE_WINDOW_MS = 10 * 60 * 1000;
const CODE_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * SHA-256 hex digest of a UTF-8 string.
 * @param {string} value
 * @returns {string}
 */
function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a user-entered 6-digit console code against the expected code.
 * @param {unknown} provided
 * @param {string} expected
 * @returns {boolean}
 */
function consoleCodeMatches(provided, expected) {
    if (typeof provided !== 'string') return false;
    const trimmed = provided.trim();
    const providedBuf = Buffer.from(trimmed, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Check whether two grant entries refer to the same capability scope.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameGrantScope(a, b) {
    if (a.callerKey !== b.callerKey || a.cls !== b.cls) return false;
    if (a.cls === 'push') return a.host === b.host;
    return a.zone === b.zone;
}

/**
 * Create a consent manager for persistent grants and single-use request approvals.
 * @param {{ stateDir: string, log?: (msg: string) => void, now?: () => number }} options
 */
export function createConsentManager({ stateDir, log = console.log, now = Date.now }) {
    const grantsFile = path.join(stateDir, GRANTS_FILE);
    /** @type {Map<string, { summary: object, hash: string, code: string | null, codeFailures: number, expiresAt: number }>} */
    const pending = new Map();
    /** @type {Map<string, { hash: string, expiresAt: number }>} */
    const approvals = new Map();
    /** Timestamps of recent console-code failures, across all requests. */
    let codeFailureTimes = [];
    let codeLockedUntil = 0;

    function loadGrants() {
        const data = readJson(grantsFile, { version: 1, grants: [] });
        if (!data || !Array.isArray(data.grants)) {
            return { version: 1, grants: [] };
        }
        return { version: 1, grants: data.grants };
    }

    function saveGrants(data) {
        writeJsonAtomic(grantsFile, data);
    }

    function purgeExpiredPending(currentTime) {
        for (const [id, entry] of pending) {
            if (currentTime >= entry.expiresAt) pending.delete(id);
        }
    }

    function purgeExpiredApprovals(currentTime) {
        for (const [id, entry] of approvals) {
            if (currentTime >= entry.expiresAt) approvals.delete(id);
        }
    }

    /**
     * Canonical caller identity combining declared id and detected script origin so a caller
     * cannot impersonate another extension's origin to inherit its grants.
     * @param {{ id: string, origin?: string | null }} caller
     * @returns {string}
     */
    function callerKey(caller) {
        return `${caller.id}|${caller.origin ?? 'unknown'}`;
    }

    /**
     * Compute a deterministic SHA-256 hash binding an approval to the exact caller, repo,
     * argv, input payload, and binary mode so approvals cannot be replayed on altered args.
     * `scope` carries what the consent dialog displayed (classes, destructive flag, hosts,
     * tier, zone); those depend on repository state, so an approval stops matching when
     * that state changes between the prompt and the retry.
     * @param {{ callerKey: string, repoReal: string, argv: string[], input?: string | null, binary?: boolean,
     *   scope?: { classes: string[], destructive: boolean, hosts: string[], tier: string, zone: string } }} req
     * @returns {string}
     */
    function requestHash({ callerKey: cKey, repoReal, argv, input, binary, scope }) {
        const inputSha256 = input === undefined || input === null ? null : sha256Hex(String(input));
        const canonical = JSON.stringify({
            argv,
            binary: Boolean(binary),
            callerKey: cKey,
            inputSha256,
            repoReal,
            scope: scope
                ? [scope.classes, Boolean(scope.destructive), scope.hosts, scope.tier, scope.zone]
                : null,
        });
        return sha256Hex(canonical);
    }

    /**
     * Determine which grants can be persisted via "Remember".
     * Destructive actions and server-tier non-read actions are never rememberable.
     * @param {{ classes: Iterable<string>, destructive: boolean, tier: string, zone: string, hosts?: Iterable<string> }} info
     * @returns {Array<{ cls: 'read'|'write'|'fetch', zone: string } | { cls: 'push', host: string }>}
     */
    function rememberableFor({ classes, destructive, tier, zone, hosts = [] }) {
        if (destructive) return [];
        const classList = Array.from(classes);
        if (tier === 'server' && classList.some((cls) => cls !== 'read')) {
            return [];
        }
        const items = [];
        const seenCls = new Set();
        for (const cls of classList) {
            if (seenCls.has(cls)) continue;
            seenCls.add(cls);
            if (cls === 'push') {
                const seenHosts = new Set();
                for (const host of hosts) {
                    if (seenHosts.has(host)) continue;
                    seenHosts.add(host);
                    items.push({ cls: 'push', host });
                }
            } else if (cls === 'read' || cls === 'write' || cls === 'fetch') {
                items.push({ cls, zone });
            }
        }
        return items;
    }

    /**
     * Check whether stored persistent grants cover every class of a request.
     * Destructive actions and server-tier non-read actions are never auto-covered.
     * @param {{ classes: Iterable<string>, destructive: boolean, tier: string, zone: string, hosts?: Iterable<string> }} info
     * @param {string} cKey
     * @returns {boolean}
     */
    function isCovered({ classes, destructive, tier, zone, hosts = [] }, cKey) {
        if (destructive) return false;
        const classList = Array.from(classes);
        if (classList.length === 0) return false;
        if (tier === 'server' && classList.some((cls) => cls !== 'read')) {
            return false;
        }
        const { grants } = loadGrants();
        for (const cls of classList) {
            if (cls === 'push') {
                const hostList = Array.from(hosts);
                if (hostList.length === 0) return false;
                for (const host of hostList) {
                    const matched = grants.some(
                        (grant) => grant.callerKey === cKey && grant.cls === 'push' && grant.host === host,
                    );
                    if (!matched) return false;
                }
            } else {
                const matched = grants.some(
                    (grant) => grant.callerKey === cKey && grant.cls === cls && grant.zone === zone,
                );
                if (!matched) return false;
            }
        }
        return true;
    }

    /**
     * Register a pending consent prompt bound to `hash` and optionally log a 6-digit
     * server-console confirmation code for server-tier non-read actions.
     * @param {object} summary
     * @param {string} hash
     * @returns {string}
     */
    function createPending(summary, hash) {
        const currentTime = now();
        purgeExpiredPending(currentTime);
        while (pending.size >= MAX_PENDING) {
            const oldestKey = pending.keys().next().value;
            pending.delete(oldestKey);
        }

        const requestId = crypto.randomUUID();
        let code = null;
        if (summary.needsConsoleCode) {
            // Print out-of-band to server stdout so same-origin browser JS cannot forge server-tier writes.
            code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
            const callerName = summary.caller?.name ?? 'unknown';
            const argvStr = Array.isArray(summary.argv) ? summary.argv.join(' ') : '';
            const display = summary.repo?.display ?? '';
            log(
                `[TavernGit] Confirmation code for request ${requestId.slice(0, 8)} (${callerName} → git ${argvStr} in ${display}): ${code}`,
            );
        }

        pending.set(requestId, {
            summary,
            hash,
            code,
            codeFailures: 0,
            expiresAt: currentTime + PENDING_TTL_MS,
        });
        return requestId;
    }

    /**
     * Retrieve a non-expired pending consent summary (never includes the console code).
     * @param {string} requestId
     * @returns {object | null}
     */
    function getPending(requestId) {
        const entry = pending.get(requestId);
        if (!entry) return null;
        if (now() >= entry.expiresAt) {
            pending.delete(requestId);
            return null;
        }
        return entry.summary;
    }

    /**
     * Resolve a pending consent prompt as allow or deny, optionally persisting grants
     * and returning a single-use `approvalId` bound to the original request hash.
     * @param {{ requestId: string, decision: 'allow'|'deny', remember?: boolean, consoleCode?: string, callerName?: string }} input
     * @returns {{ approvalId: string }}
     */
    function decide({ requestId, decision, remember = false, consoleCode, callerName }) {
        const currentTime = now();
        const entry = pending.get(requestId);
        if (!entry || currentTime >= entry.expiresAt) {
            pending.delete(requestId);
            fail('TG_CONSENT_EXPIRED', 'Consent request has expired or does not exist');
        }

        if (decision === 'deny') {
            pending.delete(requestId);
            fail('TG_CONSENT_DENIED', 'Request denied by user');
        }

        if (decision !== 'allow') {
            fail('TG_BAD_REQUEST', `Invalid consent decision: ${decision}`);
        }

        if (entry.summary.needsConsoleCode) {
            if (currentTime < codeLockedUntil) {
                pending.delete(requestId);
                fail('TG_CONSOLE_CODE_INVALID', 'Too many wrong confirmation codes; server-tier approvals are locked for a while');
            }
            if (!consoleCodeMatches(consoleCode, entry.code)) {
                entry.codeFailures += 1;
                if (entry.codeFailures >= MAX_CODE_FAILURES) {
                    // Invalidate after 3 failed attempts to limit brute-forcing of the 6-digit code.
                    pending.delete(requestId);
                }
                codeFailureTimes = codeFailureTimes.filter((t) => currentTime - t < GLOBAL_CODE_WINDOW_MS);
                codeFailureTimes.push(currentTime);
                if (codeFailureTimes.length >= GLOBAL_CODE_FAILURES) {
                    codeLockedUntil = currentTime + CODE_LOCKOUT_MS;
                    codeFailureTimes = [];
                    log(`[TavernGit] ${GLOBAL_CODE_FAILURES} wrong confirmation codes within ${GLOBAL_CODE_WINDOW_MS / 60000} min; server-tier approvals locked for ${CODE_LOCKOUT_MS / 60000} min. If you did not enter them, a page script may be guessing.`);
                }
                fail('TG_CONSOLE_CODE_INVALID', 'Invalid console confirmation code');
            }
        }

        pending.delete(requestId);

        const rememberable = Array.isArray(entry.summary.rememberable) ? entry.summary.rememberable : [];
        if (remember && rememberable.length > 0) {
            const cKey = entry.summary.callerKey ?? callerKey(entry.summary.caller);
            const cName = callerName ?? entry.summary.caller?.name ?? 'unknown';
            const data = loadGrants();
            for (const item of rememberable) {
                const candidate = item.cls === 'push'
                    ? { id: crypto.randomUUID(), callerKey: cKey, callerName: cName, cls: 'push', host: item.host }
                    : { id: crypto.randomUUID(), callerKey: cKey, callerName: cName, cls: item.cls, zone: item.zone };
                const existing = data.grants.find((g) => sameGrantScope(g, candidate));
                if (existing) {
                    existing.callerName = cName;
                } else {
                    data.grants.push(candidate);
                }
            }
            saveGrants(data);
        }

        purgeExpiredApprovals(currentTime);
        const approvalId = crypto.randomUUID();
        approvals.set(approvalId, {
            hash: entry.hash,
            expiresAt: currentTime + APPROVAL_TTL_MS,
        });
        return { approvalId };
    }

    /**
     * Consume a single-use approval token, verifying it has not expired and matches `hash`.
     * @param {string} approvalId
     * @param {string} hash
     * @returns {true}
     */
    function consumeApproval(approvalId, hash) {
        const currentTime = now();
        const record = approvals.get(approvalId);
        if (!record) {
            fail('TG_CONSENT_EXPIRED', 'Consent approval is missing or has already been used');
        }
        // Delete immediately so an approval can never be reused or probed across mismatched requests.
        approvals.delete(approvalId);
        if (currentTime >= record.expiresAt || record.hash !== hash) {
            fail('TG_CONSENT_EXPIRED', 'Consent approval has expired or does not match request');
        }
        return true;
    }

    /**
     * List all persisted consent grants.
     * @returns {Array<{ id: string, callerKey: string, callerName: string, cls: string, zone?: string, host?: string }>}
     */
    function listGrants() {
        return loadGrants().grants;
    }

    /**
     * Remove a single persisted grant by id.
     * @param {string} id
     * @returns {boolean}
     */
    function removeGrant(id) {
        const data = loadGrants();
        const next = data.grants.filter((grant) => grant.id !== id);
        if (next.length === data.grants.length) return false;
        data.grants = next;
        saveGrants(data);
        return true;
    }

    /**
     * Remove all persisted grants. Returns the number of grants removed.
     * @returns {number}
     */
    function clearGrants() {
        const data = loadGrants();
        const removed = data.grants.length;
        if (removed > 0) {
            saveGrants({ version: 1, grants: [] });
        }
        return removed;
    }

    return {
        callerKey,
        requestHash,
        rememberableFor,
        isCovered,
        createPending,
        getPending,
        decide,
        consumeApproval,
        listGrants,
        removeGrant,
        clearGrants,
    };
}
