import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectCallerOrigin, extractExtensionFolder } from '../../src/caller.js';
import { PROTOCOL_VERSION } from '../../src/constants.js';
import { ERROR_CODES, TavernGitError } from '../../src/errors.js';
import { loadI18n, tr } from '../../src/i18n.js';
import { parseLogOutput, parseStatusPorcelainV2 } from '../../src/parsers.js';
import { createPublicApi } from '../../src/public-api.js';
import { getLocale, getRequestHeaders, getStContext } from '../../src/st-host.js';
import { request } from '../../src/transport.js';
import { showConsentDialog } from '../../src/ui/consent-dialog.js';
import { createConsentQueue } from '../../src/ui/consent-queue.js';
import { mountSettingsPanel } from '../../src/ui/settings-panel.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Node import safety', () => {
    it('exports are usable without browser globals', async () => {
        assert.equal(getStContext(), null);
        assert.deepEqual(getRequestHeaders(), {});
        assert.equal(getLocale(), 'en');
        assert.equal(typeof request, 'function');
        assert.equal(typeof showConsentDialog, 'function');
        assert.equal(await mountSettingsPanel({ getStatus: async () => ({}) }), null);
    });
});

describe('parseStatusPorcelainV2', () => {
    it('handles empty output', () => {
        const res = parseStatusPorcelainV2('');
        assert.deepEqual(res, {
            branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 },
            entries: [],
        });
    });

    it('parses branch headers, changed, renamed, unmerged, untracked, and ignored entries', () => {
        const stdout = [
            '# branch.oid abcdef1234567890',
            '# branch.head main',
            '# branch.upstream origin/main',
            '# branch.ab +3 -1',
            '1 M. N... 100644 100644 100644 aaaa bbbb dir/file with spaces.txt',
            '1 .M N... 100644 100644 100644 aaaa bbbb modified.js',
            '2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt',
            'old name.txt',
            'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.json',
            '? untracked dir/new.md',
            '! ignored.log',
            '',
        ].join('\0');

        const res = parseStatusPorcelainV2(stdout);
        assert.deepEqual(res.branch, {
            oid: 'abcdef1234567890',
            head: 'main',
            upstream: 'origin/main',
            ahead: 3,
            behind: 1,
        });
        assert.deepEqual(res.entries, [
            { type: 'changed', index: 'M', worktree: '.', path: 'dir/file with spaces.txt' },
            { type: 'changed', index: '.', worktree: 'M', path: 'modified.js' },
            { type: 'renamed', index: 'R', worktree: '.', path: 'new name.txt', origPath: 'old name.txt' },
            { type: 'unmerged', index: 'U', worktree: 'U', path: 'conflict.json' },
            { type: 'untracked', index: '?', worktree: '?', path: 'untracked dir/new.md' },
            { type: 'ignored', index: '!', worktree: '!', path: 'ignored.log' },
        ]);
    });
});

describe('parseLogOutput', () => {
    it('handles empty output', () => {
        assert.deepEqual(parseLogOutput(''), []);
    });

    it('parses commits with zero, one, and multiple parents', () => {
        const r1 = ['h2', 'h1 h0', 'Alice', 'alice@example.com', '2026-01-02T03:04:05Z', 'Merge branch'].join('\x1f');
        const r2 = ['h1', '', 'TavernGit', 'taverngit@localhost', '2026-01-01T00:00:00Z', 'Initial: with \x1f sep'].join('\x1f');
        const stdout = `${r1}\0${r2}\0`;

        assert.deepEqual(parseLogOutput(stdout), [
            {
                hash: 'h2',
                parents: ['h1', 'h0'],
                authorName: 'Alice',
                authorEmail: 'alice@example.com',
                authorDate: '2026-01-02T03:04:05Z',
                subject: 'Merge branch',
            },
            {
                hash: 'h1',
                parents: [],
                authorName: 'TavernGit',
                authorEmail: 'taverngit@localhost',
                authorDate: '2026-01-01T00:00:00Z',
                subject: 'Initial: with \x1f sep',
            },
        ]);
    });
});

