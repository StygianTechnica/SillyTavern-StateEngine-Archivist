// Archivist bootstrap: confirms the State Engine dependency is actually
// present, then claims Archivist's namespace, registers it for discovery,
// and declares its capabilities - the things every State Engine extension
// must do before it can create presets, variables, or anything else.
// Everything Archivist itself does (memory storage, extraction, the
// drawer) is started from here once that has succeeded.

import { ensureStateEngineAvailable, warnStateEngineMissing } from './api/dependency-check.js';
import { claimNamespace } from './api/namespace.js';
import { registerWithStateEngine } from './api/registration.js';
import { declareCapabilities } from './api/capabilities.js';
import { EXTENSION_ID, NAMESPACE, LOG_PREFIX } from './constants.js';
import { getSettings } from './settings.js';
import { loadCurrentChat } from './memory/archivist.js';
import { exposeArchivistApi } from './public-api.js';
import { startLiveExtraction } from './extraction/live.js';

// What Archivist provides to other extensions (see docs/architecture.md,
// "Capabilities"): memory.store - it stores State Engine's extracted
// memory; memory.query - the query APIs in src/public-api.js.
const CAPABILITIES = ['memory.store', 'memory.query'];

// Starts the memory core: loads the open chat's memory and indexes, keeps
// them in step with chat changes, and publishes the query API.
async function startMemoryCore() {
    getSettings();
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.CHAT_CHANGED, () => void loadCurrentChat());
    await loadCurrentChat();
    exposeArchivistApi();
}

// Called once, on load (see src/index.js). Safe to call again on a
// later page load - claimNamespace() is idempotent for the same
// EXTENSION_ID/NAMESPACE pair, and registerWithStateEngine()/
// declareCapabilities() simply replace the previous declaration with
// the same one.
//
// The dependency check runs FIRST, and gates everything else: if State
// Engine is not installed, not enabled, or its API cannot be reached,
// this shows one popup and returns - no namespace is claimed, no
// registration or capability call is ever attempted.
export async function initExtension() {
    const available = await ensureStateEngineAvailable();
    if (!available) {
        warnStateEngineMissing();
        console.warn(`${LOG_PREFIX} State Engine was not found (not installed, not enabled, or not ready) - initialization aborted.`);
        return;
    }

    try {
        await claimNamespace(EXTENSION_ID, NAMESPACE);

        await registerWithStateEngine(EXTENSION_ID, {
            namespace: NAMESPACE,
            capabilities: CAPABILITIES,
            description: 'Stores and indexes the memory records State Engine extracts from each chat, and serves them to other extensions.',
        });

        await declareCapabilities(EXTENSION_ID, CAPABILITIES);

        console.log(`${LOG_PREFIX} initialized - namespace "${NAMESPACE}" claimed.`);
    } catch (err) {
        // State Engine looked present (the check above passed) but an
        // actual call still failed - "its API cannot be reached", the
        // one failure mode ensureStateEngineAvailable() can't catch in
        // advance. Same warning, never thrown further.
        warnStateEngineMissing();
        console.warn(`${LOG_PREFIX} State Engine calls failed unexpectedly - initialization aborted.`, err);
        return;
    }

    // Archivist's own startup - a failure here is Archivist's, not State
    // Engine's, so it is logged rather than shown as the missing-dependency
    // popup. Live extraction needs the memory core; stored memory stays
    // readable even if extraction cannot start.
    try {
        await startMemoryCore();
    } catch (err) {
        console.error(`${LOG_PREFIX} memory core failed to start.`, err);
        return;
    }
    try {
        await startLiveExtraction();
    } catch (err) {
        console.error(`${LOG_PREFIX} live memory extraction failed to start.`, err);
    }
}
