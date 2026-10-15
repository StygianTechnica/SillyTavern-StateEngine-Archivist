// Keeps the phrase tics (src/compiler/phrase-tics.js): each chat's, found at
// its compiles and followed reply by reply - a tic used again gains a count,
// one unused for a while fades to dormant but is kept, and flagged again the
// moment it comes back - and a WATCH LIST per model: the phrases that model
// is known to overuse, flagged on their first use in any chat it writes. A
// tic is the model's habit, not the story's, so what one chat found is
// caught at once in the next, as long as the same model writes it.
//
// A chat's tics are stored in its registry entry (registry.js) as
//   phraseTics: { rules, tics: [tic], counter: AI replies seen,
//                 lastReply: the source id of the last one counted }
// and the watch lists in the settings as
//   phraseTicWatch: { [model]: [{ phrase, key }] }  a model's list -
//                       DEFAULT_WATCH until it has one; `model` is the model
//                       SillyTavern records on each reply (message.extra.model)
//   phraseTicIgnored: [key]  phrases the user stopped tracking - never found
//                       or watched again, for any model
// so it costs no file writes and is never caught up in a compile's own
// save. Announced on SillyTavern's event bus (PHRASE_TICS_CHANGED_EVENT),
// for the prompt block (src/context/) and the memory browser.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, updateChatEntry } from '../memory/registry.js';
import { isStoryReply, lastReplyIndex, sourceMessageId } from '../extraction/messages.js';
import { TIC_WINDOW, DEFAULT_WATCH, findCandidates, storyWordsOf, addFound, updateForReply, watchEntry } from './phrase-tics.js';

export const PHRASE_TICS_CHANGED_EVENT = 'archivist_phrase_tics_changed';

// AI replies without a tic before it loses a count (settings.phraseTicFadeAfter).
export const DEFAULT_FADE_AFTER = 10;

// Tics found by an older version of the rules are dropped on reading - the
// earlier rules left dialogue out and had the compiler's model pick among
// narration fragments, so what they found is not worth keeping.
export const TIC_RULES_VERSION = 3;

function stateOf(chatKey) {
    const saved = getChatEntry(chatKey)?.phraseTics;
    const current = saved?.rules === TIC_RULES_VERSION;
    return {
        rules: TIC_RULES_VERSION,
        tics: current && Array.isArray(saved?.tics) ? saved.tics : [],
        counter: Number.isInteger(saved?.counter) ? saved.counter : 0,
        lastReply: saved?.lastReply ?? null,
    };
}

function announce(chatKey) {
    try {
        void SillyTavern.getContext().eventSource?.emit?.(PHRASE_TICS_CHANGED_EVENT, { chatId: chatKey ? getChatEntry(chatKey)?.chatId : null, chatKey });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not announce the phrase tics', err);
    }
}

function save(chatKey, state) {
    updateChatEntry(chatKey, { phraseTics: state });
    saveSettings();
    announce(chatKey);
}

const enabled = () => getSettings().trackPhraseTics !== false;

function openKey() {
    const ref = getCurrentChatRef();
    return ref ? chatKeyFor(ref) : null;
}

const ignoredKeys = () => new Set(Array.isArray(getSettings().phraseTicIgnored) ? getSettings().phraseTicIgnored : []);

// Who wrote a message: the model SillyTavern recorded on it.
export const UNKNOWN_MODEL = 'unknown model';
export const modelOf = (message) => String(message?.extra?.model ?? '').trim() || UNKNOWN_MODEL;

// The model behind the open chat's latest AI reply.
export function currentModel() {
    const chat = SillyTavern.getContext().chat ?? [];
    const index = lastReplyIndex(chat);
    return index === -1 ? UNKNOWN_MODEL : modelOf(chat[index]);
}

const watchLists = () => {
    const saved = getSettings().phraseTicWatch;
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
};

// A model's watch list: [{ phrase, key }], copied.
export function getWatchList(model = currentModel()) {
    const list = watchLists()[model] ?? DEFAULT_WATCH.map(watchEntry).filter(Boolean);
    return list.map((w) => ({ ...w }));
}

