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
// edited (reextractMessage()). A chunk whose run fails is reported and skipped; a run
// State Engine turns away because another independent preset is running is
// retried after a short wait.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { findPreset } from '../api/presets.js';
import { getVariable, createVariable, updateVariable, getVariableValue, setVariableValue } from '../api/variables.js';
import {
    createIndependentPreset, configureIndependentPreset, updateIndependentPresetContext, runIndependentPreset, getIndependentPresetStatus,
} from '../api/independent-presets.js';
import { listObjectTypeIds, getObjectByAlias } from '../api/objects.js';
import { addMemoryRecords, getAllMemories } from '../memory/archivist.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, ensureChatEntry, updateChatEntry } from '../memory/registry.js';
import { CATCH_UP_MEMORY_VARIABLE, memoryVariableDef } from './memory-variable.js';
import { convertExtractedItems, createEntityResolver } from './converter.js';
import { sourceMessageId } from './messages.js';
import { uncoveredIndexes, toChunks, carryOver, chunkContext, sourceIndexFor } from './catch-up-plan.js';
import { rememberExtracted } from '../memory/message-fingerprints.js';

export const CATCH_UP_PRESET = 'Archivist History Catch-Up';

// Raised whenever memoryVariableDef('catch-up') or the header changes (see
// LIVE_VARIABLE_VERSION in live.js for why).
export const CATCH_UP_VARIABLE_VERSION = 1;

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

// How long to wait, and how often, when another independent preset is running.
export const BUSY_RETRY_MS = 2000;
export const BUSY_RETRIES = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
//   failedChunks, lastError, outcome: null | 'completed' | 'cancelled' |
//   'failed' | 'nothing', startedAt, finishedAt }
let progress = null;
let cancelRequested = false;
const progressListeners = new Set();

export function getCatchUpProgress() {
    return progress ? { ...progress } : null;
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

// Runs the preset for one chunk, waiting while another independent preset
// runs. Resolves to { ok, error }.
async function runChunk(chatId) {
    for (let attempt = 0; ; attempt++) {
        if (await runIndependentPreset(chatId, CATCH_UP_PRESET)) return { ok: true, error: null };
        const status = await getIndependentPresetStatus(CATCH_UP_PRESET);
        if (status?.lastOutcome === 'skipped-in-progress' && attempt < BUSY_RETRIES && !cancelRequested) {
            await sleep(BUSY_RETRY_MS);
            continue;
        }
        return { ok: false, error: status?.lastError || status?.lastOutcome || 'the run did not write anything' };
    }
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
        promptedHeader: CATCH_UP_HEADER,
    });
}

// Extracts and stores the memories of the messages `chunk` (indexes into
// `chat`) for `ref`'s chat, with `records` as what is already remembered.
// Resolves to { ok, error, added } - added: the records stored.
async function extractChunk(ref, chat, chunk, records, resolveEntity) {
    return withPreset(async () => {
        await updateIndependentPresetContext(CATCH_UP_PRESET, chunkContext(chat, chunk, carryOver(records, chunk[0])));
        const { ok, error } = await runChunk(ref.chatId);

        const value = await getVariableValue(ref.chatId, CATCH_UP_MEMORY_VARIABLE);
        const items = Array.isArray(value) ? value : [];
        if (items.length) await setVariableValue(ref.chatId, CATCH_UP_PRESET, CATCH_UP_MEMORY_VARIABLE, []);
        if (!ok && items.length === 0) return { ok: false, error, added: [] };

        const fields = await convertExtractedItems(items, {
            resolveEntity,
            sourceFor: (item) => {
                const index = sourceIndexFor(item, chunk, chat);
                return sourceMessageId(ref.chatId, index, chat[index]);
            },
        });
        const added = await addMemoryRecords(ref, fields);
        for (const index of chunk) rememberExtracted(ref.chatId, chat[index]);
        return { ok: true, error: null, added };
    });
}

const entityResolverFor = async (chatId) => createEntityResolver(await listObjectTypeIds(), (type, name) => getObjectByAlias(chatId, type, name));

async function runPass(ref, chat) {
    const settings = getSettings();
    const chatKey = chatKeyFor(ref);
    await preparePreset();

    const records = await getAllMemories(chatKey);
    const indexes = uncoveredIndexes(chat, records, ref.chatId, getChatEntry(chatKey)?.catchUp ?? null);
    const chunks = toChunks(indexes, settings.chunkSize);
    update({ total: chunks.length, messages: indexes.length });
    if (chunks.length === 0) return 'nothing';

    const resolveEntity = await entityResolverFor(ref.chatId);
    let contiguous = true; // every chunk so far succeeded - the resume point may advance

    for (let k = 0; k < chunks.length; k++) {
        if (cancelRequested) return 'cancelled';
        const chunk = chunks[k];
        const { ok, error, added } = await extractChunk(ref, chat, chunk, records, resolveEntity);
        if (!ok) {
            contiguous = false;
            update({ failedChunks: progress.failedChunks + 1, lastError: error });
            console.warn(LOG_PREFIX, `catch-up chunk ${k + 1} of ${chunks.length} failed: ${error}`);
        } else {
            records.push(...added);
            if (contiguous) {
                const last = chunk[chunk.length - 1];
                ensureChatEntry(ref);
                updateChatEntry(chatKey, { catchUp: { index: last, sendDate: String(chat[last].send_date ?? '') } });
            }
            update({ stored: progress.stored + added.length });
        }
        update({ done: k + 1 });
    }
    return progress.failedChunks === chunks.length ? 'failed' : 'completed';
}

// Extracts the memories of one message again - after the user edited it
// (src/memory/message-sync.js has removed the old ones). `ref` is its chat,
// `chat` the messages as they are now. Resolves to the records stored;
// throws if the run failed.
export async function reextractMessage(ref, chat, index) {
    if (!chat?.[index] || chat[index].is_system || !String(chat[index].mes ?? '').trim()) return [];
    await preparePreset();
    const records = await getAllMemories(chatKeyFor(ref));
    const { ok, error, added } = await extractChunk(ref, chat, [index], records, await entityResolverFor(ref.chatId));
    if (!ok) throw new Error(error);
    return added;
}

// Starts a catch-up pass for the open chat, in the background. Resolves to
// false (and does nothing) when one is already running or no chat is open;
// otherwise to true once it has started - follow it with
// onCatchUpProgress(). `whenDone` (tests) resolves when the pass ends.
export async function startCatchUp({ whenDone } = {}) {
    if (isCatchUpRunning()) return false;
    const ref = getCurrentChatRef();
    if (!ref) return false;

    cancelRequested = false;
    progress = {
        running: true, cancelling: false, chatKey: chatKeyFor(ref), chatId: ref.chatId, displayName: ref.displayName,
        done: 0, total: 0, messages: 0, stored: 0, failedChunks: 0, lastError: null, outcome: null,
        startedAt: new Date().toISOString(), finishedAt: null,
    };
    update({});

    const chat = snapshotChat();
    const pass = runPass(ref, chat)
        .catch((err) => {
            console.warn(LOG_PREFIX, 'catch-up failed', err);
            update({ lastError: err?.message ?? String(err) });
            return 'failed';
        })
        .then((outcome) => {
            update({ running: false, cancelling: false, outcome, finishedAt: new Date().toISOString() });
            console.info(LOG_PREFIX, `catch-up of "${ref.chatId}" ${outcome}: ${progress.stored} memories stored from ${progress.messages} messages`);
        });
    whenDone?.(pass);
    return true;
}
