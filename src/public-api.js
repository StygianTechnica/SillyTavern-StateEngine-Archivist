// Archivist's public query API, for other extensions (Scenario Builder,
// Pretty Panels). Read-only by design: nothing here writes memory.
//
// Reach it either way:
//   - window.StateEngineArchivist, set once Archivist has initialized
//     (also the signal that Archivist is installed, enabled and ready);
//   - an ES module import of this file.
//
//   getMemoriesForEntity(entity_id) -> memory_record[]           (open chat)
//   getMemoriesBySubtype(subtype)   -> memory_record[]           (open chat)
//   getAllMemories(chat_id?)        -> Promise<memory_record[]>  (any chat)
//   MEMORIES_CHANGED_EVENT          SillyTavern event name, payload { chatId, chatKey }
//   getCompiledMemory(chat_id?)     -> Promise<compiled | null>          (any chat)
//   COMPILED_CHANGED_EVENT          after a compile, payload { chatId, chatKey }
//   getEntityDossier(entity, chat_id?) -> Promise<dossier | null>        (any chat)
//   getRelationship(from, to, chat_id?) -> Promise<{ forward, backward } | null>
//   getPhraseTics(chat_id?)         -> phrase_tics: [{ phrase, count, last_used }]
//   PHRASE_TICS_CHANGED_EVENT       after they change, payload { chatId, chatKey }
//
// See src/memory/archivist.js for each call's exact behavior,
// src/memory/schema.js for the record shape and src/compiler/dossier.js for
// the dossier.

import { getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT } from './memory/archivist.js';
import { getCompiledMemory, COMPILED_CHANGED_EVENT } from './compiler/compiler.js';
import { getEntityDossier, getRelationship } from './compiler/dossier.js';
import { resolveChatKey } from './compiler/compiler.js';
import { getChatPhraseTics, PHRASE_TICS_CHANGED_EVENT } from './compiler/phrase-tic-tracker.js';

// The chat's phrase tics (src/compiler/phrase-tics.js) - for Scenario
// Builder: [{ phrase, count, last_used }], a count of 2 or more meaning in
// use right now. [] when the chat has none.
export function getPhraseTics(chatId) {
    const chatKey = resolveChatKey(chatId);
    return chatKey ? getChatPhraseTics(chatKey).map(({ phrase, count, last_used: lastUsed }) => ({ phrase, count, last_used: lastUsed })) : [];
}

export {
    getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT, getCompiledMemory, COMPILED_CHANGED_EVENT, getEntityDossier, getRelationship,
    PHRASE_TICS_CHANGED_EVENT,
};

export const archivistApi = Object.freeze({
    getMemoriesForEntity,
    getMemoriesBySubtype,
    getAllMemories,
    MEMORIES_CHANGED_EVENT,
    getCompiledMemory,
    COMPILED_CHANGED_EVENT,
    getEntityDossier,
    getRelationship,
    getPhraseTics,
    PHRASE_TICS_CHANGED_EVENT,
});

export function exposeArchivistApi() {
    window.StateEngineArchivist = archivistApi;
}
