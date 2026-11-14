/**
 * Commit identity store backed by `<stateDir>/gitconfig`, which `GIT_CONFIG_GLOBAL`
 * points to. Separating identity here keeps user-controlled strings isolated from
 * any other git configuration.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './errors.mjs';

const DEFAULT_IDENTITY = Object.freeze({
    name: 'TavernGit',
    email: 'taverngit@localhost',
});

// Reject newlines, quotes, backslashes, and control characters to prevent gitconfig section/option injection.
// With these gone a value is safe inside double quotes, which is how it is written.
const UNSAFE_IDENTITY_RE = /[\x00-\x1f\x7f"\\]/;

/**
 * Validate a git `user.name` or `user.email` value before writing gitconfig.
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function validateIdentityField(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        fail('TG_INVALID_ARGUMENT', `Commit ${field} must be a non-empty string`);
    }
    if (UNSAFE_IDENTITY_RE.test(value)) {
        fail('TG_INVALID_ARGUMENT', `Commit ${field} contains forbidden characters`);
    }
    return value;
}

/**
 * Parse `[user]` `name` and `email` entries from a minimal gitconfig file.
 * @param {string} raw
 * @returns {{ name: string, email: string }}
 */
function parseGitconfigIdentity(raw) {
    let inUserSection = false;
    let name = DEFAULT_IDENTITY.name;
    let email = DEFAULT_IDENTITY.email;

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
        const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
        if (sectionMatch) {
            inUserSection = sectionMatch[1].trim().toLowerCase() === 'user';
            continue;
        }
        if (!inUserSection) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim().toLowerCase();
        const rawValue = trimmed.slice(eq + 1).trim();
        const value = rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')
            ? rawValue.slice(1, -1)
            : rawValue;
        if (key === 'name' && value) name = value;
        if (key === 'email' && value) email = value;
    }

    return { name, email };
}

/**
 * Write `<stateDir>/gitconfig` atomically so git never reads a partial config file.
 * @param {string} file
 * @param {{ name: string, email: string }} identity
 */
function writeGitconfigAtomic(file, { name, email }) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.gitconfig.tmp.${process.pid}.${crypto.randomUUID()}`);
    // Quoted: unquoted, git cuts a value at `#` or `;` and drops outer whitespace.
    const content = `[user]\n\tname = "${name}"\n\temail = "${email}"\n`;
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, file);
    } catch (error) {
        try {
            fs.unlinkSync(tmp);
        } catch {
            // Ignore cleanup failure.
        }
        throw error;
    }
}

/**
 * Create a commit identity store managing `<stateDir>/gitconfig`.
 * @param {string} stateDir
 */
export function createIdentityStore(stateDir) {
    const file = path.join(stateDir, 'gitconfig');

    function ensureDefault() {
        if (!fs.existsSync(file)) {
            writeGitconfigAtomic(file, DEFAULT_IDENTITY);
        }
    }

    return {
        /**
         * Ensure `<stateDir>/gitconfig` exists, writing the default TavernGit identity if missing.
         */
        ensureDefault,

        /**
         * Read the current commit identity, initializing the default if missing.
         * @returns {{ name: string, email: string }}
         */
        get() {
            ensureDefault();
            const raw = fs.readFileSync(file, 'utf8');
            return parseGitconfigIdentity(raw);
        },

        /**
         * Validate and persist a new commit identity in `<stateDir>/gitconfig`.
         * @param {{ name: string, email: string }} input
         * @returns {{ name: string, email: string }}
         */
        set({ name, email } = {}) {
            const validName = validateIdentityField(name, 'name');
            const validEmail = validateIdentityField(email, 'email');
            const next = { name: validName, email: validEmail };
            writeGitconfigAtomic(file, next);
            return next;
        },
    };
}
