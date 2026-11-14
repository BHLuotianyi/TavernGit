/**
 * TavernGit SillyTavern server plugin entry point.
 * Exposes both named exports (`info`, `init`, `exit`) for ST 1.11.1-1.11.7 and
 * a default export for ST >= 1.11.8.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditLog } from './lib/audit-log.mjs';
import { createConsentManager } from './lib/consent.mjs';
import { PLUGIN_ID, PROTOCOL_VERSION } from './lib/constants.mjs';
import { createCredentialStore } from './lib/credentials.mjs';
import { TavernGitError, fail } from './lib/errors.mjs';
import { createExecutor } from './lib/execute.mjs';
import { detectGit } from './lib/git-binary.mjs';
import { prepareStateDirs } from './lib/git-env.mjs';
import { adminGuard, readJsonBody, sendError, sendOk } from './lib/http.mjs';
import { createIdentityStore } from './lib/identity.mjs';
import { isCaseInsensitivePlatform } from './lib/paths.mjs';
import { killAll } from './lib/runner.mjs';
import { locateStRoot, resolveDataRoot } from './lib/st-root.mjs';
import { createZones, toVPath } from './lib/vfs.mjs';

const serverPluginDir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(serverPluginDir, 'package.json'), 'utf8'));

/** Plugin metadata required by SillyTavern's plugin loader. */
export const info = {
    id: PLUGIN_ID,
    name: 'TavernGit',
    description: 'Sandboxed git endpoints for SillyTavern extensions.',
};

function asyncRoute(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((err) => sendError(res, err));
    };
}