describe('detectCallerOrigin', () => {
    it('extracts folder from module URL', () => {
        assert.equal(
            extractExtensionFolder('http://127.0.0.1:8123/scripts/extensions/third-party/TavernGit/src/caller.js'),
            'TavernGit',
        );
        assert.equal(extractExtensionFolder('file:///tmp/TavernGit/src/caller.js'), null);
    });

    it('skips TavernGit frames and returns first external third-party extension in V8 stack', () => {
        const stack = [
            'Error',
            '    at detectCallerOrigin (http://127.0.0.1:8123/scripts/extensions/third-party/TavernGit/src/caller.js:35:15)',
            '    at Object.git (http://127.0.0.1:8123/scripts/extensions/third-party/TavernGit/src/public-api.js:90:28)',
            '    at Object.status (http://127.0.0.1:8123/scripts/extensions/third-party/TavernGit/src/public-api.js:140:20)',
            '    at syncRepo (http://127.0.0.1:8123/scripts/extensions/third-party/My%20Extension/index.js:42:18)',
            '    at HTMLButtonElement.<anonymous> (http://127.0.0.1:8123/scripts/extensions/third-party/Other/index.js:10:5)',
        ].join('\n');

        assert.equal(detectCallerOrigin('TavernGit', stack), 'My Extension');
    });

    it('handles Firefox-style stacks', () => {
        const stack = [
            'detectCallerOrigin@https://st.example/scripts/extensions/third-party/TavernGit/src/caller.js:35:15',
            'run@https://st.example/scripts/extensions/third-party/CharSync/main.js?t=123:88:12',
        ].join('\n');

        assert.equal(detectCallerOrigin('TavernGit', stack), 'CharSync');
    });

    it('returns null for console/internal calls without third-party callers', () => {
        const stack = [
            'Error',
            '    at detectCallerOrigin (http://127.0.0.1:8123/scripts/extensions/third-party/TavernGit/src/caller.js:35:15)',
            '    at <anonymous>:1:15',
        ].join('\n');

        assert.equal(detectCallerOrigin('TavernGit', stack), null);
        assert.equal(detectCallerOrigin('TavernGit', null), null);
    });
});

describe('i18n parity and formatting', () => {
    it('has identical key sets and placeholder tokens in en.json and zh-cn.json', () => {
        const en = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'i18n/en.json'), 'utf8'));
        const zh = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'i18n/zh-cn.json'), 'utf8'));

        const enKeys = Object.keys(en).sort();
        const zhKeys = Object.keys(zh).sort();
        assert.deepEqual(enKeys, zhKeys);

        for (const key of enKeys) {
            assert.equal(typeof en[key], 'string');
            assert.equal(typeof zh[key], 'string');
            assert.ok(en[key].length > 0, `empty en key: ${key}`);
            assert.ok(zh[key].length > 0, `empty zh-cn key: ${key}`);

            const enVars = [...en[key].matchAll(/\$\{(\d+)\}/g)].map((m) => m[0]).sort();
            const zhVars = [...zh[key].matchAll(/\$\{(\d+)\}/g)].map((m) => m[0]).sort();
            assert.deepEqual(zhVars, enVars, `placeholder mismatch on ${key}`);
        }
    });

    it('loads locale bundles and formats placeholders', async () => {
        await loadI18n('zh-cn');
        assert.equal(tr('consent.header', 'fallback', 'Demo'), 'TavernGit — Demo');
        assert.equal(tr('missing.key', 'Hello ${0}!', 'World'), 'Hello World!');
        await loadI18n('en');
    });
});

describe('consentQueue', () => {
    it('serializes prompts in FIFO order even across rejections', async () => {
        const events = [];
        const queue = createConsentQueue(async (item) => {
            events.push(`start:${item.id}`);
            await new Promise((r) => setTimeout(r, 10));
            events.push(`end:${item.id}`);
            if (item.deny) throw new TavernGitError(ERROR_CODES.TG_CONSENT_DENIED, 'denied');
            return `app-${item.id}`;
        });

        const p1 = queue.request({ id: 1, deny: true }).catch((e) => e.code);
        const p2 = queue.request({ id: 2, deny: false });
        const [r1, r2] = await Promise.all([p1, p2]);

        assert.equal(r1, ERROR_CODES.TG_CONSENT_DENIED);
        assert.equal(r2, 'app-2');
        assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2']);
    });
});

