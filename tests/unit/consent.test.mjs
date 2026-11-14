import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createConsentManager } from '../../server-plugin/lib/consent.mjs';

const tempDirs = [];

function makeStateDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-consent-'));
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

describe('consent', () => {
    it('covers read in granted zone only and persists grants across manager instances', () => {
        const stateDir = makeStateDir();
        let clock = 1_000_000;
        const manager = createConsentManager({ stateDir, now: () => clock });
        const caller = { id: 'ext-a', name: 'Ext A', origin: 'ext-a' };
        const cKey = manager.callerKey(caller);
        assert.equal(cKey, 'ext-a|ext-a');
        assert.equal(manager.callerKey({ id: 'ext-b', origin: null }), 'ext-b|unknown');

        const rememberable = manager.rememberableFor({
            classes: ['read'],
            destructive: false,
            tier: 'data',
            zone: 'STuser',
            hosts: [],
        });
        assert.deepEqual(rememberable, [{ cls: 'read', zone: 'STuser' }]);

        const hash = manager.requestHash({
            callerKey: cKey,
            repoReal: '/st/data/default-user/chats',
            argv: ['status'],
            input: undefined,
            binary: false,
        });
        const requestId = manager.createPending(
            {
                caller,
                callerKey: cKey,
                repo: { display: '@ST/data/default-user/chats', alias: '@STuser/chats', tier: 'data', zone: 'STuser' },
                argv: ['status'],
                needsConsoleCode: false,
                rememberable,
            },
            hash,
        );

        const { approvalId } = manager.decide({ requestId, decision: 'allow', remember: true });
        assert.ok(approvalId);
        assert.equal(manager.consumeApproval(approvalId, hash), true);

        // Same zone is covered; sibling zone is not.
        assert.equal(manager.isCovered({ classes: ['read'], destructive: false, tier: 'data', zone: 'STuser' }, cKey), true);
        assert.equal(manager.isCovered({ classes: ['read'], destructive: false, tier: 'data', zone: 'STdata' }, cKey), false);
        assert.equal(manager.isCovered({ classes: ['write'], destructive: false, tier: 'data', zone: 'STuser' }, cKey), false);

        // Survives a fresh manager instance on the same stateDir.
        const reloaded = createConsentManager({ stateDir, now: () => clock });
        assert.equal(reloaded.isCovered({ classes: ['read'], destructive: false, tier: 'data', zone: 'STuser' }, cKey), true);
        const grants = reloaded.listGrants();
        assert.equal(grants.length, 1);
        assert.equal(grants[0].zone, 'STuser');
        assert.equal(reloaded.removeGrant(grants[0].id), true);
        assert.equal(reloaded.removeGrant('missing-id'), false);
        assert.equal(reloaded.isCovered({ classes: ['read'], destructive: false, tier: 'data', zone: 'STuser' }, cKey), false);

        const rawGrants = JSON.parse(fs.readFileSync(path.join(stateDir, 'grants.json'), 'utf8'));
        assert.equal(rawGrants.version, 1);
    });

    it('never covers or remembers destructive requests or server-tier writes', () => {
        const stateDir = makeStateDir();
        const manager = createConsentManager({ stateDir });
        const caller = { id: 'ext-a', name: 'Ext A', origin: 'ext-a' };
        const cKey = manager.callerKey(caller);

        assert.deepEqual(
            manager.rememberableFor({ classes: ['write'], destructive: true, tier: 'data', zone: 'STuser' }),
            [],
        );
        assert.deepEqual(
            manager.rememberableFor({ classes: ['write'], destructive: false, tier: 'server', zone: 'ST' }),
            [],
        );
        assert.deepEqual(
            manager.rememberableFor({ classes: ['read'], destructive: false, tier: 'server', zone: 'ST' }),
            [{ cls: 'read', zone: 'ST' }],
        );

        // Even if grants exist for write in STuser and ST, destructive and server-tier non-read are never covered.
        const req1 = manager.createPending(
            {
                caller,
                repo: { display: '@ST/data/default-user/chats' },
                argv: ['commit', '-m', 'x'],
                needsConsoleCode: false,
                rememberable: [{ cls: 'write', zone: 'STuser' }],
            },
            'hash-1',
        );
        manager.decide({ requestId: req1, decision: 'allow', remember: true });

        assert.equal(manager.isCovered({ classes: ['write'], destructive: false, tier: 'data', zone: 'STuser' }, cKey), true);
        assert.equal(manager.isCovered({ classes: ['write'], destructive: true, tier: 'data', zone: 'STuser' }, cKey), false);
        assert.equal(manager.isCovered({ classes: ['write'], destructive: false, tier: 'server', zone: 'ST' }, cKey), false);
        assert.equal(manager.clearGrants(), 1);
        assert.equal(manager.listGrants().length, 0);
    });

    it('enforces single-use approvals, hash binding, and 120 s expiry', () => {
        const stateDir = makeStateDir();
        let clock = 10_000;
        const manager = createConsentManager({ stateDir, now: () => clock });
        const caller = { id: 'ext-a', name: 'Ext A', origin: 'ext-a' };
        const cKey = manager.callerKey(caller);

        const hashA = manager.requestHash({
            callerKey: cKey,
            repoReal: '/st/data/default-user/chats',
            argv: ['status'],
            input: undefined,
            binary: false,
        });
        const hashB = manager.requestHash({
            callerKey: cKey,
            repoReal: '/st/data/default-user/chats',
            argv: ['log'],
            input: undefined,
            binary: false,
        });
        assert.notEqual(hashA, hashB);

        // Mismatched hash rejects and invalidates the approval.
        const req1 = manager.createPending(
            { caller, repo: { display: '@STuser/chats' }, argv: ['status'], needsConsoleCode: false, rememberable: [] },
            hashA,
        );
        const { approvalId: id1 } = manager.decide({ requestId: req1, decision: 'allow', remember: false });
        assert.equal(errorCode(() => manager.consumeApproval(id1, hashB)), 'TG_CONSENT_EXPIRED');
        assert.equal(errorCode(() => manager.consumeApproval(id1, hashA)), 'TG_CONSENT_EXPIRED');

        // Reuse rejects.
        const req2 = manager.createPending(
            { caller, repo: { display: '@STuser/chats' }, argv: ['status'], needsConsoleCode: false, rememberable: [] },
            hashA,
        );
        const { approvalId: id2 } = manager.decide({ requestId: req2, decision: 'allow', remember: false });
        assert.equal(manager.consumeApproval(id2, hashA), true);
        assert.equal(errorCode(() => manager.consumeApproval(id2, hashA)), 'TG_CONSENT_EXPIRED');

        // Expires after 120 s.
        const req3 = manager.createPending(
            { caller, repo: { display: '@STuser/chats' }, argv: ['status'], needsConsoleCode: false, rememberable: [] },
            hashA,
        );
        const { approvalId: id3 } = manager.decide({ requestId: req3, decision: 'allow', remember: false });
        clock += 119_999;
        // Still valid before 120 s; check expiry at 120 s on a fresh one.
        const req4 = manager.createPending(
            { caller, repo: { display: '@STuser/chats' }, argv: ['status'], needsConsoleCode: false, rememberable: [] },
            hashA,
        );
        const { approvalId: id4 } = manager.decide({ requestId: req4, decision: 'allow', remember: false });
        assert.equal(manager.consumeApproval(id3, hashA), true);
        clock += 120_000;
        assert.equal(errorCode(() => manager.consumeApproval(id4, hashA)), 'TG_CONSENT_EXPIRED');
    });

    it('requires a valid 6-digit console code and deletes the request after three failures', () => {
        const stateDir = makeStateDir();
        const logs = [];
        const manager = createConsentManager({ stateDir, log: (msg) => logs.push(msg) });
        const caller = { id: 'ext-a', name: 'Ext A', origin: 'ext-a' };
        const hash = manager.requestHash({
            callerKey: manager.callerKey(caller),
            repoReal: '/st',
            argv: ['branch', 'tg-test'],
            input: undefined,
            binary: false,
        });

        const req1 = manager.createPending(
            { caller, repo: { display: '@ST' }, argv: ['branch', 'tg-test'], needsConsoleCode: true, rememberable: [] },
            hash,
        );
        assert.equal(logs.length, 1);
        const match = /:\s*(\d{6})$/.exec(logs[0]);
        assert.ok(match, `expected 6-digit code in log: ${logs[0]}`);
        const code1 = match[1];
        assert.equal(JSON.stringify(manager.getPending(req1)).includes(code1), false);

        const wrongCode = code1 === '000000' ? '111111' : '000000';
        assert.equal(
            errorCode(() => manager.decide({ requestId: req1, decision: 'allow', remember: false, consoleCode: wrongCode })),
            'TG_CONSOLE_CODE_INVALID',
        );
        assert.equal(
            errorCode(() => manager.decide({ requestId: req1, decision: 'allow', remember: false, consoleCode: wrongCode })),
            'TG_CONSOLE_CODE_INVALID',
        );
        assert.equal(
            errorCode(() => manager.decide({ requestId: req1, decision: 'allow', remember: false, consoleCode: wrongCode })),
            'TG_CONSOLE_CODE_INVALID',
        );
        // Third wrong attempt removed the pending request, so even the right code now sees TG_CONSENT_EXPIRED.
        assert.equal(manager.getPending(req1), null);
        assert.equal(
            errorCode(() => manager.decide({ requestId: req1, decision: 'allow', remember: false, consoleCode: code1 })),
            'TG_CONSENT_EXPIRED',
        );

        // Correct code succeeds.
        const req2 = manager.createPending(
            { caller, repo: { display: '@ST' }, argv: ['branch', 'tg-test'], needsConsoleCode: true, rememberable: [] },
            hash,
        );
        const code2 = /:\s*(\d{6})$/.exec(logs[1])[1];
        const { approvalId } = manager.decide({ requestId: req2, decision: 'allow', remember: false, consoleCode: code2 });
        assert.equal(manager.consumeApproval(approvalId, hash), true);
    });

    it('locks console-code approvals after repeated failures across requests', () => {
        const stateDir = makeStateDir();
        const logs = [];
        let clock = 1_000_000;
        const manager = createConsentManager({ stateDir, log: (msg) => logs.push(msg), now: () => clock });
        const caller = { id: 'ext-a', name: 'Ext A', origin: 'ext-a' };
        const summary = { caller, repo: { display: '@ST' }, argv: ['branch', 'x'], needsConsoleCode: true, rememberable: [] };
        const codeOf = () => /:\s*(\d{6})$/.exec(logs.at(-1))[1];
        const wrong = (code) => (code === '000000' ? '111111' : '000000');

        // Ten wrong guesses spread over fresh requests, as a guessing script would.
        for (let i = 0; i < 10; i += 1) {
            const id = manager.createPending(summary, 'h');
            assert.equal(errorCode(() => manager.decide({ requestId: id, decision: 'allow', consoleCode: wrong(codeOf()) })), 'TG_CONSOLE_CODE_INVALID');
        }
        assert.match(logs.at(-1), /locked/);

        // Even the right code is refused during the lockout...
        const locked = manager.createPending(summary, 'h');
        assert.equal(errorCode(() => manager.decide({ requestId: locked, decision: 'allow', consoleCode: codeOf() })), 'TG_CONSOLE_CODE_INVALID');

        // ...and accepted once it ends.
        clock += 16 * 60 * 1000;
        const after = manager.createPending(summary, 'h');
        assert.ok(manager.decide({ requestId: after, decision: 'allow', consoleCode: codeOf() }).approvalId);
    });

    it('deletes pending requests on deny and checks push host grants', () => {
        const stateDir = makeStateDir();
        const manager = createConsentManager({ stateDir });
        const caller = { id: 'ext-a', name: 'Ext A', origin: 'ext-a' };
        const cKey = manager.callerKey(caller);

        const req = manager.createPending(
            { caller, repo: { display: '@STuser/chats' }, argv: ['status'], needsConsoleCode: false, rememberable: [] },
            'hash-deny',
        );
        assert.equal(errorCode(() => manager.decide({ requestId: req, decision: 'deny', remember: false })), 'TG_CONSENT_DENIED');
        assert.equal(manager.getPending(req), null);
        assert.equal(errorCode(() => manager.decide({ requestId: req, decision: 'allow', remember: false })), 'TG_CONSENT_EXPIRED');

        const pushRememberable = manager.rememberableFor({
            classes: ['push'],
            destructive: false,
            tier: 'data',
            zone: 'STuser',
            hosts: ['github.com'],
        });
        assert.deepEqual(pushRememberable, [{ cls: 'push', host: 'github.com' }]);

        const pushReq = manager.createPending(
            { caller, repo: { display: '@STuser/chats' }, argv: ['push', 'origin'], needsConsoleCode: false, rememberable: pushRememberable },
            'hash-push',
        );
        manager.decide({ requestId: pushReq, decision: 'allow', remember: true });

        assert.equal(
            manager.isCovered({ classes: ['push'], destructive: false, tier: 'data', zone: 'STuser', hosts: ['github.com'] }, cKey),
            true,
        );
        assert.equal(
            manager.isCovered({ classes: ['push'], destructive: false, tier: 'data', zone: 'STuser', hosts: ['gitlab.com'] }, cKey),
            false,
        );
    });
});
