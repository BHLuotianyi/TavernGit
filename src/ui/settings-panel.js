/**
 * Settings drawer controller for `#extensions_settings2`.
 * All dynamic data is rendered via `textContent` and `createElement`.
 */
import { EXTENSION_VERSION, EXTENSION_VERSION_CODE, PROTOCOL_VERSION } from '../constants.js';
import { ERROR_CODES } from '../errors.js';
import { tr } from '../i18n.js';
import { toast } from '../st-host.js';
import { request } from '../transport.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function makeWarningBox(title, lines, tone = 'yellow') {
    const box = el('div', `taverngit-warning-box taverngit-warning-${tone}`);
    box.appendChild(el('strong', 'taverngit-warning-title', title));
    for (const line of lines) {
        if (typeof line === 'string') {
            box.appendChild(el('p', 'taverngit-warning-line', line));
        } else if (line instanceof Node) {
            box.appendChild(line);
        }
    }
    return box;
}

function makeCell(label, content) {
    const td = document.createElement('td');
    td.setAttribute('data-label', label);
    if (content instanceof Node) td.appendChild(content);
    else td.textContent = content ?? '';
    return td;
}

function makeEmptyRow(colSpan, text) {
    const trEl = document.createElement('tr');
    const td = el('td', 'taverngit-empty-cell', text);
    td.colSpan = colSpan;
    trEl.appendChild(td);
    return trEl;
}

function formatTime(ts) {
    if (!ts) return '';
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return String(ts);
    }
}

function localizeStaticTree(root) {
    for (const node of root.querySelectorAll('[data-i18n]')) {
        const key = node.getAttribute('data-i18n');
        if (key) node.textContent = tr(key, node.textContent);
    }
}

/**
 * Fetch `settings.html`, mount it in `#extensions_settings2`, and bind all handlers.
 * @param {{ getStatus: (opts?: { refresh?: boolean }) => Promise<any> }} api
 * @returns {Promise<HTMLElement|null>}
 */
