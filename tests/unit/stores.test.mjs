import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createAuditLog } from '../../server-plugin/lib/audit-log.mjs';
import { createCredentialStore } from '../../server-plugin/lib/credentials.mjs';
import { createIdentityStore } from '../../server-plugin/lib/identity.mjs';
import { readJson, writeJsonAtomic } from '../../server-plugin/lib/json-store.mjs';

const tempDirs = [];

function makeStateDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stores-'));
    tempDirs.push(dir);
    return dir;
}

function errorCode(fn) {
    try {
        fn();
    } catch (error) {
        return error.code;
    }
    return 'NO_ERROR';
}

afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

describe('json-store', () => {
    it('returns fallback when missing and writes atomically', () => {
        const dir = makeStateDir();
        const file = path.join(dir, 'sub', 'data.json');
        assert.deepEqual(readJson(file, { empty: true }), { empty: true });
        writeJsonAtomic(file, { hello: 'world' }, { mode: 0o600 });
        assert.deepEqual(readJson(file, null), { hello: 'world' });
        if (process.platform !== 'win32') {
            const mode = fs.statSync(file).mode & 0o777;
            assert.equal(mode, 0o600);
        }
    });
});

describe('credentials', () => {
    it('stores tokens securely, hides them in list/add, and builds configs only for stored hosts', () => {
        const dir = makeStateDir();
        const store = createCredentialStore(dir);

        const added = store.add({ host: 'GitHub.com', username: 'alice', token: 'ghp_secret123' });
        assert.equal(added.host, 'github.com');
        assert.equal(added.username, 'alice');
        assert.equal('token' in added, false);

        const listed = store.list();
        assert.equal(listed.length, 1);
        assert.equal('token' in listed[0], false);
        assert.equal(JSON.stringify(listed).includes('ghp_secret123'), false);

        if (process.platform !== 'win32') {
            const mode = fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777;
            assert.equal(mode, 0o600);
        }

        const configs = store.configEntriesFor(['github.com', 'gitlab.com']);
        assert.equal(configs.length, 1);
        assert.equal(configs[0][0], 'http.https://github.com/.extraHeader');
        assert.equal(
            configs[0][1],
            `Authorization: Basic ${Buffer.from('alice:ghp_secret123', 'utf8').toString('base64')}`,
        );

        assert.equal(store.remove(added.id), true);
        assert.equal(store.remove(added.id), false);
        assert.deepEqual(store.configEntriesFor(['github.com']), []);
    });

    it('stores hosts in the form remotes are matched by', () => {
        const store = createCredentialStore(makeStateDir());
        // `https://github.com:443/...` resolves to host `github.com`.
        assert.equal(store.add({ host: 'github.com:443', username: 'u', token: 't' }).host, 'github.com');
        assert.equal(store.add({ host: 'git.example:08443', username: 'u', token: 't' }).host, 'git.example:8443');
        assert.equal(store.configEntriesFor(['github.com', 'git.example:8443']).length, 2);
        assert.equal(errorCode(() => store.add({ host: 'git.example:70000', username: 'u', token: 't' })), 'TG_INVALID_ARGUMENT');
    });

    it('rejects invalid hosts, colons/control chars in username, and empty/control tokens', () => {
        const dir = makeStateDir();
        const store = createCredentialStore(dir);

        assert.equal(errorCode(() => store.add({ host: 'https://github.com', username: 'u', token: 't' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => store.add({ host: 'bad host', username: 'u', token: 't' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => store.add({ host: 'github.com', username: 'bad:user', token: 't' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => store.add({ host: 'github.com', username: 'bad\nuser', token: 't' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => store.add({ host: 'github.com', username: 'user', token: '' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => store.add({ host: 'github.com', username: 'user', token: 'tok\ren' })), 'TG_INVALID_ARGUMENT');
    });
});

describe('identity', () => {
    it('initializes defaults, round-trips values, and rejects unsafe characters', () => {
        const dir = makeStateDir();
        const identity = createIdentityStore(dir);

        assert.deepEqual(identity.get(), { name: 'TavernGit', email: 'taverngit@localhost' });

        identity.set({ name: 'Alice Example', email: 'alice@example.com' });
        assert.deepEqual(identity.get(), { name: 'Alice Example', email: 'alice@example.com' });

        // `#` and `;` start a comment in an unquoted gitconfig value.
        identity.set({ name: 'A # B; C', email: 'a@example.com' });
        assert.deepEqual(identity.get(), { name: 'A # B; C', email: 'a@example.com' });

        assert.equal(errorCode(() => identity.set({ name: 'Bad\nName', email: 'a@b.c' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => identity.set({ name: 'Bad"Name', email: 'a@b.c' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => identity.set({ name: 'Bad\\Name', email: 'a@b.c' })), 'TG_INVALID_ARGUMENT');
        assert.equal(errorCode(() => identity.set({ name: 'Ok', email: 'a@b.c\n[core]' })), 'TG_INVALID_ARGUMENT');
    });
});

describe('audit-log', () => {
    it('returns entries newest-first and rotates to audit.1.jsonl at maxBytes', () => {
        const dir = makeStateDir();
        const log = createAuditLog(dir, { maxBytes: 120 });

        for (let i = 1; i <= 5; i++) {
            log.append({ seq: i, msg: `entry-${i}-payload` });
        }

        assert.equal(fs.existsSync(path.join(dir, 'audit.1.jsonl')), true);
        const recent = log.tail(10);
        assert.deepEqual(
            recent.map((e) => e.seq),
            [5, 4, 3, 2, 1],
        );
        assert.deepEqual(
            log.tail(2).map((e) => e.seq),
            [5, 4],
        );
    });

    it('cuts oversized entries short and survives a torn line', () => {
        const dir = makeStateDir();
        const log = createAuditLog(dir);

        log.append({ seq: 1, repo: 'r'.repeat(100_000), argv: Array.from({ length: 5000 }, () => 'a'.repeat(10_000)) });
        assert.ok(fs.statSync(path.join(dir, 'audit.jsonl')).size < 100_000);

        fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"seq":2,"argv":["sta');
        fs.appendFileSync(path.join(dir, 'audit.jsonl'), '\n');
        log.append({ seq: 3 });
        assert.deepEqual(log.tail(10).map((e) => e.seq), [3, 1]);
    });
});
