// Catch-up (spec sections 5 and 6): memories from a chat's EXISTING
// history, in the background, through Archivist's own INDEPENDENT State
// Engine preset - "Archivist History Catch-Up" - kept apart from live
// extraction so the two run side by side and the user keeps chatting.
//
// One pass, for the chat open when it starts:
//   1. take the chat's messages as they are now; plan which to send
//      (src/extraction/catch-up-plan.js - skipping what is already covered)
//      and split them into chunks of settings.chunkSize messages;
//   2. for each chunk: hand State Engine the chunk (each message labelled
//      [#index]) and an "Already remembered" carry-over as the preset's
//      context, run the preset, read and clear its memory variable, convert
//      the items (each attributed to the message it names) and append them
//      (addMemoryRecords - which rebuilds the indexes when that chat is open);
//   3. record how far it got, so a later pass resumes there.
//
// The preset runs on its own connection when the user picked one
// (settings.connectionProfileId - '' = State Engine's), with its own max
// tokens (settings.catchUpMaxTokens) and system header. It keeps writing to
// the chat it started on even if the user switches chats. Cancel stops it
// between chunks. The same preset re-extracts a single message the user
// edited (reextractMessage()).
//
// REBUILD (startCatchUp({ rebuild: true })): the same pass over EVERY
// message, not only the uncovered ones, each chunk's new memories replacing
// the ones its messages had (replaceMessageMemories() - the messages as
// shown now; another swipe's memories stay) - so changes to extraction reach
// the whole chat. A chunk replaces only once it succeeded: a failed or
// cancelled one leaves its old memories. Which messages it has rebuilt is
// kept (memoryRebuild: { done: [message stamp] } in the registry entry), so
// Continue reads only the rest - the chunks that failed, or that a stop cut
// off. Once every message is rebuilt, the compiler's Rebuild runs, the
// compiled memory resting on the memories just replaced. A chunk whose run fails is reported and skipped; a run
// State Engine turns away because another independent preset is running is
// retried after a short wait.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { findPreset } from '../api/presets.js';
import { getVariable, createVariable, updateVariable, getVariableValue, setVariableValue } from '../api/variables.js';
import { createIndependentPreset, configureIndependentPreset, updateIndependentPresetContext } from '../api/independent-presets.js';
import { runIndependent } from './independent-run.js';
import { listObjectTypeIds, getObjectByAlias } from '../api/objects.js';
import { addMemoryRecords, replaceMessageMemories, getAllMemories } from '../memory/archivist.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, ensureChatEntry, updateChatEntry } from '../memory/registry.js';
import { CATCH_UP_MEMORY_VARIABLE, memoryVariableDef } from './memory-variable.js';
import { convertExtractedItems, createEntityResolver } from './converter.js';
import { mentionMatcherFor } from '../memory/object-mentions.js';
import { sourceMessageId } from './messages.js';
import { uncoveredIndexes, toChunks, carryOver, chunkContext, sourceIndexFor } from './catch-up-plan.js';
import { rememberExtracted } from '../memory/message-fingerprints.js';

export const CATCH_UP_PRESET = 'Archivist History Catch-Up';

// Raised whenever memoryVariableDef('catch-up') or the header changes (see
// LIVE_VARIABLE_VERSION in live.js for why). 2: present, tags, tone.
// 3: present/tags/tone optional. 4: plans. 5: promises.
export const CATCH_UP_VARIABLE_VERSION = 5;

// The catch-up run's system header (State Engine's own talks about "a
// recent conversation excerpt" and "the most recent roleplay message",
// neither of which a history chunk has).
export const CATCH_UP_HEADER = [
    'You are a silent background memory-extraction process for a roleplay chat application.',
    'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
    'You will be given part of a roleplay chat\'s history - each message labelled [#number] with its speaker - and, under "Already remembered", memories already stored from earlier in the story.',
    'Read every message given, evaluate each variable according to its conditions and return the required JSON output.',
    '',
].join('\n');

// ---------------------------------------------------------------- the preset

