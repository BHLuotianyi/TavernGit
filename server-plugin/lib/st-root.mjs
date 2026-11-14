import fs from 'node:fs';
import path from 'node:path';
import { isInside, toPosixRel } from './paths.mjs';

/**
 * A directory is the ST root when it holds `server.js` and a `package.json`
 * named `sillytavern`. Checking the package name keeps a stray `server.js`
 * higher up from being mistaken for SillyTavern.
 */
function isStRoot(dir) {
    try {
        if (!fs.statSync(path.join(dir, 'server.js')).isFile()) return false;
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return pkg?.name === 'sillytavern';
    } catch {
        return false;
    }
}

/**
 * Find the ST root from the server plugin directory. Two install layouts are
 * supported: `<ST>/plugins/taverngit/` (copied `server-plugin/`) and
 * `<ST>/plugins/taverngit/server-plugin/` (whole repo cloned).
 * @param {string} serverPluginDir
 * @returns {string|null} real path of the ST root
 */
export function locateStRoot(serverPluginDir) {
    for (const up of ['../..', '../../..']) {
        const dir = path.resolve(serverPluginDir, up);
        if (isStRoot(dir)) return fs.realpathSync.native(dir);
    }
    return null;
}

/**
 * `dataRoot` from `<ST>/config.yaml`, or null. ST 1.12.0 to 1.12.3 keep the
 * data root in a module-local variable instead of `globalThis.DATA_ROOT`, so
 * the config file is the only place to learn it there. A top-level scalar
 * line is all we need; pulling in a YAML parser would add a dependency.
 * (A `--dataRoot` CLI override is invisible on those versions.)
 */
function configuredDataRoot(stRoot) {
    try {
        const text = fs.readFileSync(path.join(stRoot, 'config.yaml'), 'utf8');
        const match = /^dataRoot:[ \t]*(['"]?)([^'"\r\n#]*?)\1[ \t]*(#.*)?$/m.exec(text);
        return match?.[2] || null;
    } catch {
        return null;
    }
}

/**
 * ST's data root: `globalThis.DATA_ROOT` (ST >= 1.12.4), else `dataRoot` from
 * config.yaml (ST 1.12.0+). ST 1.11 has neither and keeps user data in
 * `public/`. Data roots outside the ST root are reported but unusable: the
 * sandbox never leaves the ST root.
 * @param {string} stRoot real ST root
 * @param {{ caseInsensitive: boolean, dataRoot?: string }} options `dataRoot`
 *   overrides the lookup (tests).
 * @returns {{ real: string|null, inside: boolean, rel: string|null }}
 */
export function resolveDataRoot(stRoot, { caseInsensitive, dataRoot = globalThis.DATA_ROOT ?? configuredDataRoot(stRoot) }) {
    if (typeof dataRoot !== 'string' || !dataRoot) return { real: null, inside: false, rel: null };
    let real;
    try {
        real = fs.realpathSync.native(path.resolve(stRoot, dataRoot));
    } catch {
        return { real: null, inside: false, rel: null };
    }
    // A data root equal to the ST root would make every file "data" tier.
    const inside = real !== stRoot && isInside(real, stRoot, caseInsensitive);
    return { real, inside, rel: inside ? toPosixRel(stRoot, real) : null };
}
