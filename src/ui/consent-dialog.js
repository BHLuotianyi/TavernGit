/**
 * Native `<dialog>` consent prompt with ST fallback, server-console code input,
 * `isTrusted` click protection, and zero `innerHTML` on untrusted strings.
 */
import { ERROR_CODES, TavernGitError } from '../errors.js';
import { tr } from '../i18n.js';
import { request } from '../transport.js';

const ROOT_ID = 'taverngit-consent-root';

/**
 * Ensure the container element for consent dialogs exists in `document.body`.
 * @returns {HTMLElement|null}
 */
export function injectConsentDialogRoot() {
    if (typeof document === 'undefined' || !document.body) return null;
    let root = document.getElementById(ROOT_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = ROOT_ID;
        document.body.appendChild(root);
    }
    return root;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
}

function formatRememberLabel(rememberable, callerName) {
    const byZone = new Map();
    const pushHosts = [];
    for (const item of rememberable) {
        if (item.cls === 'push' && item.host) {
            pushHosts.push(item.host);
        } else if (item.zone) {
            if (!byZone.has(item.zone)) byZone.set(item.zone, []);
            byZone.get(item.zone).push(item.cls);
        }
    }
    const clauses = [];
    for (const [zone, classes] of byZone.entries()) {
        clauses.push(tr('consent.rememberZoneClause', '${0} in ${1}', classes.join(', '), `@${zone}`));
    }
    if (pushHosts.length > 0) {
        clauses.push(tr('consent.rememberPushClause', 'push to ${0}', pushHosts.join(', ')));
    }
    return tr('consent.rememberLabel', 'Always allow ${0} for ${1}', clauses.join('; '), callerName);
}

/**
 * Open a modal consent dialog for `consent` and resolve with `approvalId` or
 * reject with a `TavernGitError`.
 * @param {object} consent
 * @returns {Promise<string>}
 */
