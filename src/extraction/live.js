// Live extraction: memories from each new AI message, at no extra LLM
// cost. Archivist's regular preset, "Archivist Recent Memory Collection"
// (LIVE_PRESET), holds the memory extraction
// variable (src/extraction/memory-variable.js) and is active for the open
// chat while Archivist is enabled, so State Engine fills that variable in
// during its ordinary per-message prompted update - the same call that
// updates every other active preset's variables (spec section 5,
// "During normal story progression", steps 1-4):
//
//   1. State Engine extracts memory into archivist__memories
//   2. its change event reaches harvest(), which reads and CLEARS the
//      variable, then converts the items into memory record fields
//   3. addMemoryRecords() appends them to the chat's memories.json
//   4. ...and rebuilds the indexes
//
// Each memory is attributed to the newest AI message in the chat. The
// variable is cleared before the records are stored, so a second change
// event arriving mid-store finds nothing to store twice; if storing then
// fails, the items are kept and retried with the chat's next harvest.
//
// Self-repair: the user can deactivate or delete the live preset (or its
// variable) in State Engine's manager - State Engine warns them while
// Archivist runs, but allows it. While Archivist is enabled,
// syncLivePreset() puts back whatever is missing and re-activates the
// preset each time a chat opens, and repairLiveExtraction() does the same
// on demand. Stored memory is never at risk: it lives in Archivist's own
// files, not in State Engine variables - at most the memories of the
// moment the variable was deleted are lost.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { findPreset, createPreset, updatePreset, activatePreset, deactivatePreset } from '../api/presets.js';
import { getVariable, createVariable, updateVariable, getVariableValue, setVariableValue, VARIABLES_CHANGED_EVENT } from '../api/variables.js';
import { listObjectTypeIds, getObjectByAlias } from '../api/objects.js';
import { addMemoryRecords } from '../memory/archivist.js';
import { getCurrentChatRef } from '../memory/registry.js';
import { MEMORY_VARIABLE, memoryVariableDef } from './memory-variable.js';
import { convertExtractedItems, createEntityResolver } from './converter.js';
import { sourceMessageId, lastReplyIndex } from './messages.js';
import { rememberExtracted } from '../memory/message-fingerprints.js';
import { CONTEXT_BLOCKS, contextVariableDef } from '../context/prompt-context.js';

export const LIVE_PRESET = 'Archivist Recent Memory Collection';

// Earlier names of the same preset. One found under an old name is renamed
// in place - keeping its chat activations, stored values and any edits.
const OLD_LIVE_PRESET_NAMES = ['Live'];

// Raised whenever memoryVariableDef('live') changes, so an existing
// install's variable is brought up to date once - and otherwise left
// alone, keeping any edits the user made in State Engine's manager.
// 2: NEW EACH TURN, and a lower bar for what counts as a memory.
// 3: who was present, prioritization tags, emotional tone.
// 4: at most LIVE_MAX_MEMORIES, optional present/tags/tone, ANSWER LAST.
// 5: the prompt-context variables' labels (no "Archivist:" prefix).
// 6: the scene and scene-characters descriptions.
// 7: plans, as one memory with their steps in order.
export const LIVE_VARIABLE_VERSION = 7;

const harvests = new Map(); // chatId -> { running, again, retry: items[] }

// Renames the preset if it still has an old name. True if it did.
async function renameOldLivePreset() {
    for (const oldName of OLD_LIVE_PRESET_NAMES) {
        if (!await findPreset(oldName)) continue;
        if (!await updatePreset(oldName, { name: LIVE_PRESET })) throw new Error(`could not rename the ${oldName} preset to ${LIVE_PRESET}`);
        return true;
    }
    return false;
}

