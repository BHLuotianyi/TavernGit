import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { checkConsistency, releaseNotes, setVersion } from '../../tools/version.mjs';

const roots = [];
afterEach(() => {
    while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

function makeRoot(changelog = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-version-'));
    roots.push(root);
    const json = (extra) => `${JSON.stringify({ name: 'x', version: '0.1.0', versionCode: 1, ...extra }, null, 4)}\n`;
    fs.mkdirSync(path.join(root, 'server-plugin'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'manifest.json'), json());
    fs.writeFileSync(path.join(root, 'package.json'), json());
    fs.writeFileSync(path.join(root, 'server-plugin/package.json'), json());
    fs.writeFileSync(
        path.join(root, 'src/constants.js'),
        "export const EXTENSION_VERSION = '0.1.0';\nexport const EXTENSION_VERSION_CODE = 1;\n",
    );
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
    return root;
}

describe('tools/version.mjs', () => {
    it('accepts files written by set and rejects a file left behind', () => {
        const root = makeRoot();
        setVersion('0.2.0', root);
        assert.deepEqual(checkConsistency(root), { version: '0.2.0', versionCode: 2 });

        fs.writeFileSync(
            path.join(root, 'src/constants.js'),
            "export const EXTENSION_VERSION = '0.1.0';\nexport const EXTENSION_VERSION_CODE = 2;\n",
        );
        assert.throws(() => checkConsistency(root), /src\/constants\.js: 0\.1\.0 \(2\)/);
    });

    it('extracts exactly one CHANGELOG section', () => {
        const root = makeRoot(
            '# Changelog\n\n## [Unreleased]\n\n- next\n\n## [0.2.0] - 2026-12-01\n\n### Fixed\n- a\n\n## [0.1.0] - 2026-11-13\n\n- b\n',
        );
        assert.equal(releaseNotes('v0.2.0', root), '### Fixed\n- a');
        assert.equal(releaseNotes('0.1.0', root), '- b');
        assert.throws(() => releaseNotes('v0.1', root), /no "## \[0\.1\]" section/);
        assert.throws(() => releaseNotes('v0.3.0', root), /no "## \[0\.3\.0\]" section/);
    });

    it('rejects an empty CHANGELOG section', () => {
        const root = makeRoot('## [0.2.0] - 2026-12-01\n\n## [0.1.0]\n- b\n');
        assert.throws(() => releaseNotes('v0.2.0', root), /is empty/);
    });
});
