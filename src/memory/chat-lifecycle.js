// Keeping stored memory in step with SillyTavern's chats:
//
// - a chat is RENAMED: its memories follow it (moveChatMemories()) - a
//   SillyTavern chat id is its file name, so without this the memories
//   would be stranded under the old name;
// - a chat is DELETED: its memories are KEPT. Deleting them is the user's
//   call, made in the memory browser, where the chat shows as missing. A
//   notice says so.
//
// Event payloads (SillyTavern public/script.js, group-chats.js):
//   CHAT_RENAMED        { avatarId, groupId, oldFileName, newFileName } - file
//                       names with ".jsonl"
//   CHAT_DELETED        the deleted solo chat's name
//   GROUP_CHAT_DELETED  the deleted group chat's id

import { LOG_PREFIX } from '../constants.js';
import { moveChatMemories } from './archivist.js';
import { findChatEntriesById } from './registry.js';

const stripExtension = (name) => String(name ?? '').replace(/\.jsonl$/i, '');

function displayNameFor(context, { avatarId, groupId }) {
    if (groupId) return (context.groups || []).find((g) => g.id === groupId)?.name || '';
    return (context.characters || []).find((c) => c.avatar === avatarId)?.name || '';
}

// CHAT_RENAMED: moves the old chat's memories to the new name. Never throws.
export async function onChatRenamed(data) {
    try {
        const oldId = stripExtension(data?.oldFileName);
        const newId = stripExtension(data?.newFileName);
        const groupId = data?.groupId ? String(data.groupId) : null;
        const avatarId = groupId ? null : (data?.avatarId ?? null);
        if (!oldId || !newId || oldId === newId || (!groupId && !avatarId)) return;

        const context = SillyTavern.getContext();
        const oldKey = groupId ? `group:${groupId}:${oldId}` : `char:${avatarId}:${oldId}`;
        await moveChatMemories(oldKey, {
            chatId: newId, characterAvatar: avatarId, groupId, displayName: displayNameFor(context, { avatarId, groupId }),
        });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not move memories to the renamed chat', err);
    }
}

// CHAT_DELETED / GROUP_CHAT_DELETED: tells the user their memories were kept.
export function onChatDeleted(chatId) {
    const id = stripExtension(chatId);
    const stored = findChatEntriesById(id).reduce((sum, { entry }) => sum + (entry.recordCount || 0), 0);
    if (stored === 0) return;
    try {
        toastr.info(`${stored} ${stored === 1 ? 'memory was' : 'memories were'} kept for the deleted chat "${id}". Review or delete them in Archivist's memory browser.`, 'Archivist');
    } catch {
        // No toast available - the memory browser still shows the chat as missing.
    }
}

// Starts following chat renames and deletions.
export function startChatLifecycle() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    if (eventTypes.CHAT_RENAMED) eventSource.on(eventTypes.CHAT_RENAMED, (data) => void onChatRenamed(data));
    if (eventTypes.CHAT_DELETED) eventSource.on(eventTypes.CHAT_DELETED, onChatDeleted);
    if (eventTypes.GROUP_CHAT_DELETED) eventSource.on(eventTypes.GROUP_CHAT_DELETED, onChatDeleted);
}
