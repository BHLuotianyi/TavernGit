/**
 * Minimal i18n loader and formatter for TavernGit.
 * Loads JSON bundles relative to `import.meta.url` so ST path variations
 * never break asset lookup.
 */
import { getLocale } from './st-host.js';

let dictionary = {};
let loadedLocale = 'en';

/**
 * Load the translation bundle for `locale`, falling back to `en`.
 * Never throws so startup remains resilient even if a bundle is unreachable.
 * @param {'en'|'zh-cn'} [locale]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadI18n(locale = getLocale()) {
    const normalized = typeof locale === 'string' && locale.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
    const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];
    for (const loc of candidates) {
        try {
            const url = new URL(`../i18n/${loc}.json`, import.meta.url);
            if (typeof globalThis.fetch === 'function' && url.protocol !== 'file:') {
                const res = await globalThis.fetch(url.href);
                if (res.ok) {
                    const data = await res.json();
                    if (data && typeof data === 'object') {
                        dictionary = data;
                        loadedLocale = loc;
                        return dictionary;
                    }
                }
            } else if (url.protocol === 'file:' && typeof process !== 'undefined') {
                // Node test/environment fallback when running without a browser fetch server.
                const fs = await import('node:fs');
                const data = JSON.parse(fs.readFileSync(url, 'utf8'));
                if (data && typeof data === 'object') {
                    dictionary = data;
                    loadedLocale = loc;
                    return dictionary;
                }
            }
        } catch {
            // Fall through to next candidate.
        }
    }
    dictionary = {};
    loadedLocale = 'en';
    return dictionary;
}

/**
 * Translate `key`, substituting `${0}`, `${1}`, ... placeholders.
 * @param {string} key
 * @param {string} [fallback]
 * @param {...unknown} args
 * @returns {string}
 */
export function tr(key, fallback, ...args) {
    const template = Object.prototype.hasOwnProperty.call(dictionary, key)
        ? dictionary[key]
        : (fallback ?? key);
    if (!args.length) return String(template);
    return String(template).replace(/\$\{(\d+)\}/g, (match, index) => {
        const i = Number(index);
        return i < args.length && args[i] !== undefined ? String(args[i]) : match;
    });
}

/**
 * Return the currently loaded locale code.
 * @returns {string}
 */
export function getLoadedLocale() {
    return loadedLocale;
}
