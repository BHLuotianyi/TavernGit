import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    WRITABLE_CONFIG,
    analyzeCommand,
    configKeyAllowed,
    looksLikeUrl,
    validateUrl,
} from '../../server-plugin/lib/policy.mjs';

function assertFails(args, code) {
    assert.throws(
        () => analyzeCommand(args),
        (err) => err && err.code === code,
        `expected ${JSON.stringify(args)} to fail with ${code}`,
    );
}

describe('policy', () => {
    describe('allowlist table (every subcommand and sub-subcommand)', () => {
        const cases = [
            // Read-only inspection
            { args: ['status', '-sb', '--porcelain=v2', '-uall'], classes: ['read'] },
            { args: ['log', '--oneline', '-n', '10', '--format=%H %s'], classes: ['read'] },
            { args: ['show', '--stat', 'HEAD'], classes: ['read'] },
            { args: ['diff', '--cached', '--stat', '-U3'], classes: ['read'] },
            { args: ['ls-files', '-z', '--cached'], classes: ['read'] },
            { args: ['ls-tree', '-r', '--name-only', 'HEAD'], classes: ['read'] },
            { args: ['rev-parse', '--verify', '-q', '--short=8', 'HEAD'], classes: ['read'] },
            { args: ['rev-list', '--count', '-n5', 'HEAD'], classes: ['read'] },
            { args: ['merge-base', '--is-ancestor', 'HEAD~1', 'HEAD'], classes: ['read'] },
            { args: ['describe', '--tags', '--always'], classes: ['read'] },
            { args: ['cat-file', '-p', 'HEAD'], classes: ['read'] },
            { args: ['blame', '-L', '1,5', 'README.md'], classes: ['read'] },
            { args: ['shortlog', '-sn', '--group=author'], classes: ['read'] },
            { args: ['grep', '-n', '-i', '-e', 'pattern', '--', 'src'], classes: ['read'] },
            { args: ['check-ignore', '-v', 'foo'], classes: ['read'] },
            { args: ['check-attr', '-a', '--', 'foo'], classes: ['read'] },
            { args: ['count-objects', '-vH'], classes: ['read'] },

            // branch
            { args: ['branch'], classes: ['read'] },
            { args: ['branch', '-vv', '--all'], classes: ['read'] },
            { args: ['branch', '--list', 'feat/*'], classes: ['read'] },
            { args: ['branch', 'topic'], classes: ['write'] },
            { args: ['branch', '-d', 'topic'], classes: ['write'] },
            { args: ['branch', '-D', 'topic'], classes: ['write'], destructive: true },
            { args: ['branch', '--delete', '--force', 'topic'], classes: ['write'], destructive: true },
            { args: ['branch', '-M', 'old', 'new'], classes: ['write'], destructive: true },
            { args: ['branch', '-C', 'a', 'b'], classes: ['write'], destructive: true },

            // tag
            { args: ['tag'], classes: ['read'] },
            { args: ['tag', '-l', 'v*'], classes: ['read'] },
            { args: ['tag', '-n5'], classes: ['read'] },
            { args: ['tag', '-a', 'v1.0.0', '-m', 'release'], classes: ['write'] },
            { args: ['tag', '-d', 'v1.0.0'], classes: ['write'], destructive: true },
            { args: ['tag', '-f', 'v1.0.0'], classes: ['write'], destructive: true },

            // remote sub-subcommands
            { args: ['remote'], classes: ['read'] },
            { args: ['remote', '-v'], classes: ['read'] },
            { args: ['remote', 'get-url', '--all', 'origin'], classes: ['read'] },
            { args: ['remote', 'show', '-n', 'origin'], classes: ['read'] },
            { args: ['remote', 'add', 'upstream', 'https://github.com/a/b.git'], classes: ['write'] },
            { args: ['remote', 'add', '-f', 'upstream', 'https://github.com/a/b.git'], classes: ['fetch', 'write'] },
            { args: ['remote', 'rename', 'upstream', 'up'], classes: ['write'] },
            { args: ['remote', 'remove', 'up'], classes: ['write'], destructive: true },
            { args: ['remote', 'rm', 'up'], classes: ['write'], destructive: true },
            { args: ['remote', 'set-head', 'origin', 'main'], classes: ['write'] },
            { args: ['remote', 'set-head', 'origin', '-a'], classes: ['fetch', 'write'] },
            { args: ['remote', 'set-branches', '--add', 'origin', 'dev'], classes: ['write'] },
            { args: ['remote', 'set-url', 'origin', 'https://github.com/a/c.git'], classes: ['write'] },
            { args: ['remote', 'set-url', '--delete', 'origin', 'https://old/.*'], classes: ['write'] },
            { args: ['remote', 'prune', '-n', 'origin'], classes: ['fetch', 'write'] },
            { args: ['remote', 'update'], classes: ['fetch'] },
            { args: ['remote', 'update', '-p', 'origin'], classes: ['fetch'] },

            // reflog sub-subcommands
            { args: ['reflog', '--oneline', '-n', '5'], classes: ['read'] },
            { args: ['reflog', 'show', 'HEAD'], classes: ['read'] },
            { args: ['reflog', 'exists', 'HEAD'], classes: ['read'] },

            // stash sub-subcommands
            { args: ['stash'], classes: ['write'] },
            { args: ['stash', '-u', '-m', 'wip'], classes: ['write'] },
            { args: ['stash', 'push', '--staged', '--', 'a.txt'], classes: ['write'] },
            { args: ['stash', 'list'], classes: ['read'] },
            { args: ['stash', 'show', '-p', 'stash@{0}'], classes: ['read'] },
            { args: ['stash', 'apply', '--index'], classes: ['write'] },
            { args: ['stash', 'pop'], classes: ['write'] },
            { args: ['stash', 'branch', 'saved', 'stash@{0}'], classes: ['write'] },
            { args: ['stash', 'drop', 'stash@{0}'], classes: ['write'], destructive: true },
            { args: ['stash', 'clear'], classes: ['write'], destructive: true },

            // config
            { args: ['config', '--list'], classes: ['read'] },
            { args: ['config', '--get', 'user.name'], classes: ['read'] },
            { args: ['config', 'user.name'], classes: ['read'] },
            { args: ['config', 'user.name', 'Alice'], classes: ['write'] },
            { args: ['config', '--unset', 'user.name'], classes: ['write'] },
            { args: ['config', 'remote.origin.url', 'https://github.com/a/b.git'], classes: ['write'] },

            // clean, init, add, rm, mv, commit
            { args: ['clean', '-n'], classes: ['read'] },
            { args: ['clean', '-fd'], classes: ['write'], destructive: true },
            { args: ['init', '-b', 'main', '--object-format=sha256'], classes: ['write'] },
            { args: ['add', '-A', '--chmod=+x', '--', 'run.sh'], classes: ['write'] },
            { args: ['rm', '--cached', 'secret.txt'], classes: ['write'] },
            { args: ['rm', '-n', 'file.txt'], classes: ['write'] },
            { args: ['rm', 'file.txt'], classes: ['write'], destructive: true },
            { args: ['mv', 'a.txt', 'b.txt'], classes: ['write'] },
            { args: ['mv', '-f', 'a.txt', 'b.txt'], classes: ['write'], destructive: true },
            { args: ['commit', '-m', 'init', '-m', 'body'], classes: ['write'] },

            // checkout, switch, restore, reset
            { args: ['checkout', 'main'], classes: ['write'] },
            { args: ['checkout', '-b', 'feat', 'main'], classes: ['write'] },
            { args: ['checkout', '-f', 'main'], classes: ['write'], destructive: true },
            { args: ['checkout', '--', '-rf'], classes: ['write'], destructive: true },
            { args: ['checkout', 'HEAD', 'file.txt'], classes: ['write'], destructive: true },
            { args: ['switch', 'main'], classes: ['write'] },
            { args: ['switch', '-C', 'main'], classes: ['write'], destructive: true },
            { args: ['switch', '--discard-changes', 'main'], classes: ['write'], destructive: true },
            { args: ['restore', '--staged', 'file.txt'], classes: ['write'] },
            { args: ['restore', 'file.txt'], classes: ['write'], destructive: true },
            { args: ['restore', '-S', '-W', 'file.txt'], classes: ['write'], destructive: true },
            { args: ['reset', '--soft', 'HEAD~1'], classes: ['write'] },
            { args: ['reset', '--hard'], classes: ['write'], destructive: true },
            { args: ['reset', '--merge'], classes: ['write'], destructive: true },

            // merge, rebase, cherry-pick, revert, apply, gc
            { args: ['merge', '--no-ff', '-s', 'ort', 'topic'], classes: ['write'] },
            { args: ['rebase', '--onto', 'main', '--autostash', 'topic'], classes: ['write'] },
            { args: ['cherry-pick', '-n', '-m', '1', 'abc123'], classes: ['write'] },
            { args: ['revert', '--no-commit', 'abc123'], classes: ['write'] },
            { args: ['apply', '--3way'], classes: ['write'] },
            { args: ['apply', '--check'], classes: ['read'] },
            { args: ['apply', '--stat'], classes: ['read'] },
            { args: ['apply', '--numstat'], classes: ['read'] },
            { args: ['apply', '--summary'], classes: ['read'] },
            { args: ['gc', '--auto'], classes: ['write'] },
            { args: ['gc', '--prune=now'], classes: ['write'], destructive: true },

            // network
            { args: ['clone', '--depth', '1', '--filter=blob:none', 'https://github.com/a/b.git'], classes: ['fetch', 'write'] },
            { args: ['fetch'], classes: ['fetch'] },
            { args: ['fetch', '--all', '--prune'], classes: ['fetch'] },
            { args: ['fetch', '-f', 'origin'], classes: ['fetch'], destructive: true },
            { args: ['fetch', '-P', 'origin'], classes: ['fetch'], destructive: true },
            { args: ['fetch', 'origin', '+a:b'], classes: ['fetch'], destructive: true },
            { args: ['pull', 'origin', 'main'], classes: ['fetch', 'write'] },
            { args: ['pull', '--rebase=merges'], classes: ['fetch', 'write'] },
            { args: ['push', 'origin', 'main'], classes: ['push'] },
            { args: ['push', '--force', 'origin', 'main'], classes: ['push'], destructive: true },
            { args: ['push', '--force-with-lease', 'origin', 'main'], classes: ['push'], destructive: true },
            { args: ['push', '-d', 'origin', 'topic'], classes: ['push'], destructive: true },
            { args: ['push', 'origin', ':topic'], classes: ['push'], destructive: true },
            { args: ['push', 'origin', '+main:main'], classes: ['push'], destructive: true },
            { args: ['ls-remote'], classes: ['fetch'] },
            { args: ['ls-remote', '--heads', 'https://github.com/a/b.git'], classes: ['fetch'] },
        ];

        for (const testCase of cases) {
            it(`allows ${testCase.args.join(' ')}`, () => {
                const res = analyzeCommand(testCase.args);
                assert.deepEqual([...res.classes].sort(), [...testCase.classes].sort());
                assert.equal(res.destructive, Boolean(testCase.destructive));
            });
        }
    });

    describe('forbidden inputs', () => {
        const forbiddenCases = [
            [['-c', 'core.fsmonitor=x', 'status'], 'TG_FORBIDDEN_COMMAND'],
            [['log', '--output=/tmp/x'], 'TG_FORBIDDEN_OPTION'],
            [['grep', '-Ocat', 'x'], 'TG_FORBIDDEN_OPTION'],
            [['diff', '--no-index', 'a', 'b'], 'TG_FORBIDDEN_OPTION'],
            [['rebase', '-i', 'HEAD~2'], 'TG_FORBIDDEN_OPTION'],
            [['clone', '--recurse-submodules', 'https://x/y'], 'TG_FORBIDDEN_OPTION'],
            [['clone', 'ssh://x/y'], 'TG_FORBIDDEN_URL'],
            [['clone', 'https://u:p@x/y'], 'TG_FORBIDDEN_URL'],
            [['config', '--global', 'user.name', 'x'], 'TG_FORBIDDEN_OPTION'],
            [['config', 'core.fsmonitor', 'x'], 'TG_FORBIDDEN_ARGUMENT'],
            [['fetch', '--upload-pack=x'], 'TG_FORBIDDEN_OPTION'],
            [['log', '--format=%>(999999999)%s'], 'TG_INVALID_ARGUMENT'],
            [['push'], 'TG_PUSH_REMOTE_REQUIRED'],
            [['push', 'origin', 'stash:refs/heads/x'], 'TG_FORBIDDEN_ARGUMENT'],
        ];

        for (const [args, code] of forbiddenCases) {
            it(`rejects ${JSON.stringify(args)} with ${code}`, () => {
                assertFails(args, code);
            });
        }
    });

    describe('option values cannot smuggle options past the allowlist', () => {
        // git reads the value of these options as optional, so a separate
        // token after them is parsed by git as an option of its own.
        const smuggled = [
            ['log', '--pretty', '--output=/tmp/x'],
            ['log', '--format', '--output=/tmp/x'],
            ['show', '--pretty', '--output=/tmp/x'],
            ['reflog', 'show', '--format', '--output=/tmp/x'],
            ['log', '-U', '--output=/tmp/x'],
            ['gc', '--prune', '--keep-largest-pack'],
        ];
        for (const args of smuggled) {
            it(`rejects ${JSON.stringify(args)}`, () => {
                assertFails(args, 'TG_FORBIDDEN_OPTION');
            });
        }

        it('accepts a value that starts with "-" only when attached', () => {
            assertFails(['commit', '-m', '--amend'], 'TG_INVALID_ARGUMENT');
            assertFails(['log', '--grep', '-x'], 'TG_INVALID_ARGUMENT');
            assert.deepEqual(analyzeCommand(['commit', '--message=-wip']).argv, ['commit', '--message=-wip']);
            assert.deepEqual(analyzeCommand(['commit', '-m-wip']).argv, ['commit', '-m-wip']);
        });

        it('rejects push refspec sources that rev-list would read as options', () => {
            assertFails(['push', 'origin', '+--all:refs/heads/x'], 'TG_INVALID_ARGUMENT');
            assertFails(['push', 'origin', '+--output=x:refs/heads/x'], 'TG_INVALID_ARGUMENT');
        });

        it('rejects non-string arguments anywhere in args', () => {
            assertFails(['stash', 5], 'TG_BAD_REQUEST');
            assertFails(['log', '-n', 5], 'TG_BAD_REQUEST');
            assertFails(['commit', '-m', ['x']], 'TG_BAD_REQUEST');
        });

        it('accepts only literal https:// URLs', () => {
            assertFails(['clone', 'https:example.com/a.git'], 'TG_FORBIDDEN_URL');
            assertFails(['clone', 'HTTPS://example.com/a.git'], 'TG_FORBIDDEN_URL');
            assertFails(['remote', 'add', 'o', 'https:/example.com/a.git'], 'TG_FORBIDDEN_URL');
        });
    });

    describe('extra boundary checks and metadata', () => {
        it('rejects operands that escape the repo', () => {
            assertFails(['diff', '/etc/passwd', 'x'], 'TG_FORBIDDEN_ARGUMENT');
            assertFails(['diff', '--', '../outside'], 'TG_FORBIDDEN_ARGUMENT');
            assertFails(['add', 'C:\\Windows\\win.ini'], 'TG_FORBIDDEN_ARGUMENT');
        });

        it('enforces forbidden options and sub-subcommands', () => {
            assertFails(['grep', '-f', 'x'], 'TG_FORBIDDEN_OPTION');
            assertFails(['grep', '--untracked', 'x'], 'TG_FORBIDDEN_OPTION');
            assertFails(['grep', '--no-index', 'x'], 'TG_FORBIDDEN_OPTION');
            assertFails(['tag', '-s', 'x'], 'TG_FORBIDDEN_OPTION');
            assertFails(['tag', '-u', 'k', 'x'], 'TG_FORBIDDEN_OPTION');
            assertFails(['tag', '-F', 'file', 'x'], 'TG_FORBIDDEN_OPTION');
            assertFails(['clean', '-i'], 'TG_FORBIDDEN_OPTION');
            assertFails(['rebase', '-x', 'sh', 'main'], 'TG_FORBIDDEN_OPTION');
            assertFails(['cherry-pick', '-e', 'HEAD'], 'TG_FORBIDDEN_OPTION');
            assertFails(['revert', '-S', 'HEAD'], 'TG_FORBIDDEN_OPTION');
            assertFails(['apply', '--directory=sub'], 'TG_FORBIDDEN_OPTION');
            assertFails(['apply', '--unsafe-paths'], 'TG_FORBIDDEN_OPTION');
            assertFails(['apply', '--reject'], 'TG_FORBIDDEN_OPTION');
            assertFails(['fetch', '--update-head-ok'], 'TG_FORBIDDEN_OPTION');
            assertFails(['fetch', '--recurse-submodules'], 'TG_FORBIDDEN_OPTION');
            assertFails(['push', '--receive-pack=x', 'origin'], 'TG_FORBIDDEN_OPTION');
            assertFails(['push', '--exec=x', 'origin'], 'TG_FORBIDDEN_OPTION');
            assertFails(['push', '--repo=x', 'origin'], 'TG_FORBIDDEN_OPTION');
            assertFails(['push', '--signed', 'origin'], 'TG_FORBIDDEN_OPTION');
            assertFails(['push', '--recurse-submodules=on-demand', 'origin'], 'TG_FORBIDDEN_OPTION');
            assertFails(['stash', 'save'], 'TG_FORBIDDEN_COMMAND');
            assertFails(['stash', 'create'], 'TG_FORBIDDEN_COMMAND');
            assertFails(['stash', 'store', 'abc'], 'TG_FORBIDDEN_COMMAND');
            assertFails(['stash', '-a'], 'TG_FORBIDDEN_OPTION');
            assertFails(['stash', 'push', '-p'], 'TG_FORBIDDEN_OPTION');
            assertFails(['reflog', 'expire'], 'TG_FORBIDDEN_COMMAND');
            assertFails(['remote', 'show', 'origin'], 'TG_FORBIDDEN_ARGUMENT');
            assertFails(['config', '--system', 'user.name'], 'TG_FORBIDDEN_OPTION');
            assertFails(['config', '--file=x', 'user.name'], 'TG_FORBIDDEN_OPTION');
            assertFails(['config', 'get', 'user.name'], 'TG_FORBIDDEN_ARGUMENT');
            assertFails(['config', 'set', 'user.name', 'x'], 'TG_FORBIDDEN_ARGUMENT');
            assertFails(['push', 'origin', 'refs/stash:main'], 'TG_FORBIDDEN_ARGUMENT');
        });

        it('validates remote URLs in config writes', () => {
            assertFails(['config', 'remote.o.url', 'ssh://x'], 'TG_FORBIDDEN_URL');
            assertFails(['config', 'remote.o.pushurl', 'https://u:p@x/y'], 'TG_FORBIDDEN_URL');
        });

        it('sets requiresInput and appends "-" for apply', () => {
            const check = analyzeCommand(['apply', '--check']);
            assert.deepEqual([...check.classes], ['read']);
            assert.equal(check.requiresInput, true);
            assert.deepEqual(check.argv, ['apply', '--check', '-']);

            const writeApply = analyzeCommand(['apply']);
            assert.deepEqual([...writeApply.classes], ['write']);
            assert.equal(writeApply.requiresInput, true);
            assert.equal(writeApply.needsSensitivePostCheck, 'unstage');
            assert.deepEqual(writeApply.argv, ['apply', '-']);
        });

        it('injects safety flags into argv for log, show, diff, blame, and config', () => {
            assert.deepEqual(
                analyzeCommand(['log', '-n', '5']).argv,
                ['log', '--no-ext-diff', '--no-textconv', '-n', '5'],
            );
            assert.deepEqual(
                analyzeCommand(['show', 'HEAD']).argv,
                ['show', '--no-ext-diff', '--no-textconv', 'HEAD'],
            );
            assert.deepEqual(
                analyzeCommand(['diff', '--cached']).argv,
                ['diff', '--no-ext-diff', '--no-textconv', '--cached'],
            );
            assert.deepEqual(
                analyzeCommand(['blame', 'a.txt']).argv,
                ['blame', '--no-textconv', 'a.txt'],
            );
            assert.deepEqual(
                analyzeCommand(['config', 'user.name', 'Alice']).argv,
                ['config', '--local', 'user.name', 'Alice'],
            );
            assert.deepEqual(
                analyzeCommand(['config', '--local', '--get', 'user.name']).argv,
                ['config', '--local', '--get', 'user.name'],
            );
        });

        it('sets checkoutTarget, network.implicit, sensitive check flags, and clone metadata', () => {
            const co = analyzeCommand(['checkout', 'main']);
            assert.equal(co.checkoutTarget, 'main');
            assert.equal(co.destructive, false);

            const coPaths = analyzeCommand(['checkout', '--', '-rf']);
            assert.equal(coPaths.checkoutTarget, null);
            assert.equal(coPaths.destructive, true);

            const fDefault = analyzeCommand(['fetch']);
            assert.equal(fDefault.network.implicit, 'default');

            const fAll = analyzeCommand(['fetch', '--all']);
            assert.equal(fAll.network.implicit, 'all');

            const stashU = analyzeCommand(['stash', '-u']);
            assert.equal(stashU.needsUntrackedPreCheck, true);

            const merge = analyzeCommand(['merge', 'topic']);
            assert.equal(merge.needsSensitivePreCheck, true);
            assert.equal(merge.needsSensitivePostCheck, 'warn');

            const clone = analyzeCommand(['clone', 'https://github.com/a/b.git']);
            assert.equal(clone.mode, 'clone');
            assert.equal(clone.cloneUrl, 'https://github.com/a/b.git');
            assert.deepEqual(clone.network.urls, ['https://github.com/a/b.git']);

            const init = analyzeCommand(['init']);
            assert.equal(init.mode, 'init');

            // Options are kept wherever they stand relative to the URL.
            const cloneLate = analyzeCommand(['clone', '-b', 'main', 'https://github.com/a/b.git', '--depth', '1']);
            assert.deepEqual(cloneLate.cloneOptions, ['-b', 'main', '--depth', '1']);

            assert.deepEqual(
                analyzeCommand(['stash', 'show', '-p']).argv,
                ['stash', 'show', '--no-ext-diff', '--no-textconv', '-p'],
            );

            assert.equal(analyzeCommand(['add', '-u']).addPreCheck, null);
            assert.deepEqual(
                analyzeCommand(['add', '-f', 'a', '--', 'b']).addPreCheck,
                { pathspecs: ['a', 'b'], all: false, includeIgnored: true },
            );
        });

        it('exposes URL and config key helpers', () => {
            assert.equal(validateUrl('https://GitHub.com:443/a/b.git'), 'github.com');
            assert.equal(validateUrl('https://example.com:8443/repo.git'), 'example.com:8443');
            assert.equal(looksLikeUrl('https://x/y'), true);
            assert.equal(looksLikeUrl('origin'), false);
            assert.equal(configKeyAllowed('User.Name', WRITABLE_CONFIG), true);
            assert.equal(configKeyAllowed('core.fsmonitor', WRITABLE_CONFIG), false);
        });
    });
});
