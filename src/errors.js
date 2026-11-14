/**
 * Client-side error codes and error class for TavernGit.
 * Includes every server error code plus client-only codes.
 */

/** Every error code a TavernGit caller may observe. */
export const ERROR_CODES = Object.freeze({
    // Request and access
    TG_BAD_REQUEST: 'TG_BAD_REQUEST',
    TG_ADMIN_REQUIRED: 'TG_ADMIN_REQUIRED',
    TG_BAD_INSTALL_LOCATION: 'TG_BAD_INSTALL_LOCATION',
    // Git availability
    TG_GIT_UNAVAILABLE: 'TG_GIT_UNAVAILABLE',
    TG_MINGIT_MISSING: 'TG_MINGIT_MISSING',
    TG_GIT_MISSING: 'TG_GIT_MISSING',
    TG_GIT_TOO_OLD: 'TG_GIT_TOO_OLD',
    // Paths and repositories
    TG_INVALID_PATH: 'TG_INVALID_PATH',
    TG_PATH_OUTSIDE_ROOT: 'TG_PATH_OUTSIDE_ROOT',
    TG_ZONE_UNAVAILABLE: 'TG_ZONE_UNAVAILABLE',
    TG_NOT_A_REPOSITORY: 'TG_NOT_A_REPOSITORY',
    TG_DEST_NOT_EMPTY: 'TG_DEST_NOT_EMPTY',
    TG_UNSUPPORTED_REPO_LAYOUT: 'TG_UNSUPPORTED_REPO_LAYOUT',
    TG_UNSAFE_REPO_LAYOUT: 'TG_UNSAFE_REPO_LAYOUT',
    TG_UNSAFE_REPO_CONFIG: 'TG_UNSAFE_REPO_CONFIG',
    // Command policy
    TG_FORBIDDEN_COMMAND: 'TG_FORBIDDEN_COMMAND',
    TG_FORBIDDEN_OPTION: 'TG_FORBIDDEN_OPTION',
    TG_FORBIDDEN_ARGUMENT: 'TG_FORBIDDEN_ARGUMENT',
    TG_INVALID_ARGUMENT: 'TG_INVALID_ARGUMENT',
    TG_FORBIDDEN_URL: 'TG_FORBIDDEN_URL',
    TG_PUSH_REMOTE_REQUIRED: 'TG_PUSH_REMOTE_REQUIRED',
    // Sensitive paths
    TG_SENSITIVE_PATH: 'TG_SENSITIVE_PATH',
    TG_SENSITIVE_PATH_TRACKED: 'TG_SENSITIVE_PATH_TRACKED',
    // Consent
    TG_CONSENT_REQUIRED: 'TG_CONSENT_REQUIRED',
    TG_CONSENT_DENIED: 'TG_CONSENT_DENIED',
    TG_CONSENT_EXPIRED: 'TG_CONSENT_EXPIRED',
    TG_CONSOLE_CODE_INVALID: 'TG_CONSOLE_CODE_INVALID',
    // Execution
    TG_TIMEOUT: 'TG_TIMEOUT',
    TG_OUTPUT_TOO_LARGE: 'TG_OUTPUT_TOO_LARGE',
    TG_INTERNAL: 'TG_INTERNAL',
    // Client-only
    TG_SERVER_PLUGIN_MISSING: 'TG_SERVER_PLUGIN_MISSING',
    TG_PROTOCOL_MISMATCH: 'TG_PROTOCOL_MISMATCH',
    TG_GIT_FAILED: 'TG_GIT_FAILED',
});

/** Error thrown by TavernGit API calls and transport. */
export class TavernGitError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {unknown} [details]
     * @param {object} [consent]
     */
    constructor(code, message, details, consent) {
        super(message);
        this.name = 'TavernGitError';
        this.code = code;
        if (details !== undefined) this.details = details;
        if (consent !== undefined) this.consent = consent;
    }
}
