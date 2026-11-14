/**
 * Locate the git executable. Windows uses only the user-provided MinGit in
 * the plugin folder, so a system Git for Windows with its own config and
 * credential manager never runs; elsewhere the system git on PATH is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MIN_GIT_VERSION } from './constants.mjs';
import { passthroughEnv } from './git-env.mjs';
import { runGit } from './runner.mjs';

export const MINGIT_RELEASES_URL = 'https://github.com/git-for-windows/git/releases/latest';

/** Compare dotted versions numerically; returns <0, 0 or >0. */
export function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff) return diff;
    }
    return 0;
}

/** `2.45.1` from `git version 2.45.1.windows.1`, or null. */
export function parseGitVersion(output) {
    const match = /git version (\d+)\.(\d+)\.(\d+)/.exec(output);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function findOnPath(envPath, delimiter) {
    for (const dir of (envPath || '').split(delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'git');
        try {
            if (fs.statSync(candidate).isFile()) {
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            }
        } catch {
            // not here; keep looking
        }
    }
    return null;
}

function installHint(env) {
    const termux = /com\.termux/.test(env.PREFIX || '');
    return {
        commands: termux
            ? [{ platform: 'termux', command: 'pkg install git' }]
            : [
                { platform: 'debian', command: 'sudo apt install git' },
                { platform: 'fedora', command: 'sudo dnf install git' },
                { platform: 'macos', command: 'xcode-select --install' },
                { platform: 'termux', command: 'pkg install git' },
            ],
    };
}

/**
 * @typedef {object} GitInfo
 * @property {boolean} available
 * @property {string|null} path
 * @property {'mingit'|'system'} source
 * @property {string|null} version
 * @property {string} minVersion
 * @property {string} [reason] error code when unavailable
 * @property {object} [hint]
 */

/**
 * Find git and check its version.
 * @param {object} options
 * @param {string} options.serverPluginDir
 * @param {(abs: string) => string|null} options.toVPath for user-facing hints
 * @param {NodeJS.Platform} [options.platform]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<GitInfo>}
 */
export async function detectGit({ serverPluginDir, toVPath, platform = process.platform, env = process.env }) {
    const base = { available: false, path: null, version: null, minVersion: MIN_GIT_VERSION };
    let gitPath;
    let source;
    if (platform === 'win32') {
        source = 'mingit';
        const mingitDir = path.join(serverPluginDir, 'mingit');
        gitPath = path.join(mingitDir, 'cmd', 'git.exe');
        if (!fs.existsSync(gitPath)) {
            return {
                ...base,
                source,
                reason: 'TG_MINGIT_MISSING',
                hint: { path: toVPath(mingitDir), expected: toVPath(gitPath), url: MINGIT_RELEASES_URL },
            };
        }
    } else {
        source = 'system';
        gitPath = findOnPath(env.PATH, path.delimiter);
        if (!gitPath) return { ...base, source, reason: 'TG_GIT_MISSING', hint: installHint(env) };
    }

    const hint = source === 'mingit' ? { path: toVPath(path.join(serverPluginDir, 'mingit')), url: MINGIT_RELEASES_URL } : installHint(env);
    let version = null;
    try {
        // `--version` reads no config; a minimal env is enough here.
        const result = await runGit({
            gitPath,
            args: ['--version'],
            cwd: serverPluginDir,
            env: { ...passthroughEnv(env, platform), GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
            timeoutMs: 15_000,
            platform,
        });
        version = parseGitVersion(result.stdout);
    } catch {
        version = null;
    }
    // A git that cannot report its version is as good as missing.
    if (!version) return { ...base, source, path: gitPath, reason: source === 'mingit' ? 'TG_MINGIT_MISSING' : 'TG_GIT_MISSING', hint };
    if (compareVersions(version, MIN_GIT_VERSION) < 0) return { ...base, source, path: gitPath, version, reason: 'TG_GIT_TOO_OLD', hint };
    return { ...base, available: true, source, path: gitPath, version };
}
