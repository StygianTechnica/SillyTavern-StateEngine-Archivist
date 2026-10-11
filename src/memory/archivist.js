// Archivist's memory core: holds the open chat's records and indexes, adds
// new records, and answers the three query APIs (spec section 7).
//
// - loadCurrentChat()   reads the open chat's memories.json and rebuilds
//                       the indexes. Called at startup and on every chat
//                       change (src/extension.js).
// - addMemoryRecords()  appends records to a chat's file and, when that
//                       chat is open, rebuilds the indexes. Live extraction
//                       and catch-up both store through this.
// - deleteMemoryRecords() / deleteChatMemories()  the user's own deletions,
//                       from the memory browser (src/ui/memory-browser.js) -
//                       the only way a stored memory is ever removed.
// - moveChatMemories()  follows a renamed chat (src/memory/chat-lifecycle.js).
// - applyMessageSync()  keeps the open chat's memories matched to its
//                       messages as they change - regenerated, swiped,
//                       edited, deleted (src/memory/message-sync.js).
//
// HIDDEN memories: those from a swipe that isn't the one shown. They stay
// stored (swiping back shows them again) but are left out of the indexes
// and of everything the query APIs return for the open chat.
// Indexes exist only for the open chat. getMemoriesForEntity() and
// getMemoriesBySubtype() therefore answer for the open chat, synchronously;
// getAllMemories() can read any chat, so it is async.
//
// Every record handed out is a copy - a caller changing one cannot change
// Archivist's state or what is on disk.

import { LOG_PREFIX } from '../constants.js';
import { createMemoryRecord, isMemoryRecord } from './schema.js';
import { buildIndexes } from './indexes.js';
import { readMemoryFileQueued, updateMemoryFile, deleteMemoryFile } from './storage.js';
import {
    getCurrentChatRef, chatKeyFor, getChatEntry, ensureChatEntry, findChatEntriesById, updateChatEntry, removeChatEntry, moveChatEntry,
} from './registry.js';

// Emitted on SillyTavern's event bus after a chat's stored memory changes,
// with { chatId, chatKey }. Re-read through the query APIs on receipt.
export const MEMORIES_CHANGED_EVENT = 'archivist_memories_changed';

const EMPTY_INDEXES = Object.freeze({ memoryByEntity: Object.create(null), memoryBySubtype: Object.create(null) });

const state = {
    ref: null,        // the open chat (getCurrentChatRef()), or null
    chatKey: null,
    all: [],          // the open chat's valid records, hidden ones included
    records: [],      // ...without the hidden ones - what the APIs answer from
    hidden: new Set(), // ids of the hidden records (see above)
    indexes: EMPTY_INDEXES,
    loadToken: 0,     // guards against an older load finishing after a newer one
    loading: Promise.resolve(), // the latest loadCurrentChat() in progress
};

const copy = (records) => records.map((record) => structuredClone(record));

function setRecords(records) {
    state.all = records.filter(isMemoryRecord);
    state.records = state.all.filter((record) => !state.hidden.has(record.id));
    state.indexes = buildIndexes(state.records);
}

function emitChanged(chatKey, chatId) {
    try {
        const { eventSource } = SillyTavern.getContext();
        void eventSource?.emit?.(MEMORIES_CHANGED_EVENT, { chatId, chatKey });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not announce a memory change', err);
    }
}

// Loads the open chat's records and rebuilds both indexes. A chat with no
// registry entry has no file yet, so it starts empty without a request.
export function loadCurrentChat() {
    state.loading = loadOpenChat();
    return state.loading;
}

async function loadOpenChat() {
    const token = ++state.loadToken;
    const ref = getCurrentChatRef();
    const chatKey = ref ? chatKeyFor(ref) : null;
    state.ref = ref;
    state.chatKey = chatKey;
    state.hidden = new Set();
    setRecords([]);

    const entry = chatKey ? getChatEntry(chatKey) : null;
    if (!entry) return;

    try {
        const records = await readMemoryFileQueued(entry.fileName);
        if (token !== state.loadToken) return;
        setRecords(records);
    } catch (err) {
        console.warn(LOG_PREFIX, `could not load memories for chat "${ref.chatId}"`, err);
    }
}

// Appends records to `ref`'s chat (see getCurrentChatRef() for its shape;
// the chat need not be the open one). Each item is passed through
// createMemoryRecord() with chat_id forced to ref.chatId; items it rejects
// are skipped. Resolves to copies of the records stored ([] when none).
// Throws if the chat's file could not be read or written - nothing is
// lost from the file in that case.
export async function addMemoryRecords(ref, items) {
    const records = (Array.isArray(items) ? items : [])
        .map((item) => createMemoryRecord({ ...item, chat_id: ref.chatId }))
        .filter(Boolean);
    if (records.length === 0) return [];

    const { chatKey, entry } = ensureChatEntry(ref);
    const stored = await updateMemoryFile(entry.fileName, (existing) => existing.concat(records));

    updateChatEntry(chatKey, { recordCount: stored.filter(isMemoryRecord).length, updatedAt: new Date().toISOString() });
    if (chatKey === state.chatKey) setRecords(stored);
    emitChanged(chatKey, ref.chatId);
    return copy(records);
}

// API 1 - every record in the open chat that names `entityId`.
export function getMemoriesForEntity(entityId) {
    return copy(state.indexes.memoryByEntity[entityId] ?? []);
}

// API 2 - every record in the open chat with this subtype.
export function getMemoriesBySubtype(subtype) {
    return copy(state.indexes.memoryBySubtype[subtype] ?? []);
}

