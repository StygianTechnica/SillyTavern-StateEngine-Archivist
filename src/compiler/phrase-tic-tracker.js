// Keeps each chat's phrase tics (src/compiler/phrase-tics.js) - found by the
// compiler, then followed reply by reply: a known tic used again gains a
// count, one unused for a while loses one and goes. Stored in the chat's
// registry entry (registry.js) as
//   phraseTics: { tics: [tic], counter: AI replies seen, lastReply: the
//                 source id of the last one counted }
// so it costs no file writes and is never caught up in a compile's own
// save. Announced on SillyTavern's event bus (PHRASE_TICS_CHANGED_EVENT),
// for the prompt block (src/context/) and the memory browser.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, updateChatEntry } from '../memory/registry.js';
import { isStoryReply, lastReplyIndex, sourceMessageId } from '../extraction/messages.js';
import { TIC_WINDOW, findCandidates, addFound, updateForReply } from './phrase-tics.js';

export const PHRASE_TICS_CHANGED_EVENT = 'archivist_phrase_tics_changed';

// AI replies without a tic before it loses a count (settings.phraseTicFadeAfter).
export const DEFAULT_FADE_AFTER = 10;

function stateOf(chatKey) {
    const saved = getChatEntry(chatKey)?.phraseTics;
    return {
        tics: Array.isArray(saved?.tics) ? saved.tics : [],
        counter: Number.isInteger(saved?.counter) ? saved.counter : 0,
        lastReply: saved?.lastReply ?? null,
    };
}

function save(chatKey, state) {
    updateChatEntry(chatKey, { phraseTics: state });
    saveSettings();
    try {
        void SillyTavern.getContext().eventSource?.emit?.(PHRASE_TICS_CHANGED_EVENT, { chatId: getChatEntry(chatKey)?.chatId, chatKey });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not announce the phrase tics', err);
    }
}

const enabled = () => getSettings().trackPhraseTics !== false;

function openKey() {
    const ref = getCurrentChatRef();
    return ref ? chatKeyFor(ref) : null;
}

// A chat's tics (a registry chat key; omitted: the open chat), copied:
// [{ phrase, key, count, last_used, ... }].
export function getChatPhraseTics(chatKey = openKey()) {
    return chatKey && getChatEntry(chatKey) ? stateOf(chatKey).tics.map((t) => ({ ...t })) : [];
}

// The candidates for the open chat's compile: the word sequences repeated
// across its latest TIC_WINDOW AI replies ([] when tracking is off).
export function currentCandidates() {
    if (!enabled()) return [];
    const chat = SillyTavern.getContext().chat ?? [];
    const replies = [];
    for (let i = chat.length - 1; i >= 0 && replies.length < TIC_WINDOW; i--) {
        if (isStoryReply(chat[i]) && typeof chat[i].mes === 'string') replies.unshift({ index: i, text: chat[i].mes });
    }
    return findCandidates(replies);
}

// The tics the compiler found ([{ key, phrase }]) added to the chat's list.
export function recordFoundTics(chatKey, found) {
    if (!found?.length || !getChatEntry(chatKey)) return;
    const state = stateOf(chatKey);
    const tics = addFound(state.tics, found, { now: new Date().toISOString(), counter: state.counter });
    if (tics.length !== state.tics.length) save(chatKey, { ...state, tics });
}

// The user removes a tic (the memory browser). The compiler may find it
// again later, at count 1 - nothing is ever banned for good.
export function removePhraseTic(chatKey, key) {
    const state = stateOf(chatKey);
    const tics = state.tics.filter((t) => t.key !== key);
    if (tics.length !== state.tics.length) save(chatKey, { ...state, tics });
}

// Counts the open chat's newest AI reply, once: tics it uses gain, the
// others fade (updateForReply). Never throws.
export function countNewestReply() {
    try {
        const ref = getCurrentChatRef();
        if (!ref || !enabled() || !getSettings().enabled) return;
        const chatKey = chatKeyFor(ref);
        if (!getChatEntry(chatKey)) return;
        const chat = SillyTavern.getContext().chat ?? [];
        const index = lastReplyIndex(chat);
        if (index === -1) return;
        const id = sourceMessageId(ref.chatId, index, chat[index]);
        const state = stateOf(chatKey);
        if (state.lastReply === id) return;
        const counter = state.counter + 1;
        const fadeAfter = Math.max(1, Number(getSettings().phraseTicFadeAfter) || DEFAULT_FADE_AFTER);
        const tics = updateForReply(state.tics, chat[index].mes, { now: new Date().toISOString(), counter, fadeAfter });
        save(chatKey, { tics, counter, lastReply: id });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not count phrase tics', err);
    }
}

export function startPhraseTics() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, () => countNewestReply());
}
