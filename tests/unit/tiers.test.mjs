import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSensitive, matchGlob, pathTier, repoTier } from '../../server-plugin/lib/tiers.mjs';

const ctx = { dataRel: 'data', serverPluginRel: 'plugins/taverngit', caseInsensitive: false };

describe('tiers', () => {
    it('classifies repositories by root and contained rule prefixes', () => {
        assert.equal(repoTier('data/default-user/chats', ctx), 'data');
        assert.equal(repoTier('data/default-user', ctx), 'frontend');
        assert.equal(repoTier('data', ctx), 'frontend');
        assert.equal(repoTier('data/default-user/extensions/foo', ctx), 'frontend');
        assert.equal(repoTier('public', ctx), 'frontend');
        assert.equal(repoTier('public/scripts/extensions/third-party/x', ctx), 'frontend');
        assert.equal(repoTier('', ctx), 'server');
        assert.equal(repoTier('plugins/x', ctx), 'server');
        assert.equal(repoTier('src', ctx), 'server');
    });

    it('treats everything as server or frontend without a data root (ST < 1.12)', () => {
        const old = { ...ctx, dataRel: null };
        assert.equal(pathTier('public/tg-smoke', old), 'frontend');
        assert.equal(pathTier('data/x', old), 'server');
    });

    it('matches case-insensitively when asked', () => {
        assert.equal(pathTier('Public/x', { ...ctx, caseInsensitive: true }), 'frontend');
        assert.equal(pathTier('Public/x', ctx), 'server');
        assert.equal(isSensitive('CONFIG.yaml', { ...ctx, caseInsensitive: true }), true);
    });

    it('flags sensitive paths', () => {
        assert.equal(isSensitive('data/default-user/secrets.json', ctx), true);
        assert.equal(isSensitive('data/_storage/abc', ctx), true);
        assert.equal(isSensitive('data/cookie-secret.txt', ctx), true);
        assert.equal(isSensitive('secrets.json', ctx), true);
        assert.equal(isSensitive('config.yaml', ctx), true);
        assert.equal(isSensitive('plugins/taverngit/state/credentials.json', ctx), true);
        assert.equal(isSensitive('data/default-user/chats/secrets.json', ctx), false);
        assert.equal(isSensitive('data/default-user/settings.json', ctx), false);
    });

    it('matchGlob handles * and trailing **', () => {
        assert.equal(matchGlob('a/b/c', 'a/*/c'), true);
        assert.equal(matchGlob('a/b/c/d', 'a/*/c'), false);
        assert.equal(matchGlob('a/b', 'a/**'), true);
        assert.equal(matchGlob('a', 'a/**'), true);
        assert.equal(matchGlob('b', 'a/**'), false);
    });
});
