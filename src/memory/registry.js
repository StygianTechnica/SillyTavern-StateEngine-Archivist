// The chat registry: which chats have stored memory, and which file holds
// each one's records. Kept in Archivist's settings
// (settings.chats[chatKey]) so it survives a reload and can list chats
// that are no longer open - or no longer exist - for the memory browser.
//
// A SillyTavern chat id is only the chat's file name, and two characters
// can each have a chat with the same name. A CHAT KEY therefore pairs the
// chat id with its owner - the character's avatar file or the group id -
// the same distinction State Engine's chat state records
// (characterAvatar / groupId) so it can tell chats apart:
//
//   char:<avatar>:<chatId>   a solo chat
//   group:<groupId>:<chatId> a group chat
//
// Entry: { chatId, characterAvatar, groupId, displayName, fileName,
//          recordCount, updatedAt }

import { getSettings, saveSettings } from '../settings.js';

// SillyTavern's file upload accepts only [a-zA-Z0-9_.-] in a file name
// (server: validateAssetFileName in src/endpoints/assets.js).
const FILE_PREFIX = 'archivist-memories-';
const SLUG_MAX = 48;

// A chat as Archivist identifies it: { chatId, characterAvatar, groupId,
// displayName }. Exactly one of characterAvatar/groupId is set.
export function getCurrentChatRef() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId;
    if (!chatId) return null;

    if (context.groupId) {
        const group = (context.groups || []).find((g) => g.id === context.groupId);
        return { chatId: String(chatId), characterAvatar: null, groupId: String(context.groupId), displayName: group?.name || '' };
    }
    const character = context.characters?.[context.characterId];
    if (!character?.avatar) return null;
    return { chatId: String(chatId), characterAvatar: character.avatar, groupId: null, displayName: character.name || '' };
}

export function chatKeyFor(ref) {
    return ref.groupId ? `group:${ref.groupId}:${ref.chatId}` : `char:${ref.characterAvatar}:${ref.chatId}`;
}

// 32-bit FNV-1a, as 8 hex digits - enough to keep two chats with the same
// name apart in the file name; the registry, not the name, is the source
// of truth for which file belongs to which chat.
function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function fileNameFor(chatKey, chatId) {
    const slug = String(chatId).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, SLUG_MAX) || 'chat';
    return `${FILE_PREFIX}${slug}-${hash(chatKey)}.json`;
}

export function getChatEntry(chatKey) {
    return getSettings().chats[chatKey] ?? null;
}

// Every registered chat with this chat id (more than one when different
// characters have chats with the same name).
export function findChatEntriesById(chatId) {
    return Object.entries(getSettings().chats)
        .filter(([, entry]) => entry.chatId === chatId)
        .map(([chatKey, entry]) => ({ chatKey, entry }));
}

export function listChatEntries() {
    return Object.entries(getSettings().chats).map(([chatKey, entry]) => ({ chatKey, entry }));
}

// The registry entry for `ref`, created on first use. The display name is
// refreshed whenever it is known, since characters and groups can be renamed.
export function ensureChatEntry(ref) {
    const chats = getSettings().chats;
    const chatKey = chatKeyFor(ref);
    let entry = chats[chatKey];
    if (!entry) {
        entry = {
            chatId: ref.chatId,
            characterAvatar: ref.characterAvatar ?? null,
            groupId: ref.groupId ?? null,
            displayName: ref.displayName || '',
            fileName: fileNameFor(chatKey, ref.chatId),
            recordCount: 0,
            updatedAt: null,
        };
        chats[chatKey] = entry;
        saveSettings();
    } else if (ref.displayName && entry.displayName !== ref.displayName) {
        entry.displayName = ref.displayName;
        saveSettings();
    }
    return { chatKey, entry };
}

export function updateChatEntry(chatKey, patch) {
    const entry = getSettings().chats[chatKey];
    if (!entry) return null;
    Object.assign(entry, patch);
    saveSettings();
    return entry;
}

export function removeChatEntry(chatKey) {
    const chats = getSettings().chats;
    if (!chats[chatKey]) return false;
    delete chats[chatKey];
    saveSettings();
    return true;
}

// Moves an entry to a new chat key (a renamed chat), applying `patch`.
// Refuses (false) when there is no entry under `fromKey` or one already
// exists under `toKey`. The file keeps its name - the registry, not the
// name, says which file belongs to which chat.
export function moveChatEntry(fromKey, toKey, patch = {}) {
    const chats = getSettings().chats;
    if (!chats[fromKey] || chats[toKey]) return false;
    chats[toKey] = { ...chats[fromKey], ...patch };
    delete chats[fromKey];
    saveSettings();
    return true;
}

// The file holding a chat's compiled memory (src/compiler/), next to its
// memories file - named after it, so it follows the entry through renames.
export function compiledFileFor(entry) {
    return entry.fileName.replace(/^archivist-memories-/, 'archivist-compiled-');
}
