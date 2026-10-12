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
//
// See src/memory/archivist.js for each call's exact behavior and
// src/memory/schema.js for the record shape.

import { getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT } from './memory/archivist.js';
import { getCompiledMemory, COMPILED_CHANGED_EVENT } from './compiler/compiler.js';

export { getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT, getCompiledMemory, COMPILED_CHANGED_EVENT };

export const archivistApi = Object.freeze({
    getMemoriesForEntity,
    getMemoriesBySubtype,
    getAllMemories,
    MEMORIES_CHANGED_EVENT,
    getCompiledMemory,
    COMPILED_CHANGED_EVENT,
});

export function exposeArchivistApi() {
    window.StateEngineArchivist = archivistApi;
}