function setWatchList(model, list) {
    const seen = new Set();
    getSettings().phraseTicWatch = { ...watchLists(), [model]: list.filter((w) => w && !seen.has(w.key) && seen.add(w.key)) };
    saveSettings();
}

// A model's watch list as the drawer edits it: a phrase per line.
export function getWatchText(model = currentModel()) {
    return getWatchList(model).map((w) => w.phrase).join('\n');
}

// The user's edited watch list for a model (a phrase per line): what they
// took out is ignored from now on - never found or watched again, for any
// model - and what they put in is no longer ignored.
export function setWatchText(text, model = currentModel()) {
    const next = String(text ?? '').split('\n').map(watchEntry).filter(Boolean);
    const keys = new Set(next.map((w) => w.key));
    const ignored = ignoredKeys();
    for (const w of getWatchList(model)) if (!keys.has(w.key)) ignored.add(w.key);
    for (const key of keys) ignored.delete(key);
    getSettings().phraseTicIgnored = [...ignored];
    setWatchList(model, next);
    announce(null);
}

// A chat's tics (a registry chat key; omitted: the open chat), copied:
// [{ phrase, key, count, last_used, ... }].
export function getChatPhraseTics(chatKey = openKey()) {
    return chatKey && getChatEntry(chatKey) ? stateOf(chatKey).tics.map((t) => ({ ...t })) : [];
}

// The open chat's tic candidates at a compile: the wording repeated across
// its latest TIC_WINDOW AI replies, without the words of `storyNames` (the
// compiled names of its characters, places, groups, things) and what the
// user writes too ([] when tracking is off).
export function currentCandidates(storyNames = []) {
    if (!enabled()) return [];
    const chat = SillyTavern.getContext().chat ?? [];
    const replies = [];
    let from = chat.length;
    for (let i = chat.length - 1; i >= 0 && replies.length < TIC_WINDOW; i--) {
        if (isStoryReply(chat[i]) && typeof chat[i].mes === 'string') {
            replies.unshift({ index: i, text: chat[i].mes });
            from = i;
        }
    }
    const userTexts = chat.slice(from).filter((m) => m?.is_user && typeof m.mes === 'string').map((m) => m.mes);
    return findCandidates(replies, { userTexts, storyWords: storyWordsOf(storyNames), ignored: ignoredKeys() });
}

// The tics a compile found (currentCandidates()) flagged in the chat, and
// put on the watch list of the model that wrote the replies.
export function recordFoundTics(chatKey, found, model = currentModel()) {
    if (!found?.length || !getChatEntry(chatKey)) return;
    const state = stateOf(chatKey);
    save(chatKey, { ...state, tics: addFound(state.tics, found, { now: new Date().toISOString(), counter: state.counter }) });
    const watch = getWatchList(model);
    const added = found.filter((f) => !watch.some((w) => w.key === f.key)).map((f) => ({ phrase: f.text, key: f.key }));
    if (added.length) setWatchList(model, [...watch, ...added]);
}

// The user stops tracking a tic (the memory browser): gone from the chat
// and the watch list, and never found or watched again.
export function removePhraseTic(chatKey, key) {
    const state = stateOf(chatKey);
    const tics = state.tics.filter((t) => t.key !== key);
    getSettings().phraseTicIgnored = [...ignoredKeys().add(key)];
    for (const model of Object.keys(watchLists())) setWatchList(model, getWatchList(model).filter((w) => w.key !== key));
    save(chatKey, { ...state, tics });
}

// Counts the open chat's newest AI reply, once: tics it uses gain (a
// dormant one flagged again), watched phrases it uses are flagged, the
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
        const ignored = ignoredKeys();
        const tics = updateForReply(state.tics.filter((t) => !ignored.has(t.key)), chat[index].mes, {
            now: new Date().toISOString(), counter, fadeAfter, watch: getWatchList(modelOf(chat[index])).filter((w) => !ignored.has(w.key)),
        });
        save(chatKey, { ...state, tics, counter, lastReply: id });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not count phrase tics', err);
    }
}

export function startPhraseTics() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    if (eventTypes.MESSAGE_RECEIVED) eventSource.on(eventTypes.MESSAGE_RECEIVED, () => countNewestReply());
}
