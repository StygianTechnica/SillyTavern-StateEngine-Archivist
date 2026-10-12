// Running one of Archivist's independent presets (catch-up, the compiler)
// through State Engine. State Engine runs one independent preset at a time
// across every extension and turns a run away ('skipped-in-progress') while
// another is going; that is waited out and retried, never counted as a
// failure.

import { runIndependentPreset, getIndependentPresetStatus } from '../api/independent-presets.js';

export const BUSY_RETRY_MS = 2000;
export const BUSY_RETRIES = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs preset `name` for `chatId`. `shouldStop()` ends the waiting early
// (a cancelled pass). Resolves to { ok, error } - ok: a variable was written.
export async function runIndependentWithRetry(name, chatId, shouldStop = () => false) {
    for (let attempt = 0; ; attempt++) {
        if (await runIndependentPreset(chatId, name)) return { ok: true, error: null };
        const status = await getIndependentPresetStatus(name);
        if (status?.lastOutcome === 'skipped-in-progress' && attempt < BUSY_RETRIES && !shouldStop()) {
            await sleep(BUSY_RETRY_MS);
            continue;
        }
        return { ok: false, error: status?.lastError || status?.lastOutcome || 'the run did not write anything' };
    }
}
