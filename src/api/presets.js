// Thin wrappers around the State Engine Preset API, always as Archivist
// and always in Archivist's own namespace. No additional logic belongs in
// this file - see src/extraction/ for how the extraction presets use them,
// and the State Engine API Reference, "Preset API".

import { getStateEngine } from './state-engine.js';
import { EXTENSION_ID, NAMESPACE } from '../constants.js';

// The preset's definition, or null if it does not exist.
export async function findPreset(name) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.listPresets(EXTENSION_ID, instanceId, NAMESPACE).find((preset) => preset.name === name) ?? null;
}

// `def: { name, description?, triggers?, showInTracker? }`. Returns the
// created preset or null.
export async function createPreset(def) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.createPreset(EXTENSION_ID, instanceId, { ...def, namespace: NAMESPACE });
}

export async function updatePreset(name, patch) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.updatePreset(EXTENSION_ID, instanceId, NAMESPACE, name, patch);
}

// Binds the preset to a chat (seeding its variables' defaults). true/false.
export async function activatePreset(chatId, name) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.activatePreset(EXTENSION_ID, instanceId, chatId, NAMESPACE, name);
}

export async function deactivatePreset(chatId, name) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.deactivatePreset(EXTENSION_ID, instanceId, chatId, NAMESPACE, name);
}