// Creates the catch-up preset and its variable if missing, and updates the
// variable when CATCH_UP_VARIABLE_VERSION has moved on. Throws if State
// Engine refuses.
export async function ensureCatchUpPreset() {
    if (!await findPreset(CATCH_UP_PRESET)) {
        const created = await createIndependentPreset({
            name: CATCH_UP_PRESET,
            description: 'Archivist: extracts memories from a chat\'s earlier messages (catch-up). Run from the Archivist drawer.',
            promptedHeader: CATCH_UP_HEADER,
        });
        if (!created) throw new Error(`could not create the ${CATCH_UP_PRESET} preset`);
    }
    const settings = getSettings();
    const def = memoryVariableDef('catch-up');
    if (!await getVariable(CATCH_UP_PRESET, CATCH_UP_MEMORY_VARIABLE)) {
        if (!await createVariable(CATCH_UP_PRESET, CATCH_UP_MEMORY_VARIABLE, def)) throw new Error(`could not create the ${CATCH_UP_MEMORY_VARIABLE} variable`);
    } else if (settings.catchUpVariableVersion !== CATCH_UP_VARIABLE_VERSION) {
        if (!await updateVariable(CATCH_UP_PRESET, CATCH_UP_MEMORY_VARIABLE, def)) throw new Error(`could not update the ${CATCH_UP_MEMORY_VARIABLE} variable`);
    }
    if (settings.catchUpVariableVersion !== CATCH_UP_VARIABLE_VERSION) {
        settings.catchUpVariableVersion = CATCH_UP_VARIABLE_VERSION;
        saveSettings();
    }
}

// ------------------------------------------------------------------ progress

// The current (or last) pass, for the drawer:
// { running, chatKey, chatId, displayName, done, total, messages, stored,
//   failedChunks, failures: [{ from, to, error, response }] (each failed
//   chunk: its first and last message, why, and what the model wrote when
//   it could not be read), lastError, outcome: null | 'completed' |
//   'cancelled' | 'failed' | 'nothing', startedAt, finishedAt }
let progress = null;
let cancelRequested = false;
const progressListeners = new Set();

export function getCatchUpProgress() {
    return progress ? { ...progress, failures: [...(progress.failures ?? [])] } : null;
}

export function onCatchUpProgress(listener) {
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
}

function update(patch) {
    progress = { ...progress, ...patch };
    for (const listener of progressListeners) listener(getCatchUpProgress());
}

export function isCatchUpRunning() {
    return progress?.running === true;
}

// Asks a running pass to stop after the chunk in progress.
export function cancelCatchUp() {
    if (!isCatchUpRunning()) return false;
    cancelRequested = true;
    update({ cancelling: true });
    return true;
}

// ---------------------------------------------------------------- the pass

// The chat's messages as they are now - only what catch-up reads.
function snapshotChat() {
    const chat = SillyTavern.getContext().chat;
    return (Array.isArray(chat) ? chat : []).map((m) => ({
        name: m?.name, mes: m?.mes, is_user: !!m?.is_user, is_system: !!m?.is_system, send_date: m?.send_date,
    }));
}

// Runs the preset for one chunk (State Engine queues it behind other runs
// on the same connection). Resolves to { ok, error }.
function runChunk(chatId) {
    return runIndependent(CATCH_UP_PRESET, chatId);
}

// One run of the catch-up preset at a time - a pass's chunks and an edited
// message's re-extraction share the preset's context, so each
// set-context / run / read / clear must finish before the next begins.
let presetQueue = Promise.resolve();
function withPreset(task) {
    const run = presetQueue.then(task, task);
    presetQueue = run.catch(() => {});
    return run;
}

// Configures the preset for a run from the user's settings.
async function preparePreset() {
    const settings = getSettings();
    await ensureCatchUpPreset();
    await configureIndependentPreset(CATCH_UP_PRESET, {
        enabled: true,
        connectionProfileId: settings.connectionProfileId || '',
        maxTokens: Number(settings.catchUpMaxTokens) || null,
        temperature: Number.isFinite(Number(settings.catchUpTemperature)) ? Number(settings.catchUpTemperature) : null,
        promptedHeader: CATCH_UP_HEADER,
    });
}