describe('createPublicApi', () => {
    it('validates caller id and name in connect()', () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify({
            ok: true,
            plugin: { version: '0.1.0', versionCode: 1, protocol: PROTOCOL_VERSION },
            git: { available: true, source: 'system', version: '2.45.0', minVersion: '2.32.0' },
            platform: 'linux',
            dataRootInside: true,
            zones: [],
            user: { handle: 'default-user', admin: true },
        }), { status: 200 });

        try {
            const api = createPublicApi({ presentConsent: async () => 'app-1' });
            assert.throws(() => api.connect({ id: '../bad', name: 'Bad' }), (err) => err.code === ERROR_CODES.TG_BAD_REQUEST);
            assert.throws(() => api.connect({ id: 'ok', name: '' }), (err) => err.code === ERROR_CODES.TG_BAD_REQUEST);
            const client = api.connect({ id: 'my.ext', name: 'My Ext' });
            assert.equal(typeof client.git, 'function');
            assert.equal(typeof client.status, 'function');
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('rejects calls with TG_PROTOCOL_MISMATCH when server protocol differs', async () => {
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response(JSON.stringify({
            ok: true,
            plugin: { version: '0.2.0', versionCode: 2, protocol: PROTOCOL_VERSION + 1 },
            git: { available: true },
            platform: 'linux',
            dataRootInside: true,
            zones: [],
            user: { handle: 'default-user', admin: true },
        }), { status: 200 });

        try {
            const api = createPublicApi({ presentConsent: async () => 'app-1' });
            await api.ready;
            const client = api.connect({ id: 'ext', name: 'Ext' });
            await assert.rejects(() => api.resolve('@STuser'), (err) => err.code === ERROR_CODES.TG_PROTOCOL_MISMATCH);
            await assert.rejects(() => client.status('@STuser/repo'), (err) => err.code === ERROR_CODES.TG_PROTOCOL_MISMATCH);
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    it('retries /exec with approvalId after consent and throws TG_GIT_FAILED on non-zero helper exit', async () => {
        const origFetch = globalThis.fetch;
        const execBodies = [];
        globalThis.fetch = async (url, init) => {
            if (url.endsWith('/status')) {
                return new Response(JSON.stringify({
                    ok: true,
                    plugin: { version: '0.1.0', versionCode: 1, protocol: PROTOCOL_VERSION },
                    git: { available: true },
                    platform: 'linux',
                    dataRootInside: true,
                    zones: [],
                    user: { handle: 'default-user', admin: true },
                }), { status: 200 });
            }
            if (url.endsWith('/exec')) {
                const body = JSON.parse(init.body);
                execBodies.push(body);
                if (!body.approvalId) {
                    return new Response(JSON.stringify({
                        ok: false,
                        error: { code: ERROR_CODES.TG_CONSENT_REQUIRED, message: 'Consent required' },
                        consent: { requestId: 'req-1', argv: body.args },
                    }), { status: 409 });
                }
                return new Response(JSON.stringify({
                    ok: true,
                    exitCode: 1,
                    stdout: '',
                    stderr: 'fatal: not a git repository',
                    durationMs: 5,
                    warnings: [],
                }), { status: 200 });
            }
            throw new Error(`Unexpected URL ${url}`);
        };

        try {
            const api = createPublicApi({ presentConsent: async (c) => `approved-${c.requestId}` });
            const client = api.connect({ id: 'ext', name: 'Ext' });
            await assert.rejects(
                () => client.status('@STuser/missing'),
                (err) => err.code === ERROR_CODES.TG_GIT_FAILED && err.details.exitCode === 1,
            );
            assert.equal(execBodies.length, 2);
            assert.equal(execBodies[0].approvalId, undefined);
            assert.equal(execBodies[1].approvalId, 'approved-req-1');
        } finally {
            globalThis.fetch = origFetch;
        }
    });
});