// API 3 - every record stored for a chat, in stored order. `chatId` is a
// SillyTavern chat id (or a registry chat key, for the memory browser);
// omitted, it means the open chat. When several characters have a chat
// with that id, the open chat wins, then the most recently updated one.
// Resolves to [] for a chat with no stored memory, or one whose file
// cannot be read.
export async function getAllMemories(chatId) {
    if (chatId === undefined || chatId === null || chatId === state.chatKey || (state.ref && chatId === state.ref.chatId)) {
        await state.loading;
        return copy(state.records);
    }

    const byKey = getChatEntry(chatId);
    const entry = byKey ?? findChatEntriesById(chatId)
        .map(({ entry: candidate }) => candidate)
        .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0];
    if (!entry) return [];

    try {
        return copy((await readMemoryFileQueued(entry.fileName)).filter(isMemoryRecord));
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read memories for chat "${chatId}"`, err);
        return [];
    }
}

// Deletes the records with these ids from a chat (by registry chat key).
// Resolves to how many were removed. Throws if the file could not be
// read or written - nothing is removed then.
export async function deleteMemoryRecords(chatKey, ids) {
    const entry = getChatEntry(chatKey);
    const doomed = new Set(Array.isArray(ids) ? ids : []);
    if (!entry || doomed.size === 0) return 0;

    let removed = 0;
    const stored = await updateMemoryFile(entry.fileName, (existing) => existing.filter((record) => {
        const drop = doomed.has(record?.id);
        if (drop) removed++;
        return !drop;
    }));
    updateChatEntry(chatKey, { recordCount: stored.filter(isMemoryRecord).length, updatedAt: new Date().toISOString() });
    if (chatKey === state.chatKey) setRecords(stored);
    emitChanged(chatKey, entry.chatId);
    return removed;
}

// Deletes everything stored for a chat: its file and its registry entry.
// Resolves to true, or false when the chat has nothing stored. Throws if
// the file could not be deleted - the entry is kept then.
export async function deleteChatMemories(chatKey) {
    const entry = getChatEntry(chatKey);
    if (!entry) return false;
    await deleteMemoryFile(entry.fileName);
    removeChatEntry(chatKey);
    if (chatKey === state.chatKey) setRecords([]);
    emitChanged(chatKey, entry.chatId);
    return true;
}

// Moves a chat's memories to its new identity after a rename: the registry
// entry, and chat_id in every record. `newRef` is the renamed chat (see
// getCurrentChatRef() for its shape). Resolves to true when moved; false
// when nothing was stored under `oldKey` or the new name already has
// memories of its own (both are then left as they are).
export async function moveChatMemories(oldKey, newRef) {
    const entry = getChatEntry(oldKey);
    const newKey = chatKeyFor(newRef);
    if (!entry || newKey === oldKey) return false;
    if (getChatEntry(newKey)) {
        console.warn(LOG_PREFIX, `chat renamed to "${newRef.chatId}", which already has memories - the old memories stay under "${entry.chatId}"`);
        return false;
    }

    await updateMemoryFile(entry.fileName, (existing) => existing.map((record) => (isMemoryRecord(record) ? { ...record, chat_id: newRef.chatId } : record)));
    moveChatEntry(oldKey, newKey, { chatId: newRef.chatId, displayName: newRef.displayName || entry.displayName });
    if (state.chatKey === newKey || state.chatKey === oldKey) await loadCurrentChat();
    emitChanged(newKey, newRef.chatId);
    return true;
}

// Resolves once the open chat's memory has finished loading.
export function whenOpenChatLoaded() {
    return state.loading;
}

// The open chat's key and ALL its records (hidden ones included), as
// copies - what src/memory/message-sync.js plans from.
export function getOpenChatRecords() {
    return { chatKey: state.chatKey, chatId: state.ref?.chatId ?? null, records: copy(state.all) };
}

// Applies a plan from planMessageSync() (src/memory/message-sync-plan.js)
// to the open chat `chatKey`: deletes `remove`, rewrites the source of the
// ones in `repoint`, and hides `hidden` (every other record is shown).
// Does nothing when `chatKey` is no longer the open chat. Resolves to
// whether anything changed. Throws if the file could not be written -
// nothing changes then.
export async function applyMessageSync(chatKey, { remove = [], repoint = new Map(), hidden = [] } = {}) {
    if (!chatKey || chatKey !== state.chatKey) return false;
    const drop = new Set(remove);
    const entry = getChatEntry(chatKey);
    let records = state.all;
    let fileChanged = false;

    if (entry && (drop.size > 0 || repoint.size > 0)) {
        records = await updateMemoryFile(entry.fileName, (existing) => existing
            .filter((record) => {
                if (!drop.has(record?.id)) return true;
                fileChanged = true;
                return false;
            })
            .map((record) => {
                if (!repoint.has(record?.id)) return record;
                fileChanged = true;
                return { ...record, source_message_id: repoint.get(record.id) };
            }));
        if (fileChanged) updateChatEntry(chatKey, { recordCount: records.filter(isMemoryRecord).length, updatedAt: new Date().toISOString() });
        // The user switched chats while the file was written: the file is
        // right; there is nothing open to update.
        if (chatKey !== state.chatKey) return fileChanged;
    }

    const nextHidden = new Set(hidden.filter((id) => !drop.has(id)));
    const hiddenChanged = nextHidden.size !== state.hidden.size || [...nextHidden].some((id) => !state.hidden.has(id));
    if (!fileChanged && !hiddenChanged) return false;
    state.hidden = nextHidden;
    setRecords(records);
    emitChanged(chatKey, state.ref?.chatId ?? entry?.chatId);
    return true;
}
