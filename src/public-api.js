/**
 * Public `globalThis.TavernGit` API installed on SillyTavern startup.
 */
import { detectCallerOrigin, OWN_FOLDER } from './caller.js';
import { EXTENSION_VERSION, PROTOCOL_VERSION } from './constants.js';
import { ERROR_CODES, TavernGitError } from './errors.js';
import { parseLogOutput, parseStatusPorcelainV2 } from './parsers.js';
import { request } from './transport.js';
import { showConsentDialog } from './ui/consent-dialog.js';
import { createConsentQueue } from './ui/consent-queue.js';

const CALLER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ZONES = Object.freeze(['@ST', '@STdata', '@STuser', '@SText', '@STplugins']);

function assertZeroExit(res) {
    if (res.exitCode !== 0) {
        throw new TavernGitError(
            ERROR_CODES.TG_GIT_FAILED,
            res.stderr || `git exited with code ${res.exitCode}`,
            { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr },
        );
    }
    return res;
}

/**
 * Create the frozen public TavernGit API object.
 * @param {object} [options]
 * @param {(consent: object) => Promise<string>} [options.presentConsent]
 * @returns {object}
 */
export function createPublicApi({ presentConsent = showConsentDialog } = {}) {
    const consentQueue = createConsentQueue(presentConsent);
    let protocolMismatch = false;

    async function fetchStatus(refresh = false) {
        const path = refresh ? '/status?refresh=1' : '/status';
        const data = await request('GET', path);
        const { ok: _ok, ...status } = data;
        protocolMismatch = Number(status?.plugin?.protocol) !== PROTOCOL_VERSION;
        return status;
    }

    const ready = fetchStatus(false);

    async function ensureProtocolOk() {
        try {
            await ready;
        } catch {
            // Startup status failure (e.g. plugin missing) will surface on the actual call.
        }
        if (protocolMismatch) {
            throw new TavernGitError(
                ERROR_CODES.TG_PROTOCOL_MISMATCH,
                `TavernGit protocol mismatch (extension protocol ${PROTOCOL_VERSION}). Update both the UI extension and server plugin.`,
            );
        }
    }

    async function getStatus({ refresh = false } = {}) {
        if (!refresh) {
            try {
                return await ready;
            } catch {
                return fetchStatus(true);
            }
        }
        return fetchStatus(true);
    }

    async function resolve(path) {
        await ensureProtocolOk();
        const data = await request('POST', '/resolve', { path });
        const { ok: _ok, ...resolved } = data;
        return resolved;
    }

    function connect(callerSpec) {
        const id = callerSpec?.id;
        const name = callerSpec?.name;
        if (typeof id !== 'string' || !CALLER_ID_RE.test(id)) {
            throw new TavernGitError(
                ERROR_CODES.TG_BAD_REQUEST,
                'Caller id must be 1-64 characters matching /^[a-z0-9][a-z0-9._-]{0,63}$/i',
            );
        }
        if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
            throw new TavernGitError(
                ERROR_CODES.TG_BAD_REQUEST,
                'Caller name must be a non-empty string of at most 80 characters',
            );
        }

        function git(repo, args, options = {}) {
            // Capture caller origin synchronously before any `await` drops stack frames.
            const origin = detectCallerOrigin(OWN_FOLDER);
            const { input, binary, timeoutMs } = options || {};
            return execWithConsent({ repo, args, input, binary, timeoutMs, origin });
        }

        async function execWithConsent({ repo, args, input, binary, timeoutMs, origin }) {
            await ensureProtocolOk();
            const payload = {
                caller: { id, name, origin },
                repo,
                args,
            };
            if (input !== undefined) payload.input = input;
            if (binary !== undefined) payload.binary = binary;
            if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;

            let data;
            try {
                data = await request('POST', '/exec', payload);
            } catch (err) {
                if (err?.code === ERROR_CODES.TG_CONSENT_REQUIRED && err.consent) {
                    const approvalId = await consentQueue.request(err.consent);
                    data = await request('POST', '/exec', { ...payload, approvalId });
                } else {
                    throw err;
                }
            } finally {
                // The settings panel refreshes its audit log and grants on this.
                globalThis.dispatchEvent?.(new CustomEvent('taverngit:activity'));
            }

            return {
                exitCode: data.exitCode,
                stdout: data.stdout,
                stderr: data.stderr,
                durationMs: data.durationMs,
                warnings: Array.isArray(data.warnings) ? data.warnings : [],
            };
        }

        function init(repo, { initialBranch, bare } = {}) {
            const args = ['init'];
            if (initialBranch) args.push('-b', initialBranch);
            if (bare) args.push('--bare');
            return git(repo, args).then(assertZeroExit);
        }

        function clone(url, dest, { depth, branch, singleBranch, noTags, bare, filter } = {}) {
            const args = ['clone'];
            if (singleBranch === true) args.push('--single-branch');
            else if (singleBranch === false) args.push('--no-single-branch');
            if (noTags) args.push('--no-tags');
            if (bare) args.push('--bare');
            if (depth !== undefined && depth !== null) args.push('--depth', String(depth));
            if (branch) args.push('--branch', branch);
            if (filter) args.push('--filter', filter);
            args.push(url);
            return git(dest, args).then(assertZeroExit);
        }

        function status(repo) {
            return git(repo, ['status', '--porcelain=v2', '--branch', '-z'])
                .then(assertZeroExit)
                .then((res) => parseStatusPorcelainV2(res.stdout));
        }

        function log(repo, { maxCount = 50, ref, path } = {}) {
            const args = ['log', '-z', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s'];
            if (maxCount !== undefined && maxCount !== null) args.push('-n', String(maxCount));
            if (ref) args.push(ref);
            if (path) {
                const list = Array.isArray(path) ? path : [path];
                if (list.length) args.push('--', ...list);
            }
            return git(repo, args)
                .then(assertZeroExit)
                .then((res) => parseLogOutput(res.stdout));
        }

        function add(repo, paths) {
            const list = Array.isArray(paths) ? paths : [paths];
            if (!list.length) {
                return Promise.reject(new TavernGitError(ERROR_CODES.TG_BAD_REQUEST, 'add requires at least one path'));
            }
            return git(repo, ['add', '--', ...list]).then(assertZeroExit);
        }

        function commit(repo, message, { amend, allowEmpty } = {}) {
            const args = ['commit'];
            // Attached form: a message may start with "-", which the server
            // accepts as an option value only when it is attached.
            if (message !== undefined && message !== null) args.push(`--message=${String(message)}`);
            if (amend) args.push('--amend');
            if (allowEmpty) args.push('--allow-empty');
            return git(repo, args).then(assertZeroExit);
        }

        function diff(repo, { cached, paths } = {}) {
            const args = ['diff'];
            if (cached) args.push('--cached');
            if (paths) {
                const list = Array.isArray(paths) ? paths : [paths];
                if (list.length) args.push('--', ...list);
            }
            return git(repo, args).then(assertZeroExit).then((res) => res.stdout);
        }

        function fetch(repo, remote = 'origin') {
            const args = remote ? ['fetch', remote] : ['fetch'];
            return git(repo, args).then(assertZeroExit);
        }

        function pull(repo, remote, branch) {
            const args = ['pull'];
            if (remote) {
                args.push(remote);
                if (branch) args.push(branch);
            }
            return git(repo, args).then(assertZeroExit);
        }

        function push(repo, remote, refspecs = [], { setUpstream, forceWithLease } = {}) {
            const args = ['push'];
            if (setUpstream) args.push('-u');
            if (forceWithLease === true) args.push('--force-with-lease');
            else if (typeof forceWithLease === 'string' && forceWithLease) {
                args.push(`--force-with-lease=${forceWithLease}`);
            }
            if (remote) args.push(remote);
            if (Array.isArray(refspecs)) args.push(...refspecs);
            else if (refspecs) args.push(refspecs);
            return git(repo, args).then(assertZeroExit);
        }

        return Object.freeze({
            git,
            init,
            clone,
            status,
            log,
            add,
            commit,
            diff,
            fetch,
            pull,
            push,
        });
    }

    return Object.freeze({
        version: EXTENSION_VERSION,
        protocol: PROTOCOL_VERSION,
        ready,
        getStatus,
        resolve,
        connect,
        zones: ZONES,
        TavernGitError,
        errorCodes: ERROR_CODES,
    });
}

/**
 * Install `globalThis.TavernGit` and emit `taverngit:ready`.
 * @returns {object}
 */
export function installPublicApi() {
    const api = createPublicApi();
    globalThis.TavernGit = api;
    if (typeof globalThis.window?.dispatchEvent === 'function' && typeof globalThis.CustomEvent === 'function') {
        globalThis.window.dispatchEvent(new globalThis.CustomEvent('taverngit:ready', { detail: api }));
    }
    return api;
}
