/**
 * Server-side HTTPS credential store. Tokens are stored in `<stateDir>/credentials.json`
 * with mode 0600, never returned to the browser, and injected into git only via
 * per-command `GIT_CONFIG_COUNT` headers.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fail } from './errors.mjs';
import { readJson, writeJsonAtomic } from './json-store.mjs';

const CREDENTIALS_FILE = 'credentials.json';
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/;
// Control characters (including CR/LF) could inject HTTP headers when serialized into extraHeader.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/**
 * Strip the secret token before returning credential metadata to callers or UI.
 * @param {{ id: string, host: string, username: string, createdAt: string }} entry
 */
function toPublicEntry(entry) {
    return {
        id: entry.id,
        host: entry.host,
        username: entry.username,
        createdAt: entry.createdAt,
    };
}

/**
 * Validate and normalize a credential entry's fields.
 * @param {{ host: unknown, username: unknown, token: unknown }} input
 * @returns {{ host: string, username: string, token: string }}
 */
function validateCredentialInput({ host, username, token }) {
    if (typeof host !== 'string') {
        fail('TG_INVALID_ARGUMENT', 'Credential host must be a string');
    }
    const lowerHost = host.toLowerCase();
    if (!HOST_RE.test(lowerHost)) {
        fail('TG_INVALID_ARGUMENT', `Invalid credential host: ${host}`);
    }
    // Same form as `validateUrl` reports for a remote: canonical port number,
    // and no port at all for the https default. Anything else would never match.
    const [hostName, portText] = lowerHost.split(':');
    const port = portText === undefined ? 443 : Number(portText);
    if (port > 65535) {
        fail('TG_INVALID_ARGUMENT', `Invalid credential host: ${host}`);
    }
    const normalizedHost = port === 443 ? hostName : `${hostName}:${port}`;
    // Reject `:` in username because HTTP Basic auth separates `username:token` with a colon.
    if (typeof username !== 'string' || username.includes(':') || CONTROL_CHAR_RE.test(username)) {
        fail('TG_INVALID_ARGUMENT', 'Credential username must not contain ":" or control characters');
    }
    if (typeof token !== 'string' || token.length === 0 || CONTROL_CHAR_RE.test(token)) {
        fail('TG_INVALID_ARGUMENT', 'Credential token must be a non-empty string without control characters');
    }
    return { host: normalizedHost, username, token };
}

/**
 * Create a credential store backed by `<stateDir>/credentials.json`.
 * @param {string} stateDir
 */
export function createCredentialStore(stateDir) {
    const file = path.join(stateDir, CREDENTIALS_FILE);

    function load() {
        const data = readJson(file, { version: 1, entries: [] });
        if (!data || !Array.isArray(data.entries)) {
            return { version: 1, entries: [] };
        }
        return { version: 1, entries: data.entries };
    }

    function save(data) {
        writeJsonAtomic(file, data, { mode: 0o600 });
    }

    return {
        /**
         * List stored credentials without exposing tokens.
         * @returns {Array<{ id: string, host: string, username: string, createdAt: string }>}
         */
        list() {
            return load().entries.map(toPublicEntry);
        },

        /**
         * Validate and store a new credential entry. Returns the public metadata (no token).
         * @param {{ host: string, username: string, token: string }} input
         * @returns {{ id: string, host: string, username: string, createdAt: string }}
         */
        add(input) {
            const { host, username, token } = validateCredentialInput(input ?? {});
            const data = load();
            const entry = {
                id: crypto.randomUUID(),
                host,
                username,
                token,
                createdAt: new Date().toISOString(),
            };
            data.entries.push(entry);
            save(data);
            return toPublicEntry(entry);
        },

        /**
         * Remove a credential by id. Returns true if an entry was removed.
         * @param {string} id
         * @returns {boolean}
         */
        remove(id) {
            const data = load();
            const next = data.entries.filter((entry) => entry.id !== id);
            if (next.length === data.entries.length) return false;
            data.entries = next;
            save(data);
            return true;
        },

        /**
         * Build `GIT_CONFIG_COUNT` key/value pairs injecting Basic auth headers
         * only for the requested `hosts` that have stored credentials.
         * @param {string[]} hosts
         * @returns {Array<[string, string]>}
         */
        configEntriesFor(hosts) {
            if (!Array.isArray(hosts) || hosts.length === 0) return [];
            const { entries } = load();
            // Keep the latest credential per host so duplicate entries never emit competing Authorization headers.
            const byHost = new Map();
            for (const entry of entries) {
                byHost.set(entry.host.toLowerCase(), entry);
            }
            const configs = [];
            const seen = new Set();
            for (const rawHost of hosts) {
                if (typeof rawHost !== 'string') continue;
                const host = rawHost.toLowerCase();
                if (seen.has(host)) continue;
                seen.add(host);
                const entry = byHost.get(host);
                if (!entry) continue;
                const encoded = Buffer.from(`${entry.username}:${entry.token}`, 'utf8').toString('base64');
                configs.push([`http.https://${host}/.extraHeader`, `Authorization: Basic ${encoded}`]);
            }
            return configs;
        },
    };
}
