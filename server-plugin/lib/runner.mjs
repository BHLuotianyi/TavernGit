/**
 * Child process runner for git. Every spawn goes through here so timeouts,
 * output caps, process-tree kills and the global concurrency limit apply
 * uniformly.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { TavernGitError } from './errors.mjs';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const NETWORK_TIMEOUT_MS = 600_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT = 4;

/** Children still running, so `killAll()` can stop them on plugin exit. */
const running = new Set();

/** FIFO counting semaphore bounding concurrent git processes. */
let active = 0;
const waiting = [];

async function acquire() {
    if (active < MAX_CONCURRENT) {
        active += 1;
        return;
    }
    await new Promise((resolve) => waiting.push(resolve));
}

function release() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
}

/** Tails of the per-repo exclusive lock chains. */
const repoLocks = new Map();

/**
 * Run `fn` while holding the exclusive lock for `key` (a repo realpath).
 * Mutating and network commands serialize per repository so two callers
 * cannot interleave index or ref updates; reads never take the lock.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withRepoLock(key, fn) {
    const previous = repoLocks.get(key) ?? Promise.resolve();
    let unlock;
    const current = new Promise((resolve) => { unlock = resolve; });
    const tail = previous.then(() => current);
    repoLocks.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        unlock();
        if (repoLocks.get(key) === tail) repoLocks.delete(key);
    }
}

/**
 * Kill a child and all of its descendants. git spawns helpers
 * (`git-remote-https`, pack-objects, ...) that would otherwise survive.
 */
function killTree(child, platform) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
        if (platform === 'win32') {
            const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
            spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
            // Negative pid: the whole process group created by `detached`.
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        child.kill('SIGKILL');
    }
}

/**
 * Spawn git without a shell and collect its output.
 * @param {object} options
 * @param {string} options.gitPath
 * @param {string[]} options.args
 * @param {string} options.cwd
 * @param {Record<string,string>} options.env complete environment (see git-env.mjs)
 * @param {string} [options.input] written to stdin
 * @param {boolean} [options.binary] return stdout as base64
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxOutputBytes] combined stdout+stderr cap
 * @param {NodeJS.Platform} [options.platform]
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, durationMs: number }>}
 */
export async function runGit({
    gitPath, args, cwd, env, input, binary = false,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, platform = process.platform,
}) {
    await acquire();
    const started = Date.now();
    try {
        return await new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(gitPath, args, {
                    cwd,
                    env,
                    shell: false,
                    windowsHide: true,
                    detached: platform !== 'win32',
                    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                });
            } catch (error) {
                reject(new TavernGitError('TG_GIT_UNAVAILABLE', `Cannot start git: ${error.message}`));
                return;
            }
            running.add(child);

            const stdout = [];
            const stderr = [];
            let total = 0;
            let failure = null;
            const abort = (error) => {
                if (failure) return;
                failure = error;
                killTree(child, platform);
            };
            const collect = (sink) => (chunk) => {
                total += chunk.length;
                if (total > maxOutputBytes) {
                    abort(new TavernGitError('TG_OUTPUT_TOO_LARGE', `git output exceeded ${maxOutputBytes} bytes`));
                    return;
                }
                sink.push(chunk);
            };
            child.stdout.on('data', collect(stdout));
            child.stderr.on('data', collect(stderr));

            const timer = setTimeout(() => {
                abort(new TavernGitError('TG_TIMEOUT', `git did not finish within ${timeoutMs} ms`));
            }, timeoutMs);

            if (input !== undefined) {
                // git may exit before reading all input (e.g. a bad patch); the
                // resulting EPIPE is not an error of ours.
                child.stdin.on('error', () => {});
                child.stdin.end(input);
            }

            child.on('error', (error) => {
                clearTimeout(timer);
                running.delete(child);
                reject(failure ?? new TavernGitError('TG_GIT_UNAVAILABLE', `Cannot start git: ${error.message}`));
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                running.delete(child);
                if (failure) {
                    reject(failure);
                    return;
                }
                const out = Buffer.concat(stdout);
                resolve({
                    exitCode: code ?? (signal ? 128 : 1),
                    stdout: binary ? out.toString('base64') : out.toString('utf8'),
                    stderr: Buffer.concat(stderr).toString('utf8'),
                    durationMs: Date.now() - started,
                });
            });
        });
    } finally {
        release();
    }
}

/** Kill every running git process (plugin shutdown). */
export function killAll(platform = process.platform) {
    for (const child of running) killTree(child, platform);
    running.clear();
}
