// Thin wrappers around the State Engine Variable and Variable Value APIs,
// always as Archivist and always in Archivist's own namespace. No
// additional logic belongs in this file - see the State Engine API
// Reference, "Variable API" and "Variable Value API".

import { getStateEngine } from './state-engine.js';
import { EXTENSION_ID, NAMESPACE } from '../constants.js';

const ref = (presetName, variableName) => ({ namespace: NAMESPACE, presetName, variableName });

// Fired by State Engine on SillyTavern's event bus after any value write,
// coalesced per chat; the payload is the chatId (null = possibly any chat).
export const VARIABLES_CHANGED_EVENT = 'state_engine_variables_changed';

export const qualifiedName = (variableName) => `${NAMESPACE}__${variableName}`;

// The definition of `variableName` in `presetName`, or null.
export async function getVariable(presetName, variableName) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.getVariable(EXTENSION_ID, instanceId, ref(presetName, variableName)) ?? null;
}

// `def` without namespace/presetName/name, which come from the arguments.
export async function createVariable(presetName, variableName, def) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.createVariable(EXTENSION_ID, instanceId, { ...def, namespace: NAMESPACE, presetName, name: variableName });
}

export async function updateVariable(presetName, variableName, patch) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.updateVariable(EXTENSION_ID, instanceId, ref(presetName, variableName), patch);
}

// The variable's value in a chat, or undefined if the chat holds none.
export async function getVariableValue(chatId, variableName) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.getVariableValue(EXTENSION_ID, instanceId, chatId, qualifiedName(variableName))?.value;
}

export async function setVariableValue(chatId, presetName, variableName, value) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.setVariableValue(EXTENSION_ID, instanceId, chatId, ref(presetName, variableName), value);
}
