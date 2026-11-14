/**
 * HTTP helpers for the SillyTavern plugin router: body parsing compatible with
 * both ST <1.12 (no global JSON middleware) and ST >=1.12 (pre-parsed `req.body`),
 * JSON response formatting, error-to-status mapping, and admin access control.
 */
import { TavernGitError, fail } from './errors.mjs';

const DEFAULT_BODY_LIMIT = 40 * 1024 * 1024;

const STATUS_BY_CODE = Object.freeze({
    TG_BAD_REQUEST: 400,
    TG_INVALID_PATH: 400,
    TG_INVALID_ARGUMENT: 400,

    TG_ADMIN_REQUIRED: 403,
    TG_CONSENT_DENIED: 403,
    TG_CONSOLE_CODE_INVALID: 403,
    TG_PATH_OUTSIDE_ROOT: 403,

    TG_NOT_A_REPOSITORY: 404,
    TG_ZONE_UNAVAILABLE: 404,

    TG_CONSENT_REQUIRED: 409,
    TG_DEST_NOT_EMPTY: 409,

    TG_CONSENT_EXPIRED: 410,

    TG_OUTPUT_TOO_LARGE: 413,

    TG_FORBIDDEN_COMMAND: 422,
    TG_FORBIDDEN_OPTION: 422,
    TG_FORBIDDEN_ARGUMENT: 422,
    TG_FORBIDDEN_URL: 422,
    TG_UNSAFE_REPO_LAYOUT: 422,
    TG_UNSAFE_REPO_CONFIG: 422,
    TG_UNSUPPORTED_REPO_LAYOUT: 422,
    TG_SENSITIVE_PATH: 422,
    TG_PUSH_REMOTE_REQUIRED: 422,

    TG_GIT_UNAVAILABLE: 503,
    TG_MINGIT_MISSING: 503,
    TG_GIT_MISSING: 503,
    TG_GIT_TOO_OLD: 503,
    TG_BAD_INSTALL_LOCATION: 503,

    TG_TIMEOUT: 504,
});

function writeJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

/**
 * Parse a JSON request body. Reuses `req.body` when ST's global Express
 * middleware has already parsed it; otherwise reads the raw request stream up
 * to `limit` bytes (for ST 1.11.x compatibility).
 * @param {import('node:http').IncomingMessage & { body?: unknown }} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(req, limit = DEFAULT_BODY_LIMIT) {
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        return req.body;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > limit) {
            fail('TG_BAD_REQUEST', `Request body exceeds ${limit} byte limit`);
        }
        chunks.push(buf);
    }

    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.trim() === '') return {};
    try {
        return JSON.parse(raw);
    } catch {
        fail('TG_BAD_REQUEST', 'Invalid JSON request body');
    }
}

/**
 * Send a success JSON response `{ ok: true, ...payload }`.
 * @param {import('node:http').ServerResponse} res
 * @param {object} [payload]
 * @param {number} [status=200]
 */
export function sendOk(res, payload = {}, status = 200) {
    writeJson(res, status, { ok: true, ...payload });
}

/**
 * Send an error JSON response `{ ok: false, error: { code, message, details? }, consent? }`.
 * Non-TavernGitError exceptions are logged server-side and masked as `TG_INTERNAL`.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err
 */
export function sendError(res, err) {
    if (err instanceof TavernGitError) {
        const status = STATUS_BY_CODE[err.code] ?? 500;
        const body = {
            ok: false,
            error: {
                code: err.code,
                message: err.message,
                ...(err.details !== undefined ? { details: err.details } : {}),
            },
            ...(err.consent !== undefined ? { consent: err.consent } : {}),
        };
        writeJson(res, status, body);
        return;
    }

    console.error('[TavernGit] Internal error:', err?.stack ?? err);
    writeJson(res, 500, {
        ok: false,
        error: {
            code: 'TG_INTERNAL',
            message: 'Internal server error',
        },
    });
}

/**
 * Restrict plugin endpoints to SillyTavern administrators. On ST <1.12 where
 * `req.user` is absent, access is allowed (single-user server).
 * @param {object} req
 * @param {object} res
 * @param {() => void} next
 */
export function adminGuard(req, res, next) {
    if (req.user && req.user.profile?.admin !== true) {
        sendError(res, new TavernGitError('TG_ADMIN_REQUIRED', 'SillyTavern administrator privileges are required'));
        return;
    }
    next();
}
