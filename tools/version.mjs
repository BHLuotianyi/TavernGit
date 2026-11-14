#!/usr/bin/env node
/**
 * Release identity writer for TavernGit.
 *
 * The readable `version` (semver) and the integer `versionCode` are written to
 * every file that carries them; `versionCode` grows by one on every `set`.
 * Only the version fields are touched, so formatting stays intact.
 *
 * This is the add-on's own version; the git engine version is detected at
 * runtime and never recorded here.
 *
 * Usage:
 *   node tools/version.mjs set 0.2.0
 *   node tools/version.mjs check            # every file carries the same version
 *   node tools/version.mjs check-tag v0.2.0 # plus: tag matches, CHANGELOG has the section
 *   node tools/version.mjs notes v0.2.0     # print that CHANGELOG section
 *
 * `--root <dir>` overrides the repository root (used by tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
    { file: 'manifest.json' },
    { file: 'package.json' },
    { file: 'server-plugin/package.json' },
    { file: 'src/constants.js', constants: true },
];

/** semver.org's reference grammar (without the optional `v` prefix). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** True for a semver string. */
export function isSemver(version) {
    return SEMVER.test(String(version).replace(/^v/, ''));
}

/** Current `{ version, versionCode }`; the code is the max across files. */
export function readCurrent(root = DEFAULT_ROOT) {
    const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const manifest = read('manifest.json');
    const codes = [manifest, read('package.json'), read('server-plugin/package.json')]
        .map((json) => Number(json.versionCode))
        .filter(Number.isFinite);
    return { version: String(manifest.version || ''), versionCode: Math.max(0, ...codes) };
}

function replaceOnce(source, pattern, replacement, file) {
    if (!pattern.test(source)) throw new Error(`${file}: version field not found (${pattern})`);
    return source.replace(pattern, replacement);
}

/** Write `version` and `versionCode + 1` to every target file. */
export function setVersion(version, root = DEFAULT_ROOT) {
    const display = String(version).replace(/^v/, '');
    if (!isSemver(display)) throw new RangeError(`not a semver version: ${version}`);
    const versionCode = readCurrent(root).versionCode + 1;

    for (const target of TARGETS) {
        const file = path.join(root, target.file);
        const original = fs.readFileSync(file, 'utf8');
        let content = original;
        if (target.constants) {
            content = replaceOnce(content, /(export const EXTENSION_VERSION = ')[^']*(';)/, `$1${display}$2`, target.file);
            content = replaceOnce(content, /(export const EXTENSION_VERSION_CODE = )\d+(;)/, `$1${versionCode}$2`, target.file);
        } else {
            content = replaceOnce(content, /("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(display)}`, target.file);
            content = replaceOnce(content, /("versionCode"\s*:\s*)\d+/, `$1${versionCode}`, target.file);
        }
        if (content !== original) fs.writeFileSync(file, content);
    }
    return { version: display, versionCode };
}

/** True when `tag` (`vX.Y.Z`) names the current version. */
export function matchesTag(tag, version) {
    return String(tag).replace(/^v/i, '') === version;
}

/** `{ file, version, versionCode }` as written in each target file. */
export function readTargets(root = DEFAULT_ROOT) {
    return TARGETS.map((target) => {
        const source = fs.readFileSync(path.join(root, target.file), 'utf8');
        if (target.constants) {
            return {
                file: target.file,
                version: source.match(/export const EXTENSION_VERSION = '([^']*)';/)?.[1],
                versionCode: Number(source.match(/export const EXTENSION_VERSION_CODE = (\d+);/)?.[1]),
            };
        }
        const json = JSON.parse(source);
        return { file: target.file, version: json.version, versionCode: Number(json.versionCode) };
    });
}

/** Throw unless every target file carries the same semver version and code. */
export function checkConsistency(root = DEFAULT_ROOT) {
    const targets = readTargets(root);
    const [first] = targets;
    const mismatched = targets.filter((t) => t.version !== first.version || t.versionCode !== first.versionCode);
    if (mismatched.length > 0 || !isSemver(first.version) || !Number.isInteger(first.versionCode)) {
        const listing = targets.map((t) => `${t.file}: ${t.version} (${t.versionCode})`).join(', ');
        throw new Error(`version files disagree or are invalid: ${listing}`);
    }
    return { version: first.version, versionCode: first.versionCode };
}

/** Body of the `## [version]` section of CHANGELOG.md; throws when missing or empty. */
export function releaseNotes(version, root = DEFAULT_ROOT) {
    const lines = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
    const heading = `## [${String(version).replace(/^v/i, '')}]`;
    const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
    if (start < 0) throw new Error(`CHANGELOG.md has no "${heading}" section`);
    const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
    const body = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
    if (!body) throw new Error(`CHANGELOG.md section "${heading}" is empty`);
    return body;
}

function main(argv) {
    const rootFlag = argv.indexOf('--root');
    const root = rootFlag >= 0 ? path.resolve(argv[rootFlag + 1]) : DEFAULT_ROOT;
    const [command, value] = rootFlag >= 0 ? argv.filter((_, i) => i !== rootFlag && i !== rootFlag + 1) : argv;

    switch (command) {
        case 'set': {
            if (!value) throw new Error('usage: node tools/version.mjs set <semver>');
            process.stdout.write(`${JSON.stringify(setVersion(value, root))}\n`);
            return;
        }
        case 'check': {
            process.stdout.write(`${JSON.stringify(checkConsistency(root))}\n`);
            return;
        }
        case 'check-tag': {
            const tag = value || process.env.GITHUB_REF_NAME;
            const { version } = checkConsistency(root);
            if (!tag || !matchesTag(tag, version)) throw new Error(`tag ${tag} does not match version ${version} (expected v${version})`);
            releaseNotes(version, root);
            process.stdout.write(`${JSON.stringify({ ok: true, tag, version })}\n`);
            return;
        }
        case 'notes': {
            if (!value) throw new Error('usage: node tools/version.mjs notes <tag>');
            process.stdout.write(`${releaseNotes(value, root)}\n`);
            return;
        }
        default:
            throw new Error(`unknown command: ${command}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`[taverngit-version] ${error.message}\n`);
        process.exit(1);
    }
}
