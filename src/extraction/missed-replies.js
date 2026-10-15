// Replies live extraction missed. Live extraction rides State Engine's
// per-message update; when that update fails (its answer could not be read,
// the connection dropped), the reply gets no memories and nothing tells
// Archivist so. So when a NEW reply arrives, the few replies before it are
// checked: one still without memories missed its extraction and is read
// again through the catch-up preset (reextractMessage()), in the background.
// Each reply is tried once at most - one with nothing worth remembering
// stays without memories - and the ones tried are kept in the chat's
// registry entry (liveRetried: [source message id]).

import { LOG_PREFIX } from '../constants.js';
import { getSettings } from '../settings.js';
import { getAllMemories } from '../memory/archivist.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, updateChatEntry } from '../memory/registry.js';
import { sourceMessageId, isStoryReply, lastReplyIndex } from './messages.js';
import { reextractMessage } from './catch-up.js';

// How many replies before the newest are checked, and how many tried ones
// a chat remembers.
export const MISSED_WINDOW = 5;
export const MAX_RETRIED_KEPT = 100;

// The indexes of `chat`'s replies, among the MISSED_WINDOW before the
// newest, that have no memory in `records` and were not tried before
// (`retried`: source message ids). Oldest first.
export function missedReplies(chat, records, chatId, retried = new Set()) {
    const covered = new Set((records ?? []).map((r) => r.source_message_id));
    const out = [];
    let checked = 0;
    for (let i = lastReplyIndex(chat) - 1; i >= 0 && checked < MISSED_WINDOW; i--) {
        if (!isStoryReply(chat[i]) || !String(chat[i].mes ?? '').trim()) continue;
        checked++;
        const id = sourceMessageId(chatId, i, chat[i]);
        if (!covered.has(id) && !retried.has(id)) out.push(i);
    }
    return out.reverse();
}

let running = Promise.resolve();

// Re-extracts the open chat's missed replies (see above), one after the
// other. Resolves when done; never throws.
export function retryMissedReplies() {
    running = running.then(async () => {
        try {
            const ref = getCurrentChatRef();
            if (!ref || !getSettings().enabled) return;
            const chatKey = chatKeyFor(ref);
            const entry = getChatEntry(chatKey);
            if (!entry) return;
            const chat = [...(SillyTavern.getContext().chat ?? [])];
            const retried = new Set(Array.isArray(entry.liveRetried) ? entry.liveRetried : []);
            const missed = missedReplies(chat, await getAllMemories(chatKey), ref.chatId, retried);
            if (missed.length === 0) return;
            for (const i of missed) retried.add(sourceMessageId(ref.chatId, i, chat[i]));
            updateChatEntry(chatKey, { liveRetried: [...retried].slice(-MAX_RETRIED_KEPT) });
            for (const i of missed) {
                try {
                    const added = await reextractMessage(ref, chat, i);
                    console.info(LOG_PREFIX, `message #${i} had no memories (its update failed?) - read it again: ${added.length} ${added.length === 1 ? 'memory' : 'memories'}`);
                } catch (err) {
                    console.warn(LOG_PREFIX, `message #${i} had no memories and could not be read again - catch-up can fill it in`, err);
                }
            }
        } catch (err) {
            console.warn(LOG_PREFIX, 'could not check for replies live extraction missed', err);
        }
    });
    return running;
}
