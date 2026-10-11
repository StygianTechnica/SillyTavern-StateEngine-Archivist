// Thin, READ-ONLY wrappers around the State Engine Object API. Archivist
// never creates or changes objects (spec section 8) - it only looks up
// the ids of objects a memory names. See the State Engine API Reference,
// "Object API".

import { getStateEngine } from './state-engine.js';
import { EXTENSION_ID } from '../constants.js';

// The object type ids (character, location, faction, ...).
export async function listObjectTypeIds() {
    const { stateEngine } = await getStateEngine();
    return stateEngine.listObjectTypes().map((type) => type.id);
}

// The chat's (or its setting's) object of `type` with this name or alias,
// or null. Matching ignores case, quotes and a trailing possessive.
export async function getObjectByAlias(chatId, type, name) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.getObjectByAlias(EXTENSION_ID, instanceId, chatId, type, name) ?? null;
}