function queryParam(req, name) {
    if (req.query && req.query[name] !== undefined) return String(req.query[name]);
    if (typeof req.url === 'string') {
        try {
            return new URL(req.url, 'http://localhost').searchParams.get(name);
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Initialize TavernGit routes on the Express router mounted at `/api/plugins/taverngit`.
 * @param {import('express').Router} router
 */
export async function init(router) {
    const stRoot = locateStRoot(serverPluginDir);
    if (!stRoot) {
        router.get('/status', (req, res) => {
            sendError(
                res,
                new TavernGitError(
                    'TG_BAD_INSTALL_LOCATION',
                    'TavernGit could not locate the SillyTavern root directory from its plugin folder',
                ),
            );
        });
        console.log(`[TavernGit] v${pkg.version} unavailable: TG_BAD_INSTALL_LOCATION`);
        return;
    }

    const caseInsensitive = isCaseInsensitivePlatform();
    const stateDir = path.join(serverPluginDir, 'state');
    prepareStateDirs(stateDir);

    const credentials = createCredentialStore(stateDir);
    const identity = createIdentityStore(stateDir);
    identity.ensureDefault();
    const auditLog = createAuditLog(stateDir);
    const consent = createConsentManager({ stateDir });

    let cachedGitInfo = null;
    let pendingDetect = null;
    function getGitInfo(refresh = false) {
        if (refresh) {
            cachedGitInfo = null;
            pendingDetect = null;
        }
        if (cachedGitInfo) return Promise.resolve(cachedGitInfo);
        if (!pendingDetect) {
            // A refresh can start a newer detection while this one is still
            // running; only the latest one may publish its result.
            const detect = detectGit({
                serverPluginDir,
                toVPath: (abs) => toVPath(abs, { stRoot, caseInsensitive }),
            }).then(
                (result) => {
                    if (pendingDetect === detect) {
                        cachedGitInfo = result;
                        pendingDetect = null;
                    }
                    return result;
                },
                (err) => {
                    if (pendingDetect === detect) pendingDetect = null;
                    throw err;
                },
            );
            pendingDetect = detect;
        }
        return pendingDetect;
    }

    const executor = createExecutor({
        stRoot,
        stateDir,
        serverPluginDir,
        getGitInfo: () => getGitInfo(false),
        consent,
        credentials,
        auditLog,
    });

    router.use(adminGuard);

    router.get('/status', asyncRoute(async (req, res) => {
        const refreshParam = queryParam(req, 'refresh');
        const refresh = refreshParam === '1' || refreshParam === 'true';
        const git = await getGitInfo(refresh);
        const dataRoot = resolveDataRoot(stRoot, { caseInsensitive });
        const handle = req.user?.profile?.handle ?? 'default-user';
        const zones = createZones({ stRoot, dataRoot, handle }).map((zone) => ({
            name: zone.name,
            available: zone.available,
            display: zone.available ? toVPath(zone.root, { stRoot, caseInsensitive }) : null,
        }));

        sendOk(res, {
            plugin: {
                version: pkg.version,
                versionCode: pkg.versionCode,
                protocol: PROTOCOL_VERSION,
            },
            git: {
                available: git.available,
                source: git.source,
                version: git.version,
                minVersion: git.minVersion,
                ...(git.reason !== undefined ? { reason: git.reason } : {}),
                ...(git.hint !== undefined ? { hint: git.hint } : {}),
            },
            platform: process.platform,
            dataRootInside: dataRoot.inside,
            // False on ST 1.11, which has no data root (user data lives in public/).
            dataRootFound: dataRoot.real !== null,
            zones,
            user: {
                handle,
                admin: req.user ? req.user.profile?.admin === true : true,
            },
        });
    }));

    router.post('/exec', asyncRoute(async (req, res) => {
        const body = await readJsonBody(req);
        const result = await executor.execute(body, { user: req.user });
        sendOk(res, result);
    }));

    router.post('/consent', asyncRoute(async (req, res) => {
        const body = await readJsonBody(req);
        const { requestId, decision, remember = false, consoleCode } = body ?? {};
        if (
            typeof requestId !== 'string'
            || (decision !== 'allow' && decision !== 'deny')
            || typeof remember !== 'boolean'
        ) {
            fail('TG_BAD_REQUEST', 'Invalid consent payload');
        }
        const pending = consent.getPending(requestId);
        // Audit `denied` before calling `decide()`, which deletes the pending entry and throws.
        if (decision === 'deny' && pending) {
            await auditLog.append({
                ts: new Date().toISOString(),
                callerId: pending.caller?.id ?? null,
                callerOrigin: pending.caller?.origin ?? null,
                repo: pending.repo?.display ?? null,
                argv: pending.argv ?? [],
                classes: pending.classes ?? [],
                tier: pending.repo?.tier ?? null,
                decision: 'denied',
                errorCode: 'TG_CONSENT_DENIED',
            });
        }
        const result = consent.decide({
            requestId,
            decision,
            remember,
            consoleCode,
            callerName: pending?.caller?.name,
        });
        sendOk(res, result);
    }));

    router.post('/resolve', asyncRoute(async (req, res) => {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || typeof body.path !== 'string') {
            fail('TG_BAD_REQUEST', 'path must be a string');
        }
        const result = executor.describePath(body.path, { user: req.user });
        sendOk(res, result);
    }));

    router.get('/grants', asyncRoute(async (_req, res) => {
        sendOk(res, { grants: consent.listGrants() });
    }));

    router.delete('/grants/:id', asyncRoute(async (req, res) => {
        sendOk(res, { removed: consent.removeGrant(req.params?.id) });
    }));

    router.delete('/grants', asyncRoute(async (_req, res) => {
        sendOk(res, { removed: consent.clearGrants() });
    }));

    router.get('/credentials', asyncRoute(async (_req, res) => {
        sendOk(res, { credentials: credentials.list() });
    }));

    router.post('/credentials', asyncRoute(async (req, res) => {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') {
            fail('TG_BAD_REQUEST', 'Request body must be a JSON object');
        }
        const credential = credentials.add(body);
        sendOk(res, { credential });
    }));

    router.delete('/credentials/:id', asyncRoute(async (req, res) => {
        sendOk(res, { removed: credentials.remove(req.params?.id) });
    }));

    router.get('/identity', asyncRoute(async (_req, res) => {
        sendOk(res, { identity: identity.get() });
    }));

    router.post('/identity', asyncRoute(async (req, res) => {
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object') {
            fail('TG_BAD_REQUEST', 'Request body must be a JSON object');
        }
        const updated = identity.set(body);
        sendOk(res, { identity: updated });
    }));

    router.get('/audit', asyncRoute(async (req, res) => {
        const raw = queryParam(req, 'limit');
        const limit = raw === null || raw === '' ? 500 : Number(raw);
        if (!Number.isFinite(limit) || limit < 0) {
            fail('TG_BAD_REQUEST', 'limit must be a non-negative number');
        }
        sendOk(res, { entries: auditLog.tail(limit) });
    }));

    const initialGit = await getGitInfo(false);
    console.log(
        `[TavernGit] v${pkg.version} ready; git ${initialGit.available ? initialGit.version : `unavailable: ${initialGit.reason}`}`,
    );
}

/**
 * Stop any running git child processes on plugin shutdown.
 */
export function exit() {
    killAll();
}

export default { info, init, exit };