// Creates the live preset and its variable if missing (renaming one with
// an old name instead), and updates the variable when
// LIVE_VARIABLE_VERSION has moved on. Throws if State Engine refuses.
export async function ensureLivePreset() {
    if (!await findPreset(LIVE_PRESET) && !await renameOldLivePreset()) {
        const created = await createPreset({
            name: LIVE_PRESET,
            description: 'Archivist: extracts memories from each new AI message, as part of the regular update.',
            triggers: ['ai'],
            showInTracker: false,
        });
        if (!created) throw new Error(`could not create the ${LIVE_PRESET} preset`);
    }

    const settings = getSettings();
    const def = memoryVariableDef('live');
    if (!await getVariable(LIVE_PRESET, MEMORY_VARIABLE)) {
        if (!await createVariable(LIVE_PRESET, MEMORY_VARIABLE, def)) throw new Error(`could not create the ${MEMORY_VARIABLE} variable`);
    } else if (settings.liveVariableVersion !== LIVE_VARIABLE_VERSION) {
        if (!await updateVariable(LIVE_PRESET, MEMORY_VARIABLE, def)) throw new Error(`could not update the ${MEMORY_VARIABLE} variable`);
    }
    // The prompt-context variables Curator can inject (src/context/).
    for (const [name, label, description] of CONTEXT_BLOCKS) {
        const contextDef = contextVariableDef(label, description);
        if (!await getVariable(LIVE_PRESET, name)) {
            if (!await createVariable(LIVE_PRESET, name, contextDef)) throw new Error(`could not create the ${name} variable`);
        } else if (settings.liveVariableVersion !== LIVE_VARIABLE_VERSION && !await updateVariable(LIVE_PRESET, name, contextDef)) {
            throw new Error(`could not update the ${name} variable`);
        }
    }
    if (settings.liveVariableVersion !== LIVE_VARIABLE_VERSION) {
        settings.liveVariableVersion = LIVE_VARIABLE_VERSION;
        saveSettings();
    }
}

// While Archivist is enabled: recreates the live preset or its variable if
// they were deleted, and activates the preset for the open chat. While
// disabled: deactivates it for the open chat.
export async function syncLivePreset() {
    const ref = getCurrentChatRef();
    if (!ref) return;
    if (getSettings().enabled) {
        await ensureLivePreset();
        await activatePreset(ref.chatId, LIVE_PRESET);
        await harvest(ref.chatId);
    } else {
        await deactivatePreset(ref.chatId, LIVE_PRESET);
    }
}

// What happened the last time the live variable held memories - for the
// drawer and the console, so a user can see whether memories arrive and
// whether they were stored: { at, chatId, outcome: 'stored' | 'rejected' |
// 'failed', received, stored, error }, or null before the first. (Reading an
// empty variable is not reported: State Engine announces every variable
// change, so empty reads happen all the time.)
let lastHarvest = null;
const harvestListeners = new Set();

export function getLastHarvest() {
    return lastHarvest ? { ...lastHarvest } : null;
}

// Called with getLastHarvest() after each report.
export function onHarvest(listener) {
    harvestListeners.add(listener);
    return () => harvestListeners.delete(listener);
}

function reportHarvest(chatId, outcome, received, stored, error = null) {
    lastHarvest = { at: new Date().toISOString(), chatId, outcome, received, stored, error };
    if (outcome === 'stored') {
        console.info(LOG_PREFIX, `stored ${stored} of ${received} new ${received === 1 ? 'memory' : 'memories'} for chat "${chatId}"`);
    } else {
        console.warn(LOG_PREFIX, `${received} new ${received === 1 ? 'memory' : 'memories'} for chat "${chatId}" ${outcome === 'rejected' ? 'were not stored' : 'could not be stored'}: ${error}`);
    }
    for (const listener of harvestListeners) listener(getLastHarvest());
}

async function storeLiveItems(ref, items) {
    const chat = SillyTavern.getContext().chat;
    const index = lastReplyIndex(chat);
    const source = index === -1 ? `${ref.chatId}#unknown` : sourceMessageId(ref.chatId, index, chat[index]);

    const resolveEntity = createEntityResolver(await listObjectTypeIds(), (type, name) => getObjectByAlias(ref.chatId, type, name));
    const fields = await convertExtractedItems(items, { sourceFor: () => source, resolveEntity });
    const stored = await addMemoryRecords(ref, fields);
    if (index !== -1) rememberExtracted(ref.chatId, chat[index]);
    return stored;
}

