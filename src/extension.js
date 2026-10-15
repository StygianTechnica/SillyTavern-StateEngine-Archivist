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
import { loadCurrentChat, linkObjectMentions } from './memory/archivist.js';
import { getCurrentChatRef, chatKeyFor } from './memory/registry.js';
import { mentionMatcherFor } from './memory/object-mentions.js';
import { exposeArchivistApi } from './public-api.js';
import { startLiveExtraction } from './extraction/live.js';
import { addSettingsDrawer } from './ui/settings-drawer.js';
import { startChatLifecycle } from './memory/chat-lifecycle.js';
import { startMessageSync } from './memory/message-sync.js';
import { startCompiler } from './compiler/compiler.js';
import { startCompileRetry } from './ui/compile-retry.js';
import { startPhraseTics } from './compiler/phrase-tic-tracker.js';
import { startPromptContext, CONTEXT_CAPABILITIES, CONTEXT_VARIABLE_NAMES } from './context/prompt-sync.js';

// What Archivist provides to other extensions (see docs/architecture.md,
// "Capabilities"): memory.store - it stores State Engine's extracted
// memory; memory.query - the query APIs in src/public-api.js;
// curator.inject:<variable> - each prompt-context block Curator can inject
// (src/context/).
const CAPABILITIES = ['memory.store', 'memory.query', ...CONTEXT_CAPABILITIES];

// Starts the memory core: loads the open chat's memory and indexes, keeps
// them in step with chat changes, and publishes the query API.
// Links the open chat's memories to the objects their text names - objects
// made since a memory was stored included. Never throws.
async function linkOpenChatMentions() {
    try {
        const ref = getCurrentChatRef();
        if (!ref) return;
        const linked = await linkObjectMentions(chatKeyFor(ref), await mentionMatcherFor(ref.chatId));
        if (linked) console.info(LOG_PREFIX, `linked ${linked} ${linked === 1 ? 'memory' : 'memories'} to the objects ${linked === 1 ? 'it names' : 'they name'}`);
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not link memories to the objects they name', err);
    }
}

async function startMemoryCore() {
    getSettings();
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(eventTypes.CHAT_CHANGED, () => void loadCurrentChat().then(linkOpenChatMentions));
    startChatLifecycle();
    await loadCurrentChat();
    void linkOpenChatMentions();
    // After the first load, so its CHAT_CHANGED listener runs after the
    // memory core's own (which reloads the chat first).
    startMessageSync();
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
            variables: CONTEXT_VARIABLE_NAMES,
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
    try {
        startCompiler();
        startCompileRetry();
        startPhraseTics();
    } catch (err) {
        console.error(`${LOG_PREFIX} the compiler failed to start.`, err);
    }
    try {
        startPromptContext();
    } catch (err) {
        console.error(`${LOG_PREFIX} the prompt context for Curator failed to start.`, err);
    }
    // The drawer shows live extraction's state - including a failure to
    // start, with its Repair button - so it is added either way.
    try {
        await addSettingsDrawer();
    } catch (err) {
        console.error(`${LOG_PREFIX} the settings drawer failed to load.`, err);
    }
}