export async function mountSettingsPanel(api) {
    if (typeof document === 'undefined') return null;

    let container = document.getElementById('extensions_settings2');
    if (!container) {
        await new Promise((resolve) => {
            if (document.readyState !== 'loading') {
                resolve();
            } else {
                document.addEventListener('DOMContentLoaded', resolve, { once: true });
            }
        });
        container = document.getElementById('extensions_settings2');
    }
    if (!container) return null;

    if (document.getElementById('taverngit-settings')) {
        return document.getElementById('taverngit-settings');
    }

    const htmlUrl = new URL('../../settings.html', import.meta.url);
    const res = await globalThis.fetch(htmlUrl.href);
    if (!res.ok) {
        throw new Error(`Failed to load settings.html (${res.status})`);
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.getElementById('taverngit-settings');
    if (!root) throw new Error('settings.html missing #taverngit-settings');

    localizeStaticTree(root);
    container.appendChild(root);

    const adminErrorEl = root.querySelector('#taverngit-admin-error');
    const statusSummaryEl = root.querySelector('#taverngit-status-summary');
    const statusWarningsEl = root.querySelector('#taverngit-status-warnings');
    const recheckBtn = root.querySelector('#taverngit-recheck-btn');

    const identityForm = root.querySelector('#taverngit-identity-form');
    const identityNameInput = root.querySelector('#taverngit-identity-name');
    const identityEmailInput = root.querySelector('#taverngit-identity-email');

    const credentialsBody = root.querySelector('#taverngit-credentials-body');
    const credentialForm = root.querySelector('#taverngit-credential-form');
    const credHostInput = root.querySelector('#taverngit-cred-host');
    const credUserInput = root.querySelector('#taverngit-cred-username');
    const credTokenInput = root.querySelector('#taverngit-cred-token');

    const grantsBody = root.querySelector('#taverngit-grants-body');
    const revokeAllBtn = root.querySelector('#taverngit-revoke-all-btn');

    const auditBody = root.querySelector('#taverngit-audit-body');
    const auditRefreshBtn = root.querySelector('#taverngit-audit-refresh-btn');

    function showAdminError(err) {
        if (!err) {
            adminErrorEl.hidden = true;
            adminErrorEl.textContent = '';
            return;
        }
        adminErrorEl.textContent = err.code === ERROR_CODES.TG_ADMIN_REQUIRED
            ? tr('settings.adminRequired', 'Administrator privileges in SillyTavern are required to use TavernGit.')
            : (err.message || String(err));
        adminErrorEl.hidden = false;
    }

    function renderStatus(status, err) {
        statusSummaryEl.replaceChildren();
        statusWarningsEl.replaceChildren();

        if (err) {
            if (err.code === ERROR_CODES.TG_SERVER_PLUGIN_MISSING) {
                statusSummaryEl.appendChild(el('div', 'taverngit-status-line', tr(
                    'settings.uiVersionOnly',
                    'UI extension v${0} (code ${1}, protocol ${2}) — server plugin unavailable',
                    EXTENSION_VERSION,
                    EXTENSION_VERSION_CODE,
                    PROTOCOL_VERSION,
                )));
                statusWarningsEl.appendChild(makeWarningBox(
                    tr('settings.warnPluginMissingTitle', 'TavernGit server plugin not detected'),
                    [
                        tr('settings.warnPluginMissingModeA', 'Mode (a): Copy the server-plugin/ directory to <SillyTavern>/plugins/taverngit/.'),
                        tr('settings.warnPluginMissingModeB', 'Mode (b): git clone https://github.com/BHLuotianyi/TavernGit <SillyTavern>/plugins/taverngit'),
                        tr('settings.warnPluginMissingEnable', 'Then set enableServerPlugins: true in config.yaml and restart SillyTavern.'),
                        tr('settings.warnPluginMissingTauri', 'Note: TauriTavern is not supported because it does not run Node server plugins.'),
                    ],
                    'red',
                ));
                return;
            }
            if (err.code === ERROR_CODES.TG_BAD_INSTALL_LOCATION) {
                statusWarningsEl.appendChild(makeWarningBox(
                    tr('settings.warnBadInstallTitle', 'Invalid server plugin install location'),
                    [err.message || tr('settings.warnBadInstallBody', 'Server plugin could not find the SillyTavern root directory.')],
                    'red',
                ));
                return;
            }
            if (err.code === ERROR_CODES.TG_ADMIN_REQUIRED) {
                showAdminError(err);
                return;
            }
            statusWarningsEl.appendChild(makeWarningBox(
                tr('settings.warnStatusErrorTitle', 'Failed to read TavernGit status'),
                [err.message || String(err)],
                'red',
            ));
            return;
        }

        showAdminError(null);

        const plugin = status.plugin || {};
        const git = status.git || {};

        const summaryGrid = el('div', 'taverngit-kv-grid');
        const addKv = (k, v) => {
            const row = el('div', 'taverngit-kv-item');
            row.appendChild(el('span', 'taverngit-kv-key', k));
            row.appendChild(el('span', 'taverngit-kv-val', v));
            summaryGrid.appendChild(row);
        };
        addKv(
            tr('settings.labelPlugin', 'Plugin'),
            `v${plugin.version ?? '?'} (code ${plugin.versionCode ?? '?'}, protocol ${plugin.protocol ?? '?'})`,
        );
        addKv(
            tr('settings.labelUi', 'UI Extension'),
            `v${EXTENSION_VERSION} (code ${EXTENSION_VERSION_CODE}, protocol ${PROTOCOL_VERSION})`,
        );
        addKv(
            tr('settings.labelGit', 'Git'),
            git.available
                ? `${git.version} (${git.source})`
                : tr('settings.gitUnavailable', 'Unavailable (${0})', git.reason || 'unknown'),
        );
        addKv(
            tr('settings.labelPlatform', 'Platform / User'),
            `${status.platform || '?'} — ${status.user?.handle || 'default-user'}${status.user?.admin ? ' (admin)' : ''}`,
        );
        statusSummaryEl.appendChild(summaryGrid);

        if (Array.isArray(status.zones)) {
            const zonesRow = el('div', 'taverngit-zones-row');
            for (const z of status.zones) {
                // `@STdata → @ST/data`: the zone name callers use, then where it points.
                const target = z.available && z.display ? ` → ${z.display}` : '';
                const state = z.available ? '' : ` (${tr('settings.zoneOff', 'unavailable')})`;
                const chip = el(
                    'span',
                    `taverngit-zone-chip ${z.available ? 'taverngit-zone-ok' : 'taverngit-zone-off'}`,
                    `@${z.name}${target}${state}`,
                );
                zonesRow.appendChild(chip);
            }
            statusSummaryEl.appendChild(zonesRow);
        }

        if (Number(plugin.protocol) !== PROTOCOL_VERSION) {
            statusWarningsEl.appendChild(makeWarningBox(
                tr('settings.warnProtocolTitle', 'Protocol version mismatch'),
                [
                    tr(
                        'settings.warnProtocolBody',
                        'UI extension protocol (${0}) does not match server plugin protocol (${1}). Update both halves to the same version.',
                        PROTOCOL_VERSION,
                        plugin.protocol ?? '?',
                    ),
                ],
                'red',
            ));
        }

        // Only a data root that exists but lies outside ST is a problem; ST 1.11
        // has none at all, and its zone chips already show the zones as unavailable.
        if (status.dataRootInside === false && status.dataRootFound !== false) {
            statusWarningsEl.appendChild(makeWarningBox(
                tr('settings.warnDataRootTitle', 'Data directory outside SillyTavern'),
                [
                    tr(
                        'settings.warnDataRootBody',
                        'DATA_ROOT is outside the SillyTavern root directory, so @STdata and @STuser are inaccessible.',
                    ),
                ],
                'yellow',
            ));
        }

        if (!git.available) {
            if (git.reason === ERROR_CODES.TG_MINGIT_MISSING) {
                const hintPath = git.hint?.path || '@STplugins/taverngit/mingit';
                const expectedPath = git.hint?.expected || `${hintPath}/cmd/git.exe`;
                const releaseUrl = git.hint?.url || 'https://github.com/git-for-windows/git/releases/latest';
                const downloadLine = el('p', 'taverngit-warning-line');
                downloadLine.appendChild(document.createTextNode(tr(
                    'settings.warnMingitDownloadPrefix',
                    'Download MinGit-<ver>-64-bit.zip (or -arm64.zip) from ',
                )));
                const link = el('a', 'taverngit-link', releaseUrl);
                link.href = /^https:\/\//i.test(releaseUrl) ? releaseUrl : '#';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                downloadLine.appendChild(link);
                downloadLine.appendChild(document.createTextNode('.'));

                statusWarningsEl.appendChild(makeWarningBox(
                    tr('settings.warnMingitTitle', 'MinGit for Windows is missing'),
                    [
                        downloadLine,
                        tr(
                            'settings.warnMingitExtract',
                            'Extract it so that ${0} exists (folder: ${1}), then click Re-check.',
                            expectedPath,
                            hintPath,
                        ),
                    ],
                    'red',
                ));
            } else if (git.reason === ERROR_CODES.TG_GIT_MISSING || git.reason === ERROR_CODES.TG_GIT_TOO_OLD) {
                const title = git.reason === ERROR_CODES.TG_GIT_TOO_OLD
                    ? tr('settings.warnGitTooOldTitle', 'Git ${0} is too old (minimum ${1})', git.version || '?', git.minVersion || '2.32.0')
                    : tr('settings.warnGitMissingTitle', 'System git was not found');
                const lines = [];
                if (Array.isArray(git.hint?.commands)) {
                    for (const item of git.hint.commands) {
                        const row = el('p', 'taverngit-warning-line');
                        row.appendChild(el('strong', '', `${item.platform}: `));
                        row.appendChild(el('code', '', item.command));
                        lines.push(row);
                    }
                } else if (git.hint?.url) {
                    lines.push(tr('settings.warnGitUpdateUrl', 'Download a newer release from ${0}', git.hint.url));
                }
                statusWarningsEl.appendChild(makeWarningBox(title, lines, 'red'));
            }
        }
    }

    let pluginReady = false;

    async function loadStatus(refresh = false) {
        try {
            const status = await api.getStatus({ refresh });
            renderStatus(status, null);
            pluginReady = true;
            return true;
        } catch (err) {
            pluginReady = false;
            renderStatus(null, err);
            return false;
        }
    }

    async function loadIdentity() {
        try {
            const data = await request('GET', '/identity');
            identityNameInput.value = data.identity?.name || '';
            identityEmailInput.value = data.identity?.email || '';
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
        }
    }

    async function loadCredentials() {
        try {
            const data = await request('GET', '/credentials');
            const list = Array.isArray(data.credentials) ? data.credentials : [];
            credentialsBody.replaceChildren();
            if (!list.length) {
                credentialsBody.appendChild(makeEmptyRow(4, tr('settings.noCredentials', 'No credentials stored.')));
                return;
            }
            for (const cred of list) {
                const row = document.createElement('tr');
                row.appendChild(makeCell(tr('settings.colHost', 'Host'), cred.host));
                row.appendChild(makeCell(tr('settings.colUsername', 'Username'), cred.username));
                row.appendChild(makeCell(tr('settings.colCreated', 'Created'), formatTime(cred.createdAt)));
                const delBtn = el('button', 'menu_button taverngit-btn-sm taverngit-btn-danger', tr('settings.delete', 'Delete'));
                delBtn.type = 'button';
                delBtn.addEventListener('click', async () => {
                    try {
                        await request('DELETE', `/credentials/${encodeURIComponent(cred.id)}`);
                        toast('success', tr('settings.credentialDeleted', 'Credential removed.'));
                        await loadCredentials();
                    } catch (err) {
                        toast('error', err.message || String(err));
                    }
                });
                row.appendChild(makeCell(tr('settings.colActions', 'Actions'), delBtn));
                credentialsBody.appendChild(row);
            }
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
        }
    }

    async function loadGrants() {
        try {
            const data = await request('GET', '/grants');
            const list = Array.isArray(data.grants) ? data.grants : [];
            grantsBody.replaceChildren();
            if (!list.length) {
                grantsBody.appendChild(makeEmptyRow(4, tr('settings.noGrants', 'No saved grants.')));
                return;
            }
            for (const grant of list) {
                const row = document.createElement('tr');
                const callerLabel = grant.callerName ? `${grant.callerName} (${grant.callerKey})` : grant.callerKey;
                row.appendChild(makeCell(tr('settings.colCaller', 'Caller'), callerLabel));
                row.appendChild(makeCell(tr('settings.colClass', 'Class'), grant.cls));
                row.appendChild(makeCell(tr('settings.colScope', 'Zone / Host'), grant.zone ? `@${grant.zone}` : grant.host || ''));
                const revBtn = el('button', 'menu_button taverngit-btn-sm taverngit-btn-danger', tr('settings.revoke', 'Revoke'));
                revBtn.type = 'button';
                revBtn.addEventListener('click', async () => {
                    try {
                        await request('DELETE', `/grants/${encodeURIComponent(grant.id)}`);
                        toast('success', tr('settings.grantRevoked', 'Grant revoked.'));
                        await loadGrants();
                    } catch (err) {
                        toast('error', err.message || String(err));
                    }
                });
                row.appendChild(makeCell(tr('settings.colActions', 'Actions'), revBtn));
                grantsBody.appendChild(row);
            }
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
        }
    }

    async function loadAudit() {
        try {
            const data = await request('GET', '/audit?limit=50');
            const entries = Array.isArray(data.entries) ? data.entries : [];
            auditBody.replaceChildren();
            if (!entries.length) {
                auditBody.appendChild(makeEmptyRow(7, tr('settings.noAudit', 'No audit entries yet.')));
                return;
            }
            for (const entry of entries) {
                const row = document.createElement('tr');
                row.appendChild(makeCell(tr('settings.colTime', 'Time'), formatTime(entry.ts)));
                const caller = entry.callerOrigin ? `${entry.callerId} (${entry.callerOrigin})` : (entry.callerId || '');
                row.appendChild(makeCell(tr('settings.colCaller', 'Caller'), caller));
                row.appendChild(makeCell(tr('settings.colRepo', 'Repository'), entry.repo || ''));
                const cmdText = Array.isArray(entry.argv) ? `git ${entry.argv.join(' ')}` : '';
                row.appendChild(makeCell(tr('settings.colCommand', 'Command'), el('code', 'taverngit-audit-cmd', cmdText)));
                const classesText = Array.isArray(entry.classes) ? entry.classes.join(', ') : '';
                row.appendChild(makeCell(tr('settings.colTier', 'Tier / Classes'), `${entry.tier || '?'} / ${classesText}`));
                row.appendChild(makeCell(tr('settings.colDecision', 'Decision'), entry.decision || ''));
                const outcome = entry.errorCode
                    ? entry.errorCode
                    : (entry.exitCode !== undefined ? `exit ${entry.exitCode}${entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''}` : '');
                row.appendChild(makeCell(tr('settings.colResult', 'Result'), outcome));
                auditBody.appendChild(row);
            }
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
        }
    }

    async function loadAll(refreshStatus = false) {
        const ok = await loadStatus(refreshStatus);
        if (ok) {
            await Promise.all([loadIdentity(), loadCredentials(), loadGrants(), loadAudit()]);
        }
    }

    recheckBtn.addEventListener('click', () => {
        loadAll(true);
    });

    identityForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            const data = await request('POST', '/identity', {
                name: identityNameInput.value.trim(),
                email: identityEmailInput.value.trim(),
            });
            identityNameInput.value = data.identity?.name || '';
            identityEmailInput.value = data.identity?.email || '';
            toast('success', tr('settings.identitySaved', 'Commit identity saved.'));
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
            toast('error', err.message || String(err));
        }
    });

    credentialForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        try {
            await request('POST', '/credentials', {
                host: credHostInput.value.trim(),
                username: credUserInput.value.trim(),
                token: credTokenInput.value,
            });
            credHostInput.value = '';
            credUserInput.value = '';
            credTokenInput.value = '';
            toast('success', tr('settings.credentialAdded', 'Credential added.'));
            await loadCredentials();
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
            toast('error', err.message || String(err));
        }
    });

    revokeAllBtn.addEventListener('click', async () => {
        try {
            await request('DELETE', '/grants');
            toast('success', tr('settings.allGrantsRevoked', 'All grants revoked.'));
            await loadGrants();
        } catch (err) {
            if (err?.code === ERROR_CODES.TG_ADMIN_REQUIRED) showAdminError(err);
            toast('error', err.message || String(err));
        }
    });

    auditRefreshBtn.addEventListener('click', () => {
        loadAudit();
    });
    const refreshActivity = () => {
        if (pluginReady) {
            loadGrants();
            loadAudit();
        }
    };
    root.querySelector('.inline-drawer-toggle')?.addEventListener('click', refreshActivity);
    // Every git call can add an audit entry and a "remember" can add grants;
    // keep the panel current instead of showing the state from page load.
    let activityTimer = null;
    window.addEventListener('taverngit:activity', () => {
        clearTimeout(activityTimer);
        activityTimer = setTimeout(refreshActivity, 300);
    });

    await loadAll(false);
    return root;
}
