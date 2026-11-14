/**
 * Synchronous caller-origin detection from the JS call stack.
 *
 * Captured before any `await` so async state machines do not erase the calling
 * extension's stack frame. This is a best-effort UI hint (marked unverified if
 * missing or mismatched), not a security boundary.
 */

const THIRD_PARTY_FRAME = /\/scripts\/extensions\/third-party\/([^/?#]+)\//;

/**
 * Extract the extension folder name from a module URL if it lives under
 * ST's third-party extensions directory.
 * @param {string} metaUrl
 * @returns {string|null}
 */
export function extractExtensionFolder(metaUrl) {
    if (typeof metaUrl !== 'string') return null;
    const match = THIRD_PARTY_FRAME.exec(metaUrl);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

/** TavernGit's own third-party folder name, derived from `import.meta.url`. */
export const OWN_FOLDER = extractExtensionFolder(import.meta.url);

/**
 * Inspect a stack trace and return the first third-party extension folder
 * that is not `ownFolder`, or `null` if none is found.
 * @param {string|null} [ownFolder]
 * @param {string} [stack]
 * @returns {string|null}
 */
export function detectCallerOrigin(ownFolder = OWN_FOLDER, stack = new Error().stack) {
    if (typeof stack !== 'string') return null;
    for (const line of stack.split(/\r?\n/)) {
        const match = THIRD_PARTY_FRAME.exec(line);
        if (!match) continue;
        let folder;
        try {
            folder = decodeURIComponent(match[1]);
        } catch {
            folder = match[1];
        }
        if (ownFolder && folder === ownFolder) continue;
        return folder;
    }
    return null;
}