// Extracts and stores the memories of the messages `chunk` (indexes into
// `chat`) for `ref`'s chat, with `records` as what is already remembered.
// `replace`: the new memories take the place of the ones these messages
// had (a rebuild). Resolves to { ok, error, added, removed } - added: the
// records stored, removed: the ids of the ones they replaced.
async function extractChunk(ref, chat, chunk, records, resolveEntity, mentionsIn, { replace = false } = {}) {
    return withPreset(async () => {
        await updateIndependentPresetContext(CATCH_UP_PRESET, chunkContext(chat, chunk, carryOver(records, chunk[0])));
        const { ok, error, response } = await runChunk(ref.chatId);

        const value = await getVariableValue(ref.chatId, CATCH_UP_MEMORY_VARIABLE);
        const items = Array.isArray(value) ? value : [];
        if (items.length) await setVariableValue(ref.chatId, CATCH_UP_PRESET, CATCH_UP_MEMORY_VARIABLE, []);
        if (!ok && items.length === 0) return { ok: false, error, response, added: [], removed: [] };

        const fields = await convertExtractedItems(items, {
            resolveEntity,
            mentionsIn,
            sourceFor: (item) => {
                const index = sourceIndexFor(item, chunk, chat);
                return sourceMessageId(ref.chatId, index, chat[index]);
            },
        });
        const sources = new Set(chunk.map((i) => sourceMessageId(ref.chatId, i, chat[i])));
        const removed = replace ? records.filter((r) => sources.has(r.source_message_id)).map((r) => r.id) : [];
        const added = replace ? (await replaceMessageMemories(ref, [...sources], fields)).added : await addMemoryRecords(ref, fields);
        for (const index of chunk) rememberExtracted(ref.chatId, chat[index]);
        return { ok: true, error: null, added, removed };
    });
}

const entityResolverFor = async (chatId) => createEntityResolver(await listObjectTypeIds(), (type, name) => getObjectByAlias(chatId, type, name));

async function runPass(ref, chat, { rebuild = false } = {}) {
    const settings = getSettings();
    const chatKey = chatKeyFor(ref);
    await preparePreset();

    let records = await getAllMemories(chatKey);
    // A rebuild sends every message (none counts as covered) it hasn't
    // rebuilt yet.
    const rebuilt = rebuild ? rebuiltStamps(chatKey, chat) : null;
    const indexes = rebuild
        ? uncoveredIndexes(chat, [], ref.chatId, null).filter((i) => !rebuilt.has(messageStamp(chat, i)))
        : uncoveredIndexes(chat, records, ref.chatId, getChatEntry(chatKey)?.catchUp ?? null);
    const chunks = toChunks(indexes, settings.chunkSize);
    update({ total: chunks.length, messages: indexes.length });
    if (chunks.length === 0) return 'nothing';

    const resolveEntity = await entityResolverFor(ref.chatId);
    const mentionsIn = await mentionMatcherFor(ref.chatId);
    let contiguous = true; // every chunk so far succeeded - the resume point may advance

    for (let k = 0; k < chunks.length; k++) {
        if (cancelRequested) return 'cancelled';
        const chunk = chunks[k];
        const { ok, error, response, added, removed } = await extractChunk(ref, chat, chunk, records, resolveEntity, mentionsIn, { replace: rebuild });
        if (!ok) {
            contiguous = false;
            const failure = { from: chunk[0], to: chunk[chunk.length - 1], error, response: response ?? null };
            update({ failedChunks: progress.failedChunks + 1, lastError: error, failures: [...progress.failures, failure] });
            console.warn(LOG_PREFIX, `${rebuild ? 'memory rebuild' : 'catch-up'} chunk ${k + 1} of ${chunks.length} (messages #${failure.from}-#${failure.to}) failed: ${error}`, response ?? '');
        } else {
            const gone = new Set(removed);
            records = records.filter((r) => !gone.has(r.id)).concat(added);
            ensureChatEntry(ref);
            if (rebuild) {
                for (const i of chunk) rebuilt.add(messageStamp(chat, i));
                updateChatEntry(chatKey, { memoryRebuild: { done: [...rebuilt] } });
            } else if (contiguous) {
                const last = chunk[chunk.length - 1];
                updateChatEntry(chatKey, { catchUp: { index: last, sendDate: String(chat[last].send_date ?? '') } });
            }
            update({ stored: progress.stored + added.length });
        }
        update({ done: k + 1 });
    }
    if (progress.failedChunks === chunks.length) return 'failed';
    // Every message rebuilt: the rebuild is over. A failed chunk leaves its
    // messages for Continue.
    if (rebuild && progress.failedChunks === 0) updateChatEntry(chatKey, { memoryRebuild: null });
    return 'completed';
}

// A message as a rebuild remembers it: its index and send date - an edited
// or re-swiped message is not the one rebuilt.
const messageStamp = (chat, i) => `${i}@${String(chat[i]?.send_date ?? '')}`;

// The messages of `chat` the chat's unfinished rebuild has done. An older
// resume point ({ index, sendDate }) counts as everything up to it.
function rebuiltStamps(chatKey, chat) {
    const saved = getChatEntry(chatKey)?.memoryRebuild;
    if (Array.isArray(saved?.done)) return new Set(saved.done);
    const done = new Set();
    if (Number.isInteger(saved?.index) && String(chat[saved.index]?.send_date ?? '') === String(saved.sendDate ?? '')) {
        for (let i = 0; i <= saved.index; i++) done.add(messageStamp(chat, i));
    }
    return done;
}

