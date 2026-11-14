import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createAuditLog } from '../../server-plugin/lib/audit-log.mjs';
import { createConsentManager } from '../../server-plugin/lib/consent.mjs';
import { MIN_GIT_VERSION } from '../../server-plugin/lib/constants.mjs';
import { createCredentialStore } from '../../server-plugin/lib/credentials.mjs';
import { createExecutor } from '../../server-plugin/lib/execute.mjs';
import { compareVersions, detectGit, parseGitVersion } from '../../server-plugin/lib/git-binary.mjs';
import { prepareStateDirs } from '../../server-plugin/lib/git-env.mjs';
import { createIdentityStore } from '../../server-plugin/lib/identity.mjs';
import { isCaseInsensitivePlatform } from '../../server-plugin/lib/paths.mjs';
import { toVPath } from '../../server-plugin/lib/vfs.mjs';
import { makeFakeSt } from '../helpers/fake-st.mjs';

function checkGitAvailability() {
    if (process.platform === 'win32' && !process.env.TAVERNGIT_TEST_GIT) {
        return 'Windows git integration tests require TAVERNGIT_TEST_GIT';
    }
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
        return 'git binary not found on PATH';
    }
    const version = parseGitVersion(probe.stdout || '');
    if (!version || compareVersions(version, MIN_GIT_VERSION) < 0) {
        return `git >= ${MIN_GIT_VERSION} required (found ${version ?? 'unknown'})`;
    }
    return false;
}

const skipReason = checkGitAvailability();

const cleanups = [];
afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()();
    }
});

function createHarness({ processEnv = process.env } = {}) {
    const fake = makeFakeSt();
    cleanups.push(fake.cleanup);

    const stateDir = path.join(fake.serverPluginDir, 'state');
    prepareStateDirs(stateDir);
    const credentials = createCredentialStore(stateDir);
    const identity = createIdentityStore(stateDir);
    identity.ensureDefault();
    const auditLog = createAuditLog(stateDir);

    const logs = [];
    const consent = createConsentManager({
        stateDir,
        log: (msg) => logs.push(msg),
    });

    const caseInsensitive = isCaseInsensitivePlatform();
    let cachedGit = null;
    async function getGitInfo() {
        if (cachedGit) return cachedGit;
        if (process.platform === 'win32' && process.env.TAVERNGIT_TEST_GIT) {
            const probe = spawnSync(process.env.TAVERNGIT_TEST_GIT, ['--version'], { encoding: 'utf8' });
            cachedGit = {
                available: true,
                path: process.env.TAVERNGIT_TEST_GIT,
                source: 'mingit',
                version: parseGitVersion(probe.stdout || ''),
                minVersion: MIN_GIT_VERSION,
            };
            return cachedGit;
        }
        cachedGit = await detectGit({
            serverPluginDir: fake.serverPluginDir,
            toVPath: (abs) => toVPath(abs, { stRoot: fake.root, caseInsensitive }),
        });
        return cachedGit;
    }

    const executor = createExecutor({
        stRoot: fake.root,
        stateDir,
        serverPluginDir: fake.serverPluginDir,
        dataRoot: fake.dataRoot,
        getGitInfo,
        consent,
        credentials,
        auditLog,
        processEnv,
    });

    const caller = { id: 'test-ext', name: 'Test Ext', origin: 'test-ext' };

    async function runWithConsent(repo, args, { remember = false, input, binary } = {}) {
        try {
            return await executor.execute({ caller, repo, args, input, binary }, {});
        } catch (err) {
            if (err.code !== 'TG_CONSENT_REQUIRED') throw err;
            let consoleCode;
            if (err.consent.needsConsoleCode) {
                const lastLog = logs[logs.length - 1] ?? '';
                const match = /:\s*(\d{6})$/.exec(lastLog);
                assert.ok(match, `expected 6-digit console code in log, got: ${lastLog}`);
                consoleCode = match[1];
            }
            const { approvalId } = consent.decide({
                requestId: err.consent.requestId,
                decision: 'allow',
                remember,
                consoleCode,
                callerName: caller.name,
            });
            return executor.execute({ caller, repo, args, input, binary, approvalId }, {});
        }
    }

    return {
        fake,
        stateDir,
        consent,
        credentials,
        identity,
        auditLog,
        executor,
        caller,
        logs,
        runWithConsent,
    };
}

