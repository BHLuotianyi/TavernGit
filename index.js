/**
 * SillyTavern UI extension entry point for TavernGit.
 * Loads i18n, installs `globalThis.TavernGit`, mounts the settings drawer,
 * and injects the consent dialog root. Never throws into ST.
 */
import { loadI18n, tr } from './src/i18n.js';
import { installPublicApi } from './src/public-api.js';
import { toast } from './src/st-host.js';
import { injectConsentDialogRoot } from './src/ui/consent-dialog.js';
import { mountSettingsPanel } from './src/ui/settings-panel.js';

(async () => {
    try {
        await loadI18n();
        const api = installPublicApi();
        // Prevent unhandled rejection if the server plugin is missing at startup;
        // the settings panel surfaces the exact guidance to the user.
        api.ready.catch(() => {});
        injectConsentDialogRoot();
        await mountSettingsPanel(api);
    } catch (err) {
        const msg = err?.message || String(err);
        console.error('[TavernGit] Startup failed:', err);
        toast('error', tr('startup.failed', 'TavernGit failed to initialize: ${0}', msg));
    }
})();
