/**
 * Atomic JSON file persistence. Writes go to a sibling temp file and rename
 * into place so a crash or concurrent reader never observes half-written JSON.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Read and parse a JSON file, returning `fallback` when the file does not exist.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
export function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error && error.code === 'ENOENT') return fallback;
        throw error;
    }
}

/**
 * Atomically write `data` as JSON to `file` by writing a temporary file in the
 * same directory and renaming it over the target.
 * @param {string} file
 * @param {unknown} data
 * @param {{ mode?: number }} [options]
 */
export function writeJsonAtomic(file, data, { mode } = {}) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}.${crypto.randomUUID()}`);
    const payload = JSON.stringify(data, null, 2) + '\n';
    try {
        fs.writeFileSync(tmp, payload, {
            encoding: 'utf8',
            ...(mode !== undefined ? { mode } : {}),
        });
        if (mode !== undefined) {
            // Re-apply mode explicitly so process umask cannot loosen or alter the intended permissions.
            fs.chmodSync(tmp, mode);
        }
        fs.renameSync(tmp, file);
    } catch (error) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // Ignore cleanup failure if temp file was never created or already moved.
        }
        throw error;
    }
}