function makeFakeRouter() {
    const middlewares = [];
    const routes = [];
    return {
        use(fn) {
            middlewares.push(fn);
        },
        get(routePath, fn) {
            routes.push({ method: 'GET', path: routePath, fn });
        },
        post(routePath, fn) {
            routes.push({ method: 'POST', path: routePath, fn });
        },
        delete(routePath, fn) {
            routes.push({ method: 'DELETE', path: routePath, fn });
        },
        async dispatch(method, urlPath, { body, rawBody, params = {}, query = {}, user } = {}) {
            const matched = routes.find((r) => r.method === method && r.path === urlPath);
            assert.ok(matched, `Route not registered: ${method} ${urlPath}`);

            const req = rawBody !== undefined
                ? Readable.from([rawBody])
                : Readable.from([]);
            req.url = urlPath;
            req.query = query;
            req.params = params;
            req.user = user;
            if (body !== undefined) req.body = body;

            let statusCode = 200;
            const headers = {};
            let rawResponse = '';
            let resolveEnd;
            const done = new Promise((resolve) => {
                resolveEnd = resolve;
            });

            const res = {
                get statusCode() {
                    return statusCode;
                },
                set statusCode(code) {
                    statusCode = code;
                },
                setHeader(k, v) {
                    headers[k.toLowerCase()] = v;
                },
                end(chunk = '') {
                    rawResponse += String(chunk);
                    resolveEnd();
                },
            };

            let index = 0;
            async function runNext() {
                if (index < middlewares.length) {
                    const mw = middlewares[index++];
                    let calledNext = false;
                    await mw(req, res, () => {
                        calledNext = true;
                    });
                    if (calledNext) return runNext();
                    return;
                }
                await matched.fn(req, res);
            }

            await runNext();
            await done;
            return {
                status: statusCode,
                headers,
                json: rawResponse ? JSON.parse(rawResponse) : null,
            };
        },
    };
}