async function harvestOnce(ref, state) {
    const value = await getVariableValue(ref.chatId, MEMORY_VARIABLE);
    const items = [...state.retry, ...(Array.isArray(value) ? value : [])];
    state.retry = [];
    if (Array.isArray(value) && value.length > 0) {
        await setVariableValue(ref.chatId, LIVE_PRESET, MEMORY_VARIABLE, []);
    }
    if (items.length === 0) return;

    try {
        const stored = await storeLiveItems(ref, items);
        if (stored.length > 0) reportHarvest(ref.chatId, 'stored', items.length, stored.length);
        else reportHarvest(ref.chatId, 'rejected', items.length, 0, 'none of them had the text of a memory');
    } catch (err) {
        state.retry = items;
        reportHarvest(ref.chatId, 'failed', items.length, 0, `${err?.message ?? err} - will retry with the next update`);
        console.warn(LOG_PREFIX, 'storing failed', err);
    }
}

// Stores whatever the Live variable holds for `chatId`, if it is the open
// chat. Overlapping calls for one chat run one at a time; a call arriving
// while one runs makes it go round once more. Never throws.
export async function harvest(chatId) {
    const ref = getCurrentChatRef();
    if (!ref) {
        console.debug(LOG_PREFIX, `harvest skipped: no open chat Archivist can identify (State Engine reported chat ${JSON.stringify(chatId)})`);
        return;
    }
    if (chatId !== null && chatId !== undefined && chatId !== ref.chatId) {
        console.debug(LOG_PREFIX, `harvest skipped: State Engine reported chat ${JSON.stringify(chatId)}, the open chat is ${JSON.stringify(ref.chatId)}`);
        return;
    }

    const state = harvests.get(ref.chatId) ?? { running: false, again: false, retry: [] };
    harvests.set(ref.chatId, state);
    if (state.running) {
        state.again = true;
        return;
    }

    state.running = true;
    try {
        do {
            state.again = false;
            await harvestOnce(ref, state);
        } while (state.again);
    } catch (err) {
        console.warn(LOG_PREFIX, 'live memory extraction failed', err);
    } finally {
        state.running = false;
    }
}

// Whether live extraction is working, for the drawer: 'ok', 'off'
// (Archivist disabled) or 'error' with the last setup/repair failure.
let health = { state: 'off', error: null };
const healthListeners = new Set();

export function getLiveHealth() {
    return { ...health };
}

// Called with getLiveHealth() whenever it changes.
export function onLiveHealthChange(listener) {
    healthListeners.add(listener);
    return () => healthListeners.delete(listener);
}

function setHealth(next) {
    health = next;
    for (const listener of healthListeners) listener(getLiveHealth());
}

// syncLivePreset(), recording the outcome in getLiveHealth(). Never throws.
async function syncAndRecord() {
    try {
        await syncLivePreset();
        setHealth({ state: getSettings().enabled ? 'ok' : 'off', error: null });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not set up the live preset', err);
        setHealth({ state: 'error', error: err?.message ?? String(err) });
    }
}

// Puts the live preset back in working order now (see "Self-repair"
// above) - for the drawer's Repair button. Resolves to getLiveHealth().
export async function repairLiveExtraction() {
    try {
        await ensureLivePreset();
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not repair the live preset', err);
        setHealth({ state: 'error', error: err?.message ?? String(err) });
        return getLiveHealth();
    }
    await syncAndRecord();
    return getLiveHealth();
}

// The drawer's "Enable Archivist" switch: saves it and (de)activates the
// Live preset for the open chat. Resolves to getLiveHealth().
export async function setArchivistEnabled(enabled) {
    getSettings().enabled = enabled === true;
    saveSettings();
    await syncAndRecord();
    return getLiveHealth();
}

// Starts following State Engine's updates, then sets up the live preset.
// Call once, after the memory core has loaded the open chat. The listeners
// go in first, so a setup failure here can be fixed later with
// repairLiveExtraction() without a reload. Never throws.
export async function startLiveExtraction() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(VARIABLES_CHANGED_EVENT, (chatId) => {
        if (getSettings().enabled) void harvest(chatId);
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => void syncAndRecord());
    await repairLiveExtraction();
}
