// Running one of Archivist's independent presets (catch-up, the compiler)
// through State Engine. State Engine queues the run behind whatever else is
// using the same connection (its main update, another preset's run) and
// resolves when it has run, so there is nothing to wait out here.

import { runIndependentPreset, getIndependentPresetStatus } from '../api/independent-presets.js';

// Runs preset `name` for `chatId`. Resolves to { ok, error, response } -
// ok: a variable was written; response: what the model wrote when it could
// not be read (State Engine keeps it for this session), else null.
export async function runIndependent(name, chatId) {
    if (await runIndependentPreset(chatId, name)) return { ok: true, error: null, response: null };
    const status = await getIndependentPresetStatus(name);
    return { ok: false, error: status?.lastError || status?.lastOutcome || 'the run did not write anything', response: status?.lastResponse ?? null };
}