describe('executor integration', { skip: skipReason }, () => {
    it('runs init, add, commit, log with default TavernGit identity and sanitizes ST root in output', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);

        const file = path.join(h.fake.dataRoot, 'default-user', 'chats', 'note.txt');
        fs.writeFileSync(file, 'hello world\n');

        await h.runWithConsent('@STuser/chats', ['add', 'note.txt']);
        await h.runWithConsent('@STuser/chats', ['commit', '-m', 'Initial note']);

        const logRes = await h.runWithConsent('@STuser/chats', ['log', '--format=%an <%ae> %s']);
        assert.equal(logRes.exitCode, 0);
        assert.equal(logRes.stdout.trim(), 'TavernGit <taverngit@localhost> Initial note');

        // Output containing the fake root's absolute path must be sanitized to @ST.
        const topRes = await h.runWithConsent('@STuser/chats', ['rev-parse', '--show-toplevel']);
        assert.equal(topRes.exitCode, 0);
        assert.equal(topRes.stdout.trim(), '@ST/data/default-user/chats');
        assert.ok(!topRes.stdout.includes(h.fake.root));
    });

    it('blocks planted .git/hooks/pre-commit via core.hooksPath', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);

        const repoDir = path.join(h.fake.dataRoot, 'default-user', 'chats');
        const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-proof-'));
        cleanups.push(() => fs.rmSync(proofDir, { recursive: true, force: true }));
        const proofFile = path.join(proofDir, 'hook-ran');
        const hookPath = path.join(repoDir, '.git', 'hooks', 'pre-commit');
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${proofFile}"\nexit 1\n`);

        fs.writeFileSync(path.join(repoDir, 'a.txt'), 'content\n');
        await h.runWithConsent('@STuser/chats', ['add', 'a.txt']);
        const commitRes = await h.runWithConsent('@STuser/chats', ['commit', '-m', 'Hook test']);

        assert.equal(commitRes.exitCode, 0);
        assert.equal(fs.existsSync(proofFile), false);
    });

    it('rejects repo config with disallowed keys (core.fsmonitor) before running git', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);

        const repoDir = path.join(h.fake.dataRoot, 'default-user', 'chats');
        const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fsm-'));
        cleanups.push(() => fs.rmSync(proofDir, { recursive: true, force: true }));
        const proofFile = path.join(proofDir, 'fsm-ran');

        execFileSync('git', ['config', '--file', path.join(repoDir, '.git', 'config'), 'core.fsmonitor', `touch "${proofFile}"`]);

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['status']),
            (err) => {
                assert.equal(err.code, 'TG_UNSAFE_REPO_CONFIG');
                assert.ok(err.details?.keys?.includes('core.fsmonitor'));
                return true;
            },
        );
        assert.equal(fs.existsSync(proofFile), false);
    });

    it('refuses to stage secrets.json before git hashes it into the object store', async () => {
        const h = createHarness();
        const userDir = path.join(h.fake.dataRoot, 'default-user');
        await h.runWithConsent('@STuser', ['init']);

        fs.writeFileSync(path.join(userDir, 'secrets.json'), '{"api":"secret"}\n');
        fs.writeFileSync(path.join(userDir, 'ok.txt'), 'safe\n');

        await assert.rejects(
            () => h.runWithConsent('@STuser', ['add', 'secrets.json']),
            (err) => {
                assert.equal(err.code, 'TG_SENSITIVE_PATH');
                assert.deepEqual(err.details?.paths, ['secrets.json']);
                return true;
            },
        );

        const lsRes = await h.runWithConsent('@STuser', ['ls-files']);
        assert.equal(lsRes.exitCode, 0);
        assert.equal(lsRes.stdout.trim(), '');

        await assert.rejects(
            () => h.runWithConsent('@STuser', ['add', '-A']),
            (err) => err.code === 'TG_SENSITIVE_PATH',
        );

        // Unstaging afterwards would leave the secret readable as a loose object.
        const objects = await h.runWithConsent('@STuser', ['count-objects', '-v']);
        assert.match(objects.stdout, /^count: 0$/m);

        // Files that are not sensitive still stage.
        await h.runWithConsent('@STuser', ['add', 'ok.txt']);
        const staged = await h.runWithConsent('@STuser', ['ls-files']);
        assert.equal(staged.stdout.trim(), 'ok.txt');
    });

    it('blocks push before network access when history contains a sensitive path', async () => {
        const h = createHarness();
        const userDir = path.join(h.fake.dataRoot, 'default-user');

        execFileSync('git', ['init', '-b', 'main', userDir]);
        execFileSync('git', ['-C', userDir, 'config', 'user.name', 'Direct']);
        execFileSync('git', ['-C', userDir, 'config', 'user.email', 'direct@example.com']);
        fs.writeFileSync(path.join(userDir, 'secrets.json'), '{"key":1}\n');
        execFileSync('git', ['-C', userDir, 'add', 'secrets.json']);
        execFileSync('git', ['-C', userDir, 'commit', '-m', 'Add secret']);

        await assert.rejects(
            () => h.runWithConsent('@STuser', ['push', 'https://127.0.0.1:9/x.git', 'main']),
            (err) => {
                assert.equal(err.code, 'TG_SENSITIVE_PATH');
                assert.deepEqual(err.details?.paths, ['secrets.json']);
                return true;
            },
        );

        // Same check for a configured remote (objects are compared against its tracking refs).
        execFileSync('git', ['-C', userDir, 'remote', 'add', 'origin', 'https://127.0.0.1:9/x.git']);
        await assert.rejects(
            () => h.runWithConsent('@STuser', ['push', 'origin', 'main']),
            (err) => err.code === 'TG_SENSITIVE_PATH',
        );
    });

    it('rejects .git gitfile layout with TG_UNSUPPORTED_REPO_LAYOUT', async () => {
        const h = createHarness();
        const chatsDir = path.join(h.fake.dataRoot, 'default-user', 'chats');
        fs.writeFileSync(path.join(chatsDir, '.git'), 'gitdir: /tmp/x\n');

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['status']),
            (err) => err.code === 'TG_UNSUPPORTED_REPO_LAYOUT',
        );
    });

    it('ignores host HOME ~/.gitconfig alias and core.pager', async () => {
        const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-'));
        cleanups.push(() => fs.rmSync(fakeHome, { recursive: true, force: true }));
        const pagerProof = path.join(fakeHome, 'pager-ran');
        fs.writeFileSync(
            path.join(fakeHome, '.gitconfig'),
            `[alias]\n\tst = status\n[core]\n\tpager = touch "${pagerProof}"\n`,
        );

        const h = createHarness({
            processEnv: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        });
        await h.runWithConsent('@STuser/chats', ['init']);
        fs.writeFileSync(path.join(h.fake.dataRoot, 'default-user', 'chats', 'a.txt'), '1\n');
        await h.runWithConsent('@STuser/chats', ['add', 'a.txt']);
        await h.runWithConsent('@STuser/chats', ['commit', '-m', 'First']);

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['st']),
            (err) => err.code === 'TG_FORBIDDEN_COMMAND',
        );

        const logRes = await h.runWithConsent('@STuser/chats', ['log']);
        assert.equal(logRes.exitCode, 0);
        assert.equal(fs.existsSync(pagerProof), false);
    });

    it('requires server console code for server-tier writes and resolves checkoutTarget ambiguity', async () => {
        const h = createHarness();
        // Create a server-tier repo inside plugins/sample-repo.
        const pluginRepo = path.join(h.fake.root, 'plugins', 'sample-repo');
        fs.mkdirSync(pluginRepo, { recursive: true });
        await h.runWithConsent('@STplugins/sample-repo', ['init']);

        fs.writeFileSync(path.join(pluginRepo, 'file.txt'), 'v1\n');
        await h.runWithConsent('@STplugins/sample-repo', ['add', 'file.txt']);
        await h.runWithConsent('@STplugins/sample-repo', ['commit', '-m', 'init']);

        // `checkout file.txt` is not a commit -> marked destructive with reason.
        await assert.rejects(
            () => h.executor.execute({ caller: h.caller, repo: '@STplugins/sample-repo', args: ['checkout', 'file.txt'] }, {}),
            (err) => {
                assert.equal(err.code, 'TG_CONSENT_REQUIRED');
                assert.equal(err.consent.needsConsoleCode, true);
                assert.equal(err.consent.destructive, true);
                assert.ok(err.consent.destructiveReasons.includes('checkout file.txt (discards changes)'));
                assert.deepEqual(err.consent.rememberable, []);
                return true;
            },
        );
    });

    it('blocks non-empty clone destination with TG_DEST_NOT_EMPTY', async () => {
        const h = createHarness();
        const dest = path.join(h.fake.dataRoot, 'default-user', 'chats');
        fs.writeFileSync(path.join(dest, 'existing.txt'), 'hi\n');

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['clone', 'https://127.0.0.1:9/repo.git']),
            (err) => err.code === 'TG_DEST_NOT_EMPTY',
        );
    });

    it('refuses repository paths inside a git directory for every mode', async () => {
        const h = createHarness();
        const userDir = path.join(h.fake.dataRoot, 'default-user');
        await h.runWithConsent('@STuser/chats', ['init']);
        await h.runWithConsent('@STuser/bare', ['init', '--bare']);

        const attempts = [
            ['@STuser/chats/.git', ['status']],
            ['@STuser/chats/.git', ['init']],
            ['@STuser/chats/.git/planted', ['init']],
            ['@STuser/chats/.git/planted', ['clone', 'https://127.0.0.1:9/repo.git']],
            ['@STuser/bare/planted', ['init']],
        ];
        for (const [repo, args] of attempts) {
            await assert.rejects(
                () => h.runWithConsent(repo, args),
                (err) => err.code === 'TG_UNSAFE_REPO_LAYOUT',
                `${repo} ${args[0]}`,
            );
        }
        assert.equal(fs.existsSync(path.join(userDir, 'chats', '.git', 'planted')), false);
        assert.equal(fs.existsSync(path.join(userDir, 'bare', 'planted')), false);

        // The bare repository itself stays usable.
        const bare = await h.runWithConsent('@STuser/bare', ['rev-parse', '--is-bare-repository']);
        assert.equal(bare.stdout.trim(), 'true');
    });

    it('refuses a bare-layout directory whose config does not set core.bare', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/bare', ['init', '--bare']);
        const config = path.join(h.fake.dataRoot, 'default-user', 'bare', 'config');
        execFileSync('git', ['config', '--file', config, 'core.bare', 'false']);

        await assert.rejects(
            () => h.runWithConsent('@STuser/bare', ['status']),
            (err) => err.code === 'TG_UNSUPPORTED_REPO_LAYOUT',
        );
    });

    it('rejects command-valued keys inside allowlisted config sections (gc.recentObjectsHook)', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);

        const repoDir = path.join(h.fake.dataRoot, 'default-user', 'chats');
        const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gchook-'));
        cleanups.push(() => fs.rmSync(proofDir, { recursive: true, force: true }));
        const proofFile = path.join(proofDir, 'hook-ran');
        execFileSync('git', ['config', '--file', path.join(repoDir, '.git', 'config'), 'gc.recentObjectsHook', `touch "${proofFile}"`]);

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['gc']),
            (err) => {
                assert.equal(err.code, 'TG_UNSAFE_REPO_CONFIG');
                assert.deepEqual(err.details?.keys, ['gc.recentobjectshook']);
                return true;
            },
        );
        assert.equal(fs.existsSync(proofFile), false);
    });

    it('rejects git directory entries that are symlinks leaving the root', { skip: process.platform === 'win32' }, async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outside-'));
        cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
        fs.symlinkSync(outside, path.join(h.fake.dataRoot, 'default-user', 'chats', '.git', 'linked'));

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['status']),
            (err) => err.code === 'TG_UNSAFE_REPO_LAYOUT',
        );
    });

    it('checks an existing .git before re-initializing', async () => {
        const h = createHarness();
        const chatsDir = path.join(h.fake.dataRoot, 'default-user', 'chats');
        fs.writeFileSync(path.join(chatsDir, '.git'), 'gitdir: /tmp/x\n');

        await assert.rejects(
            () => h.runWithConsent('@STuser/chats', ['init']),
            (err) => err.code === 'TG_UNSUPPORTED_REPO_LAYOUT',
        );
    });

    it('lets an approval lapse when the repository changed after the prompt', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);
        const config = path.join(h.fake.dataRoot, 'default-user', 'chats', '.git', 'config');
        execFileSync('git', ['config', '--file', config, 'remote.origin.url', 'https://shown.example/x.git']);

        const request = { caller: h.caller, repo: '@STuser/chats', args: ['fetch', 'origin'] };
        const prompt = await h.executor.execute(request, {}).catch((err) => err);
        assert.equal(prompt.code, 'TG_CONSENT_REQUIRED');
        assert.deepEqual(prompt.consent.hosts, ['shown.example']);

        execFileSync('git', ['config', '--file', config, 'remote.origin.url', 'https://other.example/x.git']);
        const { approvalId } = h.consent.decide({ requestId: prompt.consent.requestId, decision: 'allow' });

        await assert.rejects(
            () => h.executor.execute({ ...request, approvalId }, {}),
            (err) => err.code === 'TG_CONSENT_EXPIRED',
        );
    });

    it('treats every command in a partial clone as a network command towards its promisor remote', async () => {
        const h = createHarness();
        await h.runWithConsent('@STuser/chats', ['init']);
        const config = path.join(h.fake.dataRoot, 'default-user', 'chats', '.git', 'config');
        for (const [key, value] of [
            ['core.repositoryformatversion', '1'],
            ['extensions.partialclone', 'origin'],
            ['remote.origin.url', 'https://promisor.example/x.git'],
            ['remote.origin.promisor', 'true'],
        ]) {
            execFileSync('git', ['config', '--file', config, key, value]);
        }

        const prompt = await h.executor.execute({ caller: h.caller, repo: '@STuser/chats', args: ['status'] }, {}).catch((err) => err);
        assert.equal(prompt.code, 'TG_CONSENT_REQUIRED');
        assert.deepEqual(prompt.consent.classes, ['fetch', 'read']);
        assert.deepEqual(prompt.consent.hosts, ['promisor.example']);
    });

    it('commits with an identity containing "#" and ";" intact', async () => {
        const h = createHarness();
        h.identity.set({ name: 'A # B; C', email: 'a@example.com' });
        await h.runWithConsent('@STuser/chats', ['init']);
        await h.runWithConsent('@STuser/chats', ['commit', '--allow-empty', '-m', 'empty']);

        const logRes = await h.runWithConsent('@STuser/chats', ['log', '--format=%an <%ae>']);
        assert.equal(logRes.stdout.trim(), 'A # B; C <a@example.com>');
    });
});