// How many of the open chat's messages its unfinished rebuild has left to
// read (0 when there is none unfinished).
export function rebuildMessagesLeft(chatKey) {
    if (!getChatEntry(chatKey)?.memoryRebuild) return 0;
    const chat = snapshotChat();
    const done = rebuiltStamps(chatKey, chat);
    return uncoveredIndexes(chat, [], '', null).filter((i) => !done.has(messageStamp(chat, i))).length;
}

// After a memory rebuild: the compiler's Rebuild, so the compiled memory
// rests on the new memories (the threads the user wrote are kept). Only
// for the chat still open - another is rebuilt from its own compile.
async function compileAfterRebuild(ref) {
    try {
        const open = getCurrentChatRef();
        if (!open || chatKeyFor(open) !== chatKeyFor(ref)) return;
        const { compileOpenChat, isCompiling } = await import('../compiler/compiler.js');
        if (isCompiling()) {
            console.warn(LOG_PREFIX, 'the compiler was already running when the memories were rebuilt - Rebuild the compiled memory once it is done');
            return;
        }
        // Said when it starts - compileOpenChat() resolves only once the
        // whole compile is over, which on a long chat takes a while.
        const running = compileOpenChat({ rebuild: true, reason: 'memory rebuild' });
        if (isCompiling()) update({ compileStarted: true });
        await running;
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not start the compiler after rebuilding the memories', err);
    }
}

// Whether a memory rebuild is running (auto-compiles wait for its end).
export function isRebuildingMemories() {
    return progress?.running === true && progress.rebuild === true;
}

// Whether the chat `chatKey` has a memory rebuild that stopped before every
// message was rebuilt (stopped, or chunks failed) - the next one reads only
// what is left.
export function hasUnfinishedRebuild(chatKey) {
    return !!getChatEntry(chatKey)?.memoryRebuild;
}

// Extracts the memories of one message again - after the user edited it
// (src/memory/message-sync.js has removed the old ones). `ref` is its chat,
// `chat` the messages as they are now. Resolves to the records stored;
// throws if the run failed.
export async function reextractMessage(ref, chat, index) {
    if (!chat?.[index] || chat[index].is_system || !String(chat[index].mes ?? '').trim()) return [];
    await preparePreset();
    const records = await getAllMemories(chatKeyFor(ref));
    const { ok, error, added } = await extractChunk(ref, chat, [index], records, await entityResolverFor(ref.chatId), await mentionMatcherFor(ref.chatId));
    if (!ok) throw new Error(error);
    return added;
}

// Starts a catch-up pass for the open chat, in the background. Resolves to
// false (and does nothing) when one is already running or no chat is open;
// otherwise to true once it has started - follow it with
// onCatchUpProgress(). `whenDone` (tests) resolves when the pass ends.
// `rebuild`: rebuild the chat's memories from its messages (see REBUILD
// above) - then the compiler's Rebuild, when the chat is still open.
export async function startCatchUp({ whenDone, rebuild = false } = {}) {
    if (isCatchUpRunning()) return false;
    const ref = getCurrentChatRef();
    if (!ref) return false;

    cancelRequested = false;
    progress = {
        running: true, cancelling: false, rebuild, compileStarted: false, chatKey: chatKeyFor(ref), chatId: ref.chatId, displayName: ref.displayName,
        done: 0, total: 0, messages: 0, stored: 0, failedChunks: 0, failures: [], lastError: null, outcome: null,
        startedAt: new Date().toISOString(), finishedAt: null,
    };
    update({});

    const chat = snapshotChat();
    const pass = runPass(ref, chat, { rebuild })
        .catch((err) => {
            console.warn(LOG_PREFIX, 'catch-up failed', err);
            update({ lastError: err?.message ?? String(err) });
            return 'failed';
        })
        .then((outcome) => {
            update({ running: false, cancelling: false, outcome, finishedAt: new Date().toISOString() });
            console.info(LOG_PREFIX, `${rebuild ? 'memory rebuild' : 'catch-up'} of "${ref.chatId}" ${outcome}: ${progress.stored} memories stored from ${progress.messages} messages`);
            // Recompiled once every message is rebuilt - not while failed
            // chunks wait for Continue.
            return rebuild && outcome === 'completed' && !hasUnfinishedRebuild(chatKeyFor(ref)) ? compileAfterRebuild(ref) : null;
        });
    whenDone?.(pass);
    return true;
}
