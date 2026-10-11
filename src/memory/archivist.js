// Archivist's memory core: holds the open chat's records and indexes, adds
// new records, and answers the three query APIs (spec section 7).
//
// - loadCurrentChat()   reads the open chat's memories.json and rebuilds
//                       the indexes. Called at startup and on every chat
//                       change (src/extension.js).
// - addMemoryRecords()  appends records to a chat's file and, when that
//                       chat is open, rebuilds the indexes. Live extraction
//                       and catch-up both store through this.
//
// Indexes exist only for the open chat. getMemoriesForEntity() and
// getMemoriesBySubtype() therefore answer for the open chat, synchronously;
// getAllMemories() can read any chat, so it is async.
//
// Every record handed out is a copy - a caller changing one cannot change
// Archivist's state or what is on disk.

import { LOG_PREFIX } from '../constants.js';
import { createMemoryRecord, isMemoryRecord } from './schema.js';
import { buildIndexes } from './indexes.js';
import { readMemoryFileQueued, updateMemoryFile } from './storage.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, ensureChatEntry, findChatEntriesById, updateChatEntry } from './registry.js';

// Emitted on SillyTavern's event bus after a chat's stored memory changes,
// with { chatId, chatKey }. Re-read through the query APIs on receipt.
export const MEMORIES_CHANGED_EVENT = 'archivist_memories_changed';

const EMPTY_INDEXES = Object.freeze({ memoryByEntity: Object.create(null), memoryBySubtype: Object.create(null) });

const state = {
    ref: null,        // the open chat (getCurrentChatRef()), or null
    chatKey: null,
    records: [],
    indexes: EMPTY_INDEXES,
    loadToken: 0,     // guards against an older load finishing after a newer one
    loading: Promise.resolve(), // the latest loadCurrentChat() in progress
};

const copy = (records) => records.map((record) => structuredClone(record));

function setRecords(records) {
    state.records = records.filter(isMemoryRecord);
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
