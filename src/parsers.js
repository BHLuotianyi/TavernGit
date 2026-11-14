/**
 * Pure, DOM-free parsers for git machine output (`status` and `log`).
 */

function splitFieldsAndTail(record, fieldCount) {
    let idx = -1;
    let from = 0;
    for (let i = 0; i < fieldCount; i += 1) {
        idx = record.indexOf(' ', from);
        if (idx === -1) return null;
        from = idx + 1;
    }
    return {
        fields: record.slice(0, idx).split(' '),
        tail: record.slice(idx + 1),
    };
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 * @param {string} stdout
 * @returns {{
 *   branch: { oid: string|null, head: string|null, upstream: string|null, ahead: number, behind: number },
 *   entries: Array<{ type: 'changed'|'renamed'|'unmerged'|'untracked'|'ignored', index: string, worktree: string, path: string, origPath?: string }>
 * }}
 */
export function parseStatusPorcelainV2(stdout) {
    const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
    const entries = [];
    if (!stdout) return { branch, entries };

    const tokens = stdout.split('\0');
    for (let i = 0; i < tokens.length; i += 1) {
        const rec = tokens[i];
        if (!rec) continue;

        if (rec.startsWith('# ')) {
            const rest = rec.slice(2);
            if (rest.startsWith('branch.oid ')) {
                branch.oid = rest.slice('branch.oid '.length);
            } else if (rest.startsWith('branch.head ')) {
                branch.head = rest.slice('branch.head '.length);
            } else if (rest.startsWith('branch.upstream ')) {
                branch.upstream = rest.slice('branch.upstream '.length);
            } else if (rest.startsWith('branch.ab ')) {
                const match = /^\+(\d+)\s+-(\d+)$/.exec(rest.slice('branch.ab '.length));
                if (match) {
                    branch.ahead = Number(match[1]);
                    branch.behind = Number(match[2]);
                }
            }
            continue;
        }

        if (rec.startsWith('1 ')) {
            const parsed = splitFieldsAndTail(rec, 8);
            if (!parsed) continue;
            const xy = parsed.fields[1] || '..';
            entries.push({
                type: 'changed',
                index: xy[0] || '.',
                worktree: xy[1] || '.',
                path: parsed.tail,
            });
            continue;
        }

        if (rec.startsWith('2 ')) {
            const parsed = splitFieldsAndTail(rec, 9);
            if (!parsed) continue;
            const xy = parsed.fields[1] || '..';
            // With `-z`, git emits `<path>\0<origPath>\0` as two consecutive NUL records.
            const origPath = i + 1 < tokens.length ? tokens[++i] : '';
            entries.push({
                type: 'renamed',
                index: xy[0] || '.',
                worktree: xy[1] || '.',
                path: parsed.tail,
                origPath,
            });
            continue;
        }

        if (rec.startsWith('u ')) {
            const parsed = splitFieldsAndTail(rec, 10);
            if (!parsed) continue;
            const xy = parsed.fields[1] || '..';
            entries.push({
                type: 'unmerged',
                index: xy[0] || '.',
                worktree: xy[1] || '.',
                path: parsed.tail,
            });
            continue;
        }

        if (rec.startsWith('? ')) {
            entries.push({
                type: 'untracked',
                index: '?',
                worktree: '?',
                path: rec.slice(2),
            });
            continue;
        }

        if (rec.startsWith('! ')) {
            entries.push({
                type: 'ignored',
                index: '!',
                worktree: '!',
                path: rec.slice(2),
            });
        }
    }

    return { branch, entries };
}

/**
 * Parse `git log -z --format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s` output.
 * @param {string} stdout
 * @returns {Array<{ hash: string, parents: string[], authorName: string, authorEmail: string, authorDate: string, subject: string }>}
 */
export function parseLogOutput(stdout) {
    if (!stdout) return [];
    const commits = [];
    for (const rec of stdout.split('\0')) {
        if (!rec) continue;
        const parts = rec.split('\x1f');
        if (parts.length < 6) continue;
        const [hash, parentsRaw, authorName, authorEmail, authorDate] = parts;
        const subject = parts.slice(5).join('\x1f');
        commits.push({
            hash,
            parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
            authorName,
            authorEmail,
            authorDate,
            subject,
        });
    }
    return commits;
}