export function showConsentDialog(consent) {
    if (typeof document === 'undefined' || !document.body) {
        return Promise.reject(new TavernGitError(ERROR_CODES.TG_INTERNAL, 'DOM unavailable for consent dialog'));
    }
    const root = injectConsentDialogRoot();

    return new Promise((resolve, reject) => {
        const dialog = el('dialog', 'taverngit-consent');
        let usingFallback = false;
        let settled = false;
        let submitting = false;

        // 1. Header
        const header = el('div', 'taverngit-consent-header');
        header.appendChild(el('h3', 'taverngit-consent-title', tr('consent.header', 'TavernGit — ${0}', consent.caller?.name || consent.caller?.id || '')));
        dialog.appendChild(header);

        const body = el('div', 'taverngit-consent-body');

        // 2. Caller line
        const callerRow = el('div', 'taverngit-consent-section taverngit-caller-line');
        callerRow.appendChild(el('span', 'taverngit-label', tr('consent.callerLabel', 'Caller:')));
        callerRow.appendChild(el('strong', 'taverngit-caller-name', consent.caller?.name || ''));
        callerRow.appendChild(el('code', 'taverngit-chip', `id: ${consent.caller?.id || ''}`));

        const originText = consent.caller?.origin
            ? `third-party/${consent.caller.origin}`
            : tr('consent.originUnknown', 'origin: unknown');
        callerRow.appendChild(el('code', 'taverngit-chip', originText));

        const isVerified = Boolean(consent.caller?.origin && consent.caller.origin === consent.caller.id);
        if (!isVerified) {
            callerRow.appendChild(el('span', 'taverngit-badge taverngit-badge-warn', tr('consent.unverified', 'unverified')));
        }
        body.appendChild(callerRow);

        // 3. Banners
        const classes = Array.isArray(consent.classes) ? consent.classes : [];
        const tier = consent.repo?.tier || 'data';
        const isServerNonRead = Boolean(consent.needsConsoleCode) || (tier === 'server' && classes.some((c) => c !== 'read'));

        let codeInput = null;
        let inlineError = null;

        if (isServerNonRead) {
            const redBanner = el('div', 'taverngit-banner taverngit-banner-red');
            redBanner.appendChild(el('strong', 'taverngit-banner-title', tr('consent.serverWarningTitle', 'Danger: SillyTavern server-tier modification')));
            redBanner.appendChild(el('p', 'taverngit-banner-text', tr(
                'consent.serverWarningBody',
                'This action can modify SillyTavern program or configuration files, which run with full system access after restart.',
            )));
            if (consent.needsConsoleCode) {
                const codeBox = el('div', 'taverngit-console-code-box');
                const codeLabel = el('label', 'taverngit-console-code-label', tr(
                    'consent.consoleCodePrompt',
                    'Enter the 6-digit code shown in the SillyTavern server console:',
                ));
                const inputId = `taverngit-code-${Math.random().toString(36).slice(2, 8)}`;
                codeLabel.setAttribute('for', inputId);
                codeInput = document.createElement('input');
                codeInput.id = inputId;
                codeInput.className = 'taverngit-console-code-input text_pole';
                codeInput.type = 'text';
                codeInput.inputMode = 'numeric';
                codeInput.maxLength = 6;
                codeInput.autocomplete = 'off';
                codeInput.placeholder = '000000';
                inlineError = el('div', 'taverngit-inline-error');
                inlineError.hidden = true;

                codeBox.appendChild(codeLabel);
                codeBox.appendChild(codeInput);
                codeBox.appendChild(inlineError);
                redBanner.appendChild(codeBox);
            }
            body.appendChild(redBanner);
        }

        if (consent.destructive) {
            const orangeBanner = el('div', 'taverngit-banner taverngit-banner-orange');
            orangeBanner.appendChild(el('strong', 'taverngit-banner-title', tr('consent.destructiveTitle', 'Destructive operation')));
            const reasons = Array.isArray(consent.destructiveReasons) && consent.destructiveReasons.length
                ? consent.destructiveReasons
                : [tr('consent.destructiveDefault', 'May discard uncommitted work or overwrite history.')];
            const list = el('ul', 'taverngit-reason-list');
            for (const reason of reasons) {
                list.appendChild(el('li', '', reason));
            }
            orangeBanner.appendChild(list);
            body.appendChild(orangeBanner);
        }

        if (tier === 'frontend' && classes.includes('write')) {
            const yellowBanner = el('div', 'taverngit-banner taverngit-banner-yellow');
            yellowBanner.appendChild(el('strong', 'taverngit-banner-title', tr('consent.frontendWarningTitle', 'Frontend code modification')));
            yellowBanner.appendChild(el('p', 'taverngit-banner-text', tr(
                'consent.frontendWarningBody',
                'This writes into browser-executed SillyTavern frontend or extension files.',
            )));
            body.appendChild(yellowBanner);
        }

        if (classes.includes('push')) {
            const hosts = Array.isArray(consent.hosts) ? consent.hosts : [];
            const pushBanner = el('div', 'taverngit-banner taverngit-banner-info');
            pushBanner.appendChild(el('strong', 'taverngit-banner-title', tr('consent.pushHostsTitle', 'Remote push target')));
            pushBanner.appendChild(el('p', 'taverngit-banner-text', hosts.length
                ? tr('consent.pushHostsList', 'Data will be sent to: ${0}', hosts.join(', '))
                : tr('consent.pushHostsUnknown', 'Remote host will be resolved by git.')));
            body.appendChild(pushBanner);
        }

        // 4. Repo
        const repoRow = el('div', 'taverngit-consent-section taverngit-repo-line');
        repoRow.appendChild(el('span', 'taverngit-label', tr('consent.repoLabel', 'Repository:')));
        const aliasText = consent.repo?.alias || consent.repo?.display || '';
        repoRow.appendChild(el('code', 'taverngit-repo-alias', aliasText));
        if (consent.repo?.display && consent.repo.display !== aliasText) {
            repoRow.appendChild(el('code', 'taverngit-repo-display', `(${consent.repo.display})`));
        }
        repoRow.appendChild(el('span', `taverngit-tier-chip taverngit-tier-${tier}`, tr(`tier.${tier}`, tier)));
        body.appendChild(repoRow);

        // 5. Command
        const cmdSection = el('div', 'taverngit-consent-section');
        const cmdHeader = el('div', 'taverngit-command-header');
        cmdHeader.appendChild(el('span', 'taverngit-label', tr('consent.commandLabel', 'Command:')));
        const chips = el('span', 'taverngit-class-chips');
        for (const cls of classes) {
            chips.appendChild(el('span', `taverngit-class-chip taverngit-class-${cls}`, tr(`class.${cls}`, cls)));
        }
        cmdHeader.appendChild(chips);
        cmdSection.appendChild(cmdHeader);

        const pre = el('pre', 'taverngit-command');
        const argvText = Array.isArray(consent.argv) ? consent.argv.join(' ') : '';
        pre.appendChild(el('code', '', `git ${argvText}`));
        cmdSection.appendChild(pre);
        body.appendChild(cmdSection);

        // 6. Remember checkbox (only when rememberable is non-empty)
        let rememberCheckbox = null;
        if (Array.isArray(consent.rememberable) && consent.rememberable.length > 0) {
            const remRow = el('label', 'taverngit-remember-row');
            rememberCheckbox = document.createElement('input');
            rememberCheckbox.type = 'checkbox';
            rememberCheckbox.className = 'taverngit-remember-checkbox';
            const remText = el('span', '', formatRememberLabel(consent.rememberable, consent.caller?.name || consent.caller?.id || ''));
            remRow.appendChild(rememberCheckbox);
            remRow.appendChild(remText);
            body.appendChild(remRow);
        }

        // General error box (for non-code errors if any)
        if (!inlineError) {
            inlineError = el('div', 'taverngit-inline-error');
            inlineError.hidden = true;
            body.appendChild(inlineError);
        }

        dialog.appendChild(body);

        // 7. Buttons
        const footer = el('div', 'taverngit-consent-footer');
        const denyBtn = el('button', 'menu_button taverngit-btn-deny', tr('consent.deny', 'Deny'));
        denyBtn.type = 'button';
        denyBtn.dataset.action = 'deny';
        denyBtn.autofocus = true;

        const allowBtn = el('button', 'menu_button taverngit-btn-allow', tr('consent.allow', 'Allow'));
        allowBtn.type = 'button';
        allowBtn.dataset.action = 'allow';

        footer.appendChild(denyBtn);
        footer.appendChild(allowBtn);
        dialog.appendChild(footer);

        const syncAllowDisabled = () => {
            if (submitting) {
                allowBtn.disabled = true;
                denyBtn.disabled = true;
                return;
            }
            denyBtn.disabled = false;
            if (consent.needsConsoleCode && codeInput) {
                allowBtn.disabled = !/^\d{6}$/.test(codeInput.value.trim());
            } else {
                allowBtn.disabled = false;
            }
        };

        if (codeInput) {
            codeInput.addEventListener('input', syncAllowDisabled);
        }
        syncAllowDisabled();

        const cleanup = () => {
            if (usingFallback) {
                document.removeEventListener('keydown', onFallbackKeydown, true);
            }
            try {
                if (typeof dialog.close === 'function' && dialog.open) {
                    dialog.close();
                } else {
                    dialog.removeAttribute('open');
                }
            } catch {
                dialog.removeAttribute('open');
            }
            dialog.remove();
        };

        const finishResolve = (approvalId) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(approvalId);
        };

        const finishReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };

        const submitDeny = async () => {
            if (settled || submitting) return;
            submitting = true;
            syncAllowDisabled();
            try {
                await request('POST', '/consent', {
                    requestId: consent.requestId,
                    decision: 'deny',
                    remember: false,
                });
                finishReject(new TavernGitError(ERROR_CODES.TG_CONSENT_DENIED, 'Consent denied by user'));
            } catch (err) {
                finishReject(err);
            }
        };

        const submitAllow = async () => {
            if (settled || submitting) return;
            if (consent.needsConsoleCode && (!codeInput || !/^\d{6}$/.test(codeInput.value.trim()))) {
                return;
            }
            submitting = true;
            if (inlineError) {
                inlineError.hidden = true;
                inlineError.textContent = '';
            }
            syncAllowDisabled();
            try {
                const payload = {
                    requestId: consent.requestId,
                    decision: 'allow',
                    remember: Boolean(rememberCheckbox?.checked),
                };
                if (consent.needsConsoleCode && codeInput) {
                    payload.consoleCode = codeInput.value.trim();
                }
                const res = await request('POST', '/consent', payload);
                finishResolve(res.approvalId);
            } catch (err) {
                if (err?.code === ERROR_CODES.TG_CONSOLE_CODE_INVALID) {
                    submitting = false;
                    syncAllowDisabled();
                    if (inlineError) {
                        inlineError.textContent = tr('consent.invalidCode', 'Incorrect confirmation code. Check the server console and try again.');
                        inlineError.hidden = false;
                    }
                    if (codeInput) {
                        codeInput.focus();
                        codeInput.select();
                    }
                    return;
                }
                finishReject(err);
            }
        };

        // Ignore synthetic/untrusted clicks so same-page scripts cannot auto-approve.
        denyBtn.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            submitDeny();
        });
        allowBtn.addEventListener('click', (event) => {
            if (!event.isTrusted) return;
            submitAllow();
        });

        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            submitDeny();
        });

        function onFallbackKeydown(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                submitDeny();
            }
        }

        root.appendChild(dialog);
        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            usingFallback = true;
            dialog.classList.add('taverngit-consent-fallback');
            dialog.setAttribute('open', '');
            document.addEventListener('keydown', onFallbackKeydown, true);
        }
        denyBtn.focus();
    });
}
