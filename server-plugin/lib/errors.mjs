import { ERROR_CODES } from './constants.mjs';

/**
 * The only error type that crosses the HTTP boundary with its own code.
 * Anything else is reported as `TG_INTERNAL` without its message.
 */
export class TavernGitError extends Error {
    /**
     * @param {keyof typeof ERROR_CODES} code
     * @param {string} message
     * @param {object} [details] JSON-safe extra data for the client.
     */
    constructor(code, message, details) {
        super(message);
        if (!ERROR_CODES[code]) throw new TypeError(`unknown TavernGit error code: ${code}`);
        this.name = 'TavernGitError';
        this.code = code;
        if (details !== undefined) this.details = details;
    }
}

/**
 * Shorthand for `throw new TavernGitError(...)` in expression position.
 * @returns {never}
 */
export function fail(code, message, details) {
    throw new TavernGitError(code, message, details);
}
