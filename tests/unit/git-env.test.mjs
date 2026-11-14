import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGitEnv } from '../../server-plugin/lib/git-env.mjs';
import { compareVersions, parseGitVersion } from '../../server-plugin/lib/git-binary.mjs';

const processEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    GIT_DIR: '/evil',
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'",
    GIT_SSH_COMMAND: 'x',
    GIT_EXEC_PATH: '/apk/libexec/git-core',
    https_proxy: 'http://proxy:8080',
    Https_Proxy: 'http://mixed',
    LD_PRELOAD: '/evil.so',
};

describe('buildGitEnv', () => {
    const extraConfig = [['http.https://example.com/.extraHeader', 'Authorization: Basic c2VjcmV0']];
    const env = buildGitEnv({ stateDir: '/st/plugins/taverngit/state', stRoot: '/st', platform: 'linux', processEnv, extraConfig });

    it('drops inherited HOME and GIT_* except the passthrough list', () => {
        assert.equal(env.HOME, '/st/plugins/taverngit/state/home');
        assert.equal(env.GIT_DIR, undefined);
        assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
        assert.equal(env.GIT_SSH_COMMAND, undefined);
        assert.equal(env.LD_PRELOAD, undefined);
        assert.equal(env.GIT_EXEC_PATH, '/apk/libexec/git-core');
        assert.equal(env.https_proxy, 'http://proxy:8080');
        assert.equal(env.Https_Proxy, undefined);
        assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
        assert.equal(env.GIT_CEILING_DIRECTORIES, '/');
    });

    it('declares exactly GIT_CONFIG_COUNT entries, credentials last', () => {
        const count = Number(env.GIT_CONFIG_COUNT);
        assert.ok(count > 10);
        for (let i = 0; i < count; i += 1) assert.equal(typeof env[`GIT_CONFIG_KEY_${i}`], 'string');
        assert.equal(env[`GIT_CONFIG_KEY_${count}`], undefined);
        assert.equal(env[`GIT_CONFIG_KEY_${count - 1}`], extraConfig[0][0]);
        assert.equal(env.GIT_CONFIG_KEY_0, 'core.hooksPath');
    });

    it('matches Windows variable names case-insensitively', () => {
        const win = buildGitEnv({ stateDir: 'C:\\st\\state', stRoot: 'C:\\st', platform: 'win32', processEnv: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', Home: 'x' } });
        assert.equal(win.Path, 'C:\\Windows');
        assert.equal(win.SystemRoot, 'C:\\Windows');
        assert.equal(win.Home, undefined);
        const keys = Object.keys(win).filter((key) => key.startsWith('GIT_CONFIG_KEY_')).map((key) => win[key]);
        assert.ok(keys.includes('core.longpaths'));
    });
});

describe('git version parsing', () => {
    it('parses vendor suffixes and compares numerically', () => {
        assert.equal(parseGitVersion('git version 2.45.1.windows.1\n'), '2.45.1');
        assert.equal(parseGitVersion('git version 2.39.3 (Apple Git-146)'), '2.39.3');
        assert.equal(parseGitVersion('nope'), null);
        assert.ok(compareVersions('2.32.0', '2.9.0') > 0);
        assert.ok(compareVersions('2.31.9', '2.32.0') < 0);
    });
});
