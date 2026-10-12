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
//
// See src/memory/archivist.js for each call's exact behavior,
// src/memory/schema.js for the record shape and src/compiler/dossier.js for
// the dossier.

import { getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT } from './memory/archivist.js';
import { getCompiledMemory, COMPILED_CHANGED_EVENT } from './compiler/compiler.js';
import { getEntityDossier, getRelationship } from './compiler/dossier.js';

export {
    getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT, getCompiledMemory, COMPILED_CHANGED_EVENT, getEntityDossier, getRelationship,
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
});

export function exposeArchivistApi() {
    window.StateEngineArchivist = archivistApi;
}