describe('HTTP router integration', { skip: skipReason }, () => {
    it('mounts plugin routes, returns 409 consent on /exec, audits deny, and formats errors', async () => {
        const fake = makeFakeSt();
        cleanups.push(fake.cleanup);

        // Copy server-plugin into fake ST's plugins/taverngit so locateStRoot resolves fake.root.
        const srcPluginDir = path.resolve('server-plugin');
        fs.cpSync(srcPluginDir, fake.serverPluginDir, {
            recursive: true,
            filter: (src) => !src.includes(`${path.sep}state`) && !src.includes(`${path.sep}mingit`),
        });
        // On Windows the plugin only runs `<plugin>/mingit/cmd/git.exe`; link
        // the MinGit root that TAVERNGIT_TEST_GIT lives in.
        if (process.platform === 'win32') {
            const mingitLink = path.join(fake.serverPluginDir, 'mingit');
            fs.symlinkSync(path.dirname(path.dirname(process.env.TAVERNGIT_TEST_GIT)), mingitLink, 'junction');
            cleanups.push(() => fs.unlinkSync(mingitLink));
        }

        const pluginUrl = `${pathToFileURL(path.join(fake.serverPluginDir, 'index.mjs')).href}?t=${Date.now()}`;
        const plugin = await import(pluginUrl);
        const router = makeFakeRouter();
        await plugin.init(router);

        const prevDataRoot = globalThis.DATA_ROOT;
        globalThis.DATA_ROOT = fake.dataRoot;
        cleanups.push(() => {
            globalThis.DATA_ROOT = prevDataRoot;
        });

        // 1. GET /status works and reports git version.
        const statusRes = await router.dispatch('GET', '/status');
        assert.equal(statusRes.status, 200);
        assert.equal(statusRes.json.ok, true);
        assert.equal(statusRes.json.git.available, true);
        assert.equal(statusRes.json.dataRootInside, true);

        // 2. Non-admin user receives 403 TG_ADMIN_REQUIRED.
        const nonAdminRes = await router.dispatch('GET', '/status', {
            user: { profile: { handle: 'alice', admin: false } },
        });
        assert.equal(nonAdminRes.status, 403);
        assert.deepEqual(nonAdminRes.json.ok, false);
        assert.equal(nonAdminRes.json.error.code, 'TG_ADMIN_REQUIRED');

        // 3. POST /exec without consent returns 409 with `consent` payload (using stream body for ST 1.11 compat).
        const execPayload = JSON.stringify({
            caller: { id: 'ui-caller', name: 'UI Caller', origin: 'ui-caller' },
            repo: '@STuser/chats',
            args: ['init'],
        });
        const consentRequiredRes = await router.dispatch('POST', '/exec', { rawBody: execPayload });
        assert.equal(consentRequiredRes.status, 409);
        assert.equal(consentRequiredRes.json.ok, false);
        assert.equal(consentRequiredRes.json.error.code, 'TG_CONSENT_REQUIRED');
        assert.ok(consentRequiredRes.json.consent?.requestId);
        assert.deepEqual(consentRequiredRes.json.consent.classes, ['write']);

        // 4. Denying via POST /consent returns 403 TG_CONSENT_DENIED and records an audit entry.
        const denyRes = await router.dispatch('POST', '/consent', {
            body: { requestId: consentRequiredRes.json.consent.requestId, decision: 'deny', remember: false },
        });
        assert.equal(denyRes.status, 403);
        assert.equal(denyRes.json.ok, false);
        assert.equal(denyRes.json.error.code, 'TG_CONSENT_DENIED');

        const auditRes = await router.dispatch('GET', '/audit', { query: { limit: '10' } });
        assert.equal(auditRes.status, 200);
        assert.equal(auditRes.json.ok, true);
        assert.equal(auditRes.json.entries[0].decision, 'denied');
        assert.equal(auditRes.json.entries[0].errorCode, 'TG_CONSENT_DENIED');

        // 5. Re-request, allow via POST /consent, and execute with approvalId.
        const secondPrompt = await router.dispatch('POST', '/exec', { rawBody: execPayload });
        assert.equal(secondPrompt.status, 409);

        const allowRes = await router.dispatch('POST', '/consent', {
            body: { requestId: secondPrompt.json.consent.requestId, decision: 'allow', remember: false },
        });
        assert.equal(allowRes.status, 200);
        assert.equal(allowRes.json.ok, true);
        assert.ok(allowRes.json.approvalId);

        const execOkRes = await router.dispatch('POST', '/exec', {
            body: {
                caller: { id: 'ui-caller', name: 'UI Caller', origin: 'ui-caller' },
                repo: '@STuser/chats',
                args: ['init'],
                approvalId: allowRes.json.approvalId,
            },
        });
        assert.equal(execOkRes.status, 200);
        assert.equal(execOkRes.json.ok, true);
        assert.equal(execOkRes.json.exitCode, 0);

        plugin.exit();
    });

    it('registers only GET /status returning 503 TG_BAD_INSTALL_LOCATION when outside ST root', async () => {
        const plugin = await import('../../server-plugin/index.mjs');
        const router = makeFakeRouter();
        await plugin.init(router);

        const statusRes = await router.dispatch('GET', '/status');
        assert.equal(statusRes.status, 503);
        assert.equal(statusRes.json.ok, false);
        assert.equal(statusRes.json.error.code, 'TG_BAD_INSTALL_LOCATION');
    });
});
