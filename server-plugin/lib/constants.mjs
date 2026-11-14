/**
 * Server-side constants. The plugin version itself lives in
 * `server-plugin/package.json` and is read at startup (see `index.mjs`).
 */

/** Wire protocol; must equal `PROTOCOL_VERSION` in the UI extension. */
export const PROTOCOL_VERSION = 1;

/** Router id; ST mounts the router at `/api/plugins/<id>`. */
export const PLUGIN_ID = 'taverngit';

/**
 * Oldest supported git. 2.32 is the first release with both
 * `GIT_CONFIG_COUNT` (2.31) and `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`,
 * which the sandbox environment depends on.
 */
export const MIN_GIT_VERSION = '2.32.0';

/** Every error code the server can return. Clients match on these literals. */
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
});
