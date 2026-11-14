/**
 * FIFO consent prompt queue. Ensures at most one consent modal is open at a
 * time even if multiple extensions issue TavernGit calls concurrently.
 */

/**
 * Create a FIFO queue around a dialog presentation function.
 * @param {(consent: object) => Promise<string>} presentConsent
 * @returns {{ request: (consent: object) => Promise<string> }}
 */
export function createConsentQueue(presentConsent) {
    let tail = Promise.resolve();

    return {
        request(consent) {
            const run = tail.then(
                () => presentConsent(consent),
                () => presentConsent(consent),
            );
            // Keep the queue advancing even when a prompt rejects (denied/expired).
            tail = run.catch(() => {});
            return run;
        },
    };
}
