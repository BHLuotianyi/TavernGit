import fs from 'node:fs';
import path from 'node:path';

/**
 * True on platforms whose default filesystems ignore case. Comparisons that
 * guard containment, tiers and sensitive paths must not be fooled by
 * `Config.YAML` naming the same file as `config.yaml`. Over-matching here is
 * always the safe direction.
 * @param {NodeJS.Platform} [platform]
 */
export function isCaseInsensitivePlatform(platform = process.platform) {
    return platform === 'win32' || platform === 'darwin';
}

/**
 * Real path of `target`, tolerating a non-existent tail: the deepest existing
 * ancestor is resolved through symlinks and the missing segments are appended
 * as-is. This is what makes symlinks inside ST that point outside it visible
 * to the containment check, even for paths that do not exist yet.
 * @param {string} target absolute path
 * @returns {{ real: string, exists: boolean }}
 */
export function realpathLoose(target) {
    const tail = [];
    let current = path.resolve(target);
    for (;;) {
        try {
            const real = fs.realpathSync.native(current);
            return { real: tail.length ? path.join(real, ...tail.reverse()) : real, exists: tail.length === 0 };
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
            const parent = path.dirname(current);
            if (parent === current) throw error;
            tail.push(path.basename(current));
            current = parent;
        }
    }
}

/**
 * Lexical containment: `child` equals `parent` or lies below it. Both must
 * already be real (symlink-free) absolute paths.
 * @param {string} child
 * @param {string} parent
 * @param {boolean} caseInsensitive
 */
export function isInside(child, parent, caseInsensitive) {
    const norm = (value) => (caseInsensitive ? value.toLowerCase() : value);
    const rel = path.relative(norm(parent), norm(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * `abs` relative to `root` with `/` separators; `''` for the root itself.
 * Callers must check containment first.
 */
export function toPosixRel(root, abs) {
    return path.relative(root, abs).split(path.sep).join('/');
}
