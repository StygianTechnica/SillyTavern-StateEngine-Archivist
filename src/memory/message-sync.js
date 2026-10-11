// Keeping the open chat's memories attached to the messages they came
// from, as those messages change - so a regenerated or deleted reply takes
// its memories with it, without the user cleaning up in the memory browser.
// What happens to each memory is decided by src/memory/message-sync-plan.js
// (send_date identifies one message and swipe):
//
//   regenerate          SillyTavern deletes the reply   -> its memories removed;
//                                                         the new reply's are
//                                                         stored as usual
//   swipe               another swipe is shown           -> the old swipe's
//                                                         memories HIDDEN, kept
//                                                         for swiping back
//   delete a swipe      -> its memories removed
//   delete a message    -> its memories removed; later ones re-indexed
//   edit a message      -> its memories removed and, while Archivist is
//                          enabled, the message extracted again (catch-up's
//                          preset) - only when its text really changed
//
// Every change is applied to the open chat only, one at a time, after its
// memory has loaded.

import { LOG_PREFIX } from '../constants.js';
import { getSettings } from '../settings.js';
import { getCurrentChatRef, chatKeyFor } from './registry.js';
import { whenOpenChatLoaded, getOpenChatRecords, applyMessageSync } from './archivist.js';
import { planMessageSync, memoriesOfMessage } from './message-sync-plan.js';
import { isUnchangedSinceExtraction } from './message-fingerprints.js';
import { reextractMessage } from '../extraction/catch-up.js';

let queue = Promise.resolve();

// Runs `task` after every earlier one. Never throws.
function schedule(task) {
    queue = queue.then(task).catch((err) => console.warn(LOG_PREFIX, 'could not keep memories in step with the chat', err));
    return queue;
}

// The open chat - { ref, chatKey, records, chat } - once its memory has
// loaded, or null when the chat and the loaded memory don't match (a chat
// switch in progress) or there is nothing to work with.
async function openChat() {
    await whenOpenChatLoaded();
    const ref = getCurrentChatRef();
    if (!ref) return null;
    const { chatKey, records } = getOpenChatRecords();
    if (chatKey !== chatKeyFor(ref)) return null;
    const chat = SillyTavern.getContext().chat;
    if (!Array.isArray(chat)) return null;
    // An empty chat array while memories exist: not loaded yet, never "every
    // message was deleted".
    if (chat.length === 0 && records.length > 0) return null;
    return { ref, chatKey, records, chat };
}

// Matches every memory of the open chat to the messages as they are now.
export function syncOpenChat() {
    return schedule(async () => {
        const open = await openChat();
        if (!open) return;
        const plan = planMessageSync(open.records, open.chat, open.ref.chatId);
        if (await applyMessageSync(open.chatKey, plan) && plan.remove.length) {
            console.info(LOG_PREFIX, `removed ${plan.remove.length} ${plan.remove.length === 1 ? 'memory' : 'memories'} of messages no longer in the chat`);
        }
    });
}

// The user edited the message at `index`: its memories go, and - while
// Archivist is enabled - it is extracted again. Nothing happens when the
// text didn't change, or the message had no memories.
export function onMessageEdited(index) {
    return schedule(async () => {
        const open = await openChat();
        const i = Number(index);
        if (!open || !Number.isInteger(i) || !open.chat[i]) return;
        const stale = memoriesOfMessage(open.records, open.chat, i);
        if (stale.length === 0 || isUnchangedSinceExtraction(open.ref.chatId, open.chat[i]) === true) return;

        await applyMessageSync(open.chatKey, { ...planMessageSync(open.records, open.chat, open.ref.chatId), remove: stale });
        console.info(LOG_PREFIX, `message #${i} was edited - removed its ${stale.length} ${stale.length === 1 ? 'memory' : 'memories'}`);
        if (!getSettings().enabled) return;
        try {
            const added = await reextractMessage(open.ref, open.chat, i);
            console.info(LOG_PREFIX, `message #${i} re-extracted: ${added.length} ${added.length === 1 ? 'memory' : 'memories'}`);
        } catch (err) {
            console.warn(LOG_PREFIX, `message #${i} could not be re-extracted - run catch-up to fill it in`, err);
        }
    });
}

// Starts following SillyTavern's message events.
export function startMessageSync() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    const resync = () => void syncOpenChat();
    for (const name of ['MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'CHAT_CHANGED']) {
        if (eventTypes[name]) eventSource.on(eventTypes[name], resync);
    }
    if (eventTypes.MESSAGE_EDITED) eventSource.on(eventTypes.MESSAGE_EDITED, (index) => void onMessageEdited(index));
}
