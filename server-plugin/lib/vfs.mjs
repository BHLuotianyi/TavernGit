/**
 * Virtual paths. Every path in the API is `@<zone>/<relative posix path>`;
 * a zone only names a directory and carries no rights by itself. Resolution
 * always ends in a realpath containment check against the ST root.
 */
import path from 'node:path';
import { fail } from './errors.mjs';
import { isInside, realpathLoose, toPosixRel } from './paths.mjs';

/** Zone names in display order. */
export const ZONE_NAMES = Object.freeze(['ST', 'STdata', 'STuser', 'SText', 'STplugins']);

const VPATH = /^@(ST|STdata|STuser|SText|STplugins)(\/.*)?$/;
// ST user handles are slugs; anything else is not a directory name we trust.
const HANDLE = /^[a-z0-9_-]+$/i;
const MAX_VPATH = 4096;

/**
 * @typedef {{ name: string, root: string|null, available: boolean }} Zone
 * @typedef {{ stRoot: string, caseInsensitive: boolean }} VfsContext
 */

/**
 * Build the zone table for one request.
 * @param {{ stRoot: string, dataRoot: { real: string|null, inside: boolean }, handle: string }} options
 * @returns {Zone[]}
 */
export function createZones({ stRoot, dataRoot, handle }) {
    const dataOk = dataRoot.inside && Boolean(dataRoot.real);
    const userOk = dataOk && HANDLE.test(handle);
    const zone = (name, root, available = true) => ({ name, root: available ? realpathLoose(root).real : null, available });
    return [
        zone('ST', stRoot),
        zone('STdata', dataRoot.real, dataOk),
        zone('STuser', userOk ? path.join(dataRoot.real, handle) : null, userOk),
        zone('SText', path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party')),
        zone('STplugins', path.join(stRoot, 'plugins')),
    ];
}

/**
 * Syntax-only parse of a virtual path.
 * @param {unknown} value
 * @returns {{ zone: string, segments: string[] }}
 */
export function parseVPath(value) {
    if (typeof value !== 'string' || value.length > MAX_VPATH) fail('TG_INVALID_PATH', 'Path must be a string of at most 4096 characters');
    const match = VPATH.exec(value);
    if (!match) fail('TG_INVALID_PATH', `Path must start with one of ${ZONE_NAMES.map((name) => `@${name}`).join(', ')}: ${value}`);
    // Backslashes and drive/stream colons would be reinterpreted by Windows
    // path APIs; control characters have no business in a repo path.
    // eslint-disable-next-line no-control-regex
    if (/[\\\x00-\x1f\x7f]/.test(value)) fail('TG_INVALID_PATH', 'Path contains a backslash or control character');
    const segments = [];
    for (const segment of (match[2] ?? '').split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') fail('TG_INVALID_PATH', 'Path must not contain ".." segments');
        if (segment.includes(':')) fail('TG_INVALID_PATH', 'Path segments must not contain ":"');
        segments.push(segment);
    }
    return { zone: match[1], segments };
}

/** The most specific available zone containing `real`, or null. */
function bestZone(real, zones, caseInsensitive) {
    let best = null;
    for (const zone of zones) {
        if (!zone.available || !isInside(real, zone.root, caseInsensitive)) continue;
        if (!best || zone.root.length > best.root.length) best = zone;
    }
    return best;
}

/**
 * Virtual display path of a real absolute path inside a zone, e.g.
 * `@STuser/chats`.
 */
function inZone(real, zone) {
    const rel = toPosixRel(zone.root, real);
    return rel ? `@${zone.name}/${rel}` : `@${zone.name}`;
}

/**
 * Resolve a virtual path to a real, contained absolute path.
 * @param {string} vpath
 * @param {Zone[]} zones
 * @param {VfsContext} ctx
 * @returns {{ abs: string, rel: string, display: string, alias: string, zone: string, exists: boolean }}
 */
export function resolveVPath(vpath, zones, { stRoot, caseInsensitive }) {
    const parsed = parseVPath(vpath);
    const zone = zones.find((entry) => entry.name === parsed.zone);
    if (!zone?.available) fail('TG_ZONE_UNAVAILABLE', `Zone @${parsed.zone} is not available on this server`);
    const { real, exists } = realpathLoose(path.join(zone.root, ...parsed.segments));
    if (!isInside(real, stRoot, caseInsensitive)) fail('TG_PATH_OUTSIDE_ROOT', `${vpath} resolves outside the SillyTavern root`);
    const rel = toPosixRel(stRoot, real);
    const owner = bestZone(real, zones, caseInsensitive);
    return {
        abs: real,
        rel,
        display: rel ? `@ST/${rel}` : '@ST',
        alias: inZone(real, owner),
        zone: owner.name,
        exists,
    };
}

/**
 * `@ST/...` form of an absolute path (used for hints and messages), or null
 * when it lies outside the ST root.
 * @param {string} abs
 * @param {VfsContext} ctx
 */
export function toVPath(abs, { stRoot, caseInsensitive }) {
    const { real } = realpathLoose(abs);
    if (!isInside(real, stRoot, caseInsensitive)) return null;
    const rel = toPosixRel(stRoot, real);
    return rel ? `@ST/${rel}` : '@ST';
}
