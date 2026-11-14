/**
 * HTTP JSON transport to the TavernGit server plugin.
 */
import { API_BASE } from './constants.js';
import { ERROR_CODES, TavernGitError } from './errors.js';
import { getRequestHeaders } from './st-host.js';

/**
 * Send an API request to the TavernGit server plugin.
 * @param {string} method
 * @param {string} path route relative to `API_BASE`, e.g. `'/status'`
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
export async function request(method, path, body) {
    if (typeof globalThis.fetch !== 'function') {
        throw new TavernGitError(ERROR_CODES.TG_INTERNAL, 'fetch is not available in this environment');
    }
    const headers = { ...getRequestHeaders() };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }

    const res = await globalThis.fetch(`${API_BASE}${path}`, init);
    let data = null;
    try {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }

    // A plain 404 (no structured TavernGit error code) means the server plugin
    // is not mounted, not enabled, or running under TauriTavern.
    if (res.status === 404 && !data?.error?.code) {
        throw new TavernGitError(
            ERROR_CODES.TG_SERVER_PLUGIN_MISSING,
            'TavernGit server plugin is not installed or enabled.',
        );
    }

    if (data && data.ok === false) {
        const err = data.error || {};
        throw new TavernGitError(
            err.code || ERROR_CODES.TG_INTERNAL,
            err.message || `Request failed (${res.status})`,
            err.details,
            data.consent,
        );
    }

    if (!res.ok) {
        throw new TavernGitError(
            ERROR_CODES.TG_INTERNAL,
            `HTTP ${res.status} from TavernGit server`,
            { status: res.status },
        );
    }

    return data;
}
