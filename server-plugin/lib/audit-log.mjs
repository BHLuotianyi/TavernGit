/**
 * Append-only JSONL audit log with single-backup size rotation.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_TAIL_LIMIT = 500;
// Rejected requests are logged with fields taken from the request itself, so
// one entry must not be able to grow with the request that caused it.
const MAX_FIELD_CHARS = 512;
const MAX_LIST_ITEMS = 64;
const MAX_DEPTH = 3;

/**
 * Copy of `value` with long strings, long lists and deep nesting cut short.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
function bounded(value, depth = 0) {
    if (typeof value === 'string') {
        return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return '…';
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_LIST_ITEMS).map((item) => bounded(item, depth + 1));
        if (value.length > MAX_LIST_ITEMS) items.push(`… ${value.length - MAX_LIST_ITEMS} more`);
        return items;
    }
    return Object.fromEntries(
        Object.entries(value).slice(0, MAX_LIST_ITEMS).map(([key, item]) => [bounded(key), bounded(item, depth + 1)]),
    );
}

/**
 * Parse non-empty JSON lines from a log file, returning entries newest-first.
 * @param {string} file
 * @returns {object[]}
 */
function readEntriesReversed(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error && error.code === 'ENOENT') return [];
        throw error;
    }
    const lines = raw.split('\n');
    const entries = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            entries.push(JSON.parse(line));
        } catch {
            // A line torn by a crash mid-append must not make the whole log unreadable.
        }
    }
    return entries;
}

/**
 * Create an audit log backed by `<stateDir>/audit.jsonl` (rotated to `audit.1.jsonl`).
 * @param {string} stateDir
 * @param {{ maxBytes?: number }} [options]
 */
export function createAuditLog(stateDir, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const file = path.join(stateDir, 'audit.jsonl');
    const rotatedFile = path.join(stateDir, 'audit.1.jsonl');

    return {
        /**
         * Append one audit entry, rotating `audit.jsonl` to `audit.1.jsonl` when `maxBytes` is reached.
         * Long strings and lists in the entry are cut short (see `bounded`).
         * @param {object} entry
         */
        append(entry) {
            fs.mkdirSync(stateDir, { recursive: true });
            const line = JSON.stringify(bounded(entry)) + '\n';
            try {
                const stat = fs.statSync(file);
                if (stat.size > 0 && stat.size + Buffer.byteLength(line, 'utf8') > maxBytes) {
                    fs.renameSync(file, rotatedFile);
                }
            } catch (error) {
                if (!error || error.code !== 'ENOENT') throw error;
            }
            fs.appendFileSync(file, line, 'utf8');
        },

        /**
         * Return up to `limit` (capped at 500) audit entries, newest first.
         * @param {number} [limit=500]
         * @returns {object[]}
         */
        tail(limit = MAX_TAIL_LIMIT) {
            const parsed = Number(limit);
            const cap = Number.isFinite(parsed)
                ? Math.min(Math.max(0, Math.floor(parsed)), MAX_TAIL_LIMIT)
                : MAX_TAIL_LIMIT;
            if (cap === 0) return [];

            const results = readEntriesReversed(file);
            if (results.length >= cap) return results.slice(0, cap);

            const older = readEntriesReversed(rotatedFile);
            for (const entry of older) {
                results.push(entry);
                if (results.length >= cap) break;
            }
            return results;
        },
    };
}
