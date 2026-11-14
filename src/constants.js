/** Release identity; rewritten by `tools/version.mjs`. */
export const EXTENSION_VERSION = '0.1.0';
export const EXTENSION_VERSION_CODE = 1;

/**
 * Wire protocol between this UI extension and the server plugin. Bumped only
 * on incompatible changes, independently of the release version, so the two
 * halves can be updated separately as long as this number matches.
 */
export const PROTOCOL_VERSION = 1;

/** Mount point of the server plugin router (`/api/plugins/<plugin id>`). */
export const API_BASE = '/api/plugins/taverngit';
