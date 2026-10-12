// Thin wrappers around the State Engine Object API. See the State Engine
// API Reference, "Object API".
//
// Archivist never creates or changes objects on its own (spec section 8) -
// it only looks up the ids of objects a memory names. The one write here,
// addObjectAlias(), runs only when the user clicks a suggested alias in the
// memory browser (src/compiler/entity-link.js aliasSuggestions).

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

// Every object of `type` a chat sees - its own and its setting's - or [].
export async function listObjects(chatId, type) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.listObjects(EXTENSION_ID, instanceId, chatId, type) ?? [];
}

// One object by id, as seen from a chat (its own or its setting's), or null.
export async function getObject(chatId, id) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.getObject(EXTENSION_ID, instanceId, chatId, id) ?? null;
}

// Adds `alias` to object `id` (as the chat sees it). The user's action only.
// Resolves to the updated object, or null when State Engine refused.
export async function addObjectAlias(chatId, id, alias) {
    const { stateEngine, instanceId } = await getStateEngine();
    return stateEngine.addObjectAlias(EXTENSION_ID, instanceId, chatId, id, alias) ?? null;
}
