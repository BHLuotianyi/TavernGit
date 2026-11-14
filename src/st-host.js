/**
 * Narrow bridge to SillyTavern browser globals.
 * All global accesses are guarded so importing in Node never throws, and no
 * internal ST module paths are imported across versions (1.11.1+).
 */

/**
 * Return the SillyTavern context object when running inside ST, else null.
 * @returns {object|null}
 */
export function getStContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Return request headers including the ST CSRF token.
 * @returns {Record<string, string>}
 */
export function getRequestHeaders() {
    const ctx = getStContext();
    if (ctx && typeof ctx.getRequestHeaders === 'function') {
        const headers = ctx.getRequestHeaders();
        if (headers && typeof headers === 'object') return headers;
    }
    return {};
}
/**
 * Detect the active UI locale (`'zh-cn'` or `'en'`).
 * @returns {'zh-cn'|'en'}
 */
export function getLocale() {
    const ctx = getStContext();
    let raw = null;
    try {
        const win = globalThis.window;
        raw = ctx?.getCurrentLocale?.()
            ?? win?.localStorage?.getItem?.('language')
            ?? globalThis.navigator?.language
            ?? null;
    } catch {
        raw = null;
    }
    if (typeof raw === 'string' && raw.trim().toLowerCase().startsWith('zh')) {
        return 'zh-cn';
    }
    return 'en';
}

/**
 * Show a toast notification via ST's global `toastr`, falling back to console.
 * @param {'success'|'info'|'warning'|'error'} kind
 * @param {string} message
 */
export function toast(kind, message) {
    const toastr = globalThis.toastr;
    if (toastr && typeof toastr[kind] === 'function') {
        toastr[kind](message, 'TavernGit');
        return;
    }
    const method = kind === 'error' ? 'error' : kind === 'warning' ? 'warn' : 'log';
    console[method](`[TavernGit] ${message}`);
}
