// Thin wrappers around the State Engine Independent Presets API, always as
// Archivist and always in Archivist's own namespace. No additional logic
// belongs in this file - see src/extraction/catch-up.js for how catch-up
// uses them, and the State Engine API Reference, "Independent Presets API".

import { getStateEngine } from './state-engine.js';
import { EXTENSION_ID, NAMESPACE } from '../constants.js';

// `def: { name, description?, connectionProfileId?, temperature?,
// maxTokens?, promptedHeader?, promptedRules?, enabled? }`. Returns the
// created preset or null.
export async function createIndependentPreset(def) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.createIndependentPreset(EXTENSION_ID, instanceId, { ...def, namespace: NAMESPACE });
}

// Merges `config` ({ connectionProfileId?, temperature?, maxTokens?,
// promptedHeader?, promptedRules?, enabled? }) into the preset's own.
export async function configureIndependentPreset(name, config) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.configureIndependentPreset(EXTENSION_ID, instanceId, NAMESPACE, name, config);
}

// The context the next run hands the model, as-is (a string here).
export async function updateIndependentPresetContext(name, context) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.updateIndependentPresetContext(EXTENSION_ID, instanceId, NAMESPACE, name, context);
}

// Runs the preset's update now, for `chatId`. Resolves to true when a
// variable was written, false otherwise (see getIndependentPresetStatus).
export async function runIndependentPreset(chatId, name) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.runIndependentPreset(EXTENSION_ID, instanceId, chatId, { namespace: NAMESPACE, name });
}

// { enabled, contextMode, lastRunAt, lastOutcome, lastError, changedVariables } or null.
export async function getIndependentPresetStatus(name) {
    const { stateEngine } = await getStateEngine();
    return stateEngine.getIndependentPresetStatus(NAMESPACE, name);
}
