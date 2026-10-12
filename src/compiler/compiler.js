// The Archivist Compiler: turns a chat's raw memories into structured,
// deduplicated knowledge - character profiles, scene state, session details,
// relationships, a timeline - with colour tags (src/compiler/compiled-schema.js).
//
// The model work (merging similar facts, canonical statements, themes,
// relationships, contradictions) runs through Archivist's own INDEPENDENT
// State Engine preset, "Archivist Memory Compiler", on its own connection -
// like catch-up. Its answer comes back in two NEW EACH TURN record lists:
// compiled_facts and compiled_relationships. Grouping, the timeline, the
// colour tags and the scheduling are code (compile-plan.js, schedule.js).
//
// INCREMENTAL: each run hands the model the current compiled knowledge and
// only the memories added since, in batches of COMPILE_BATCH, and gets back
// the complete updated lists - profiles stay stable, prompts stay small.
// Rebuild starts from nothing and feeds every memory, batch by batch.
//
// Stored per chat in its own file next to the memories
// (registry compiledFileFor()); the registry entry's `compiler` field
// records { at, memoryCount }. An answer that would drop every fact is not
// trusted - the previous compiled state is kept.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { findPreset } from '../api/presets.js';
import { getVariable, createVariable, updateVariable, getVariableValue, setVariableValue } from '../api/variables.js';
import { createIndependentPreset, configureIndependentPreset, updateIndependentPresetContext } from '../api/independent-presets.js';
import { listObjectTypeIds, getObjectByAlias, getObject } from '../api/objects.js';
import { getAllMemories, MEMORIES_CHANGED_EVENT } from '../memory/archivist.js';
import { getCurrentChatRef, chatKeyFor, getChatEntry, findChatEntriesById, updateChatEntry, compiledFileFor } from '../memory/registry.js';
import { readJsonFile, writeJsonFile } from '../memory/storage.js';
import { runIndependentWithRetry } from '../extraction/independent-run.js';
import { EMPTY_COMPILED, refsFor, compileContext, parseCompileOutput, changesSince, buildCompiledView } from './compile-plan.js';
import { meaningfulCount, shouldCompile } from './schedule.js';

export const COMPILER_PRESET = 'Archivist Memory Compiler';
export const FACTS_VARIABLE = 'compiled_facts';
export const RELATIONSHIPS_VARIABLE = 'compiled_relationships';

// Raised whenever the variables' definitions or the header change (see
// LIVE_VARIABLE_VERSION in src/extraction/live.js).
export const COMPILER_VARIABLE_VERSION = 1;

// New memories per compile run.
export const COMPILE_BATCH = 60;

// Emitted on SillyTavern's event bus after a chat's compiled memory changes,
// with { chatId, chatKey }.
export const COMPILED_CHANGED_EVENT = 'archivist_compiled_changed';

export const COMPILER_HEADER = [
    'You are a silent background memory-compilation process for a roleplay chat application.',
    'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
    'You will be given the current compiled knowledge about a story - facts (each with an id like [f3]) and relationships - and new memories extracted from the story (each with a ref like [m1]).',
    'Update the compiled knowledge with the new memories: evaluate each variable according to its conditions and return the required JSON output.',
    '',
].join('\n');

const FACTS_INSTRUCTIONS = [
    'The COMPLETE updated list of compiled facts: every current fact - revised where the new memories change it - plus new facts from the new memories.',
    'Merge memories and facts that say the same thing about the same entity (the same core nouns, place, job or relationship) into ONE fact.',
    'Consolidate into canonical statements, for example: several memories about the same workplace become one fact "X works at Y"; mentions of money trouble or extra jobs become "X is under financial strain and considering additional work"; arrivals, weather and transport are facts about the scene.',
    'Drop a current fact only when the new memories show it is no longer true.',
    'Each item is an object: {"id": the id of the current fact it continues, or a new id f<number> for a new fact;',
    '"text": one self-contained statement naming who or what it is about;',
    '"entities": the names of the characters, places, factions and things it is about, exactly as the story names them;',
    '"classification": "PERMANENT" (stable biography or long-term condition), "SESSION" (true for this part of the story) or "SCENE" (only the immediate scene: arrivals, weather, transport, what is happening right now);',
    '"theme": one short word - employment, finances, transportation, relationships, activity, health, location, or another;',
    '"sources": the refs [m...] of the NEW memories it uses ([] if none);',
    '"contradicts": the ids of other facts in your list it is incompatible with ([] if none)}.',
].join(' ');

const RELATIONSHIPS_INSTRUCTIONS = [
    'The COMPLETE updated list of relationships between two entities shown by the facts and memories - keep the current ones that still hold, add new ones.',
    'Each item is an object: {"from": a name; "to": a name; "type": a short label such as "trains", "works for", "friends with", "distrusts", "is related to";',
    '"text": one sentence describing it; "sources": the refs [m...] of the NEW memories that show it ([] if none)}.',
].join(' ');

function variableDef(instructions, label, itemSchema) {
    return {
        label,
        description: 'Archivist Memory Compiler output. Read and cleared by Archivist after each run.',
        type: 'array',
        itemType: 'record',
        itemSchema,
        defaultValue: [],
        scope: 'chat',
        showInTracker: false,
        behaviors: { prompted: true, increment: false },
        prompted: { instructions, newEachTurn: true },
    };
}

const VARIABLES = [
    [FACTS_VARIABLE, () => variableDef(FACTS_INSTRUCTIONS, 'Compiled facts', { text: { type: 'string' } })],
    [RELATIONSHIPS_VARIABLE, () => variableDef(RELATIONSHIPS_INSTRUCTIONS, 'Compiled relationships', { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' } })],
];

// ------------------------------------------------------------- the preset

// Creates the compiler preset and its variables if missing, updating the
// variables when COMPILER_VARIABLE_VERSION has moved on. Throws if State
// Engine refuses.
export async function ensureCompilerPreset() {
    if (!await findPreset(COMPILER_PRESET)) {
        const created = await createIndependentPreset({
            name: COMPILER_PRESET,
            description: 'Archivist: compiles a chat\'s memories into profiles, scene and session state, relationships and a timeline. Run from the Archivist drawer.',
            promptedHeader: COMPILER_HEADER,
        });
        if (!created) throw new Error(`could not create the ${COMPILER_PRESET} preset`);
    }
    const settings = getSettings();
    const outdated = settings.compilerVariableVersion !== COMPILER_VARIABLE_VERSION;
    for (const [name, def] of VARIABLES) {
        if (!await getVariable(COMPILER_PRESET, name)) {
            if (!await createVariable(COMPILER_PRESET, name, def())) throw new Error(`could not create the ${name} variable`);
        } else if (outdated && !await updateVariable(COMPILER_PRESET, name, def())) {
            throw new Error(`could not update the ${name} variable`);
        }
    }
    if (outdated) {
        settings.compilerVariableVersion = COMPILER_VARIABLE_VERSION;
        saveSettings();
    }
}

// ------------------------------------------------------------ storage

const normalizeCompiled = (data) => ({
    facts: Array.isArray(data?.facts) ? data.facts : [],
    relationships: Array.isArray(data?.relationships) ? data.relationships : [],
    included: Array.isArray(data?.included) ? data.included : [],
    compiledAt: data?.compiledAt ?? null,
});

// The compiled state for a registry chat key (EMPTY_COMPILED when none).
export async function readCompiled(chatKey) {
    const entry = getChatEntry(chatKey);
    if (!entry) return { ...EMPTY_COMPILED };
    return normalizeCompiled(await readJsonFile(compiledFileFor(entry)));
}

async function writeCompiled(chatKey, compiled) {
    const entry = getChatEntry(chatKey);
    if (!entry) throw new Error('the chat has no stored memories');
    await writeJsonFile(compiledFileFor(entry), { version: 1, chatId: entry.chatId, ...compiled });
    updateChatEntry(chatKey, { compiler: { at: compiled.compiledAt, memoryCount: compiled.included.length } });
}

// ------------------------------------------------------------ status

// The current (or last) run, for the drawer:
// { running, chatKey, chatId, rebuild, reason, batch, batches, outcome:
//   null | 'compiled' | 'nothing' | 'failed', error, finishedAt }
let status = null;
const statusListeners = new Set();

export function getCompilerStatus() {
    return status ? { ...status } : null;
}

export function onCompilerStatus(listener) {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
}

function setStatus(patch) {
    status = { ...status, ...patch };
    for (const listener of statusListeners) listener(getCompilerStatus());
}

export function isCompiling() {
    return status?.running === true;
}

function emitCompiled(chatKey, chatId) {
    try {
        void SillyTavern.getContext().eventSource?.emit?.(COMPILED_CHANGED_EVENT, { chatId, chatKey });
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not announce a compile', err);
    }
}

// ------------------------------------------------------------ a run

async function entityResolver(chatId) {
    const types = await listObjectTypeIds();
    const cache = new Map();
    return {
        // { id | null, name } for a name, looked up among State Engine's objects.
        async resolve(name) {
            const key = name.toLowerCase();
            if (cache.has(key)) return cache.get(key);
            let found = null;
            for (const type of types) {
                try {
                    found = await getObjectByAlias(chatId, type, name);
                } catch {
                    found = null;
                }
                if (found?.id) break;
            }
            const entity = { id: found?.id ?? null, name: found?.name ?? name };
            cache.set(key, entity);
            return entity;
        },
        // A display name for an entity id, or null.
        async nameOf(id) {
            try {
                return (await getObject(chatId, id))?.name ?? null;
            } catch {
                return null;
            }
        },
    };
}

// parseCompileOutput() needs a synchronous resolve(): names are looked up
// first, then handed over.
async function resolveNames(rawFacts, rawRelationships, resolver) {
    const wanted = new Set();
    const list = (v) => (typeof v === 'string' ? v.split(',') : (Array.isArray(v) ? v : [])).filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
    for (const f of Array.isArray(rawFacts) ? rawFacts : []) for (const n of list(f?.entities)) wanted.add(n);
    for (const r of Array.isArray(rawRelationships) ? rawRelationships : []) for (const n of [r?.from, r?.to]) if (typeof n === 'string' && n.trim()) wanted.add(n.trim());
    const resolved = new Map();
    for (const name of wanted) resolved.set(name, await resolver.resolve(name));
    return (name) => resolved.get(name) ?? { id: null, name };
}

async function readAndClear(chatId, name) {
    const value = await getVariableValue(chatId, name);
    if (Array.isArray(value) && value.length) await setVariableValue(chatId, COMPILER_PRESET, name, []);
    return Array.isArray(value) ? value : [];
}

async function compileRun(ref, { rebuild }) {
    const settings = getSettings();
    const chatKey = chatKeyFor(ref);
    const records = await getAllMemories(chatKey);
    let compiled = rebuild ? { ...EMPTY_COMPILED } : await compiledFor(chatKey);
    const { added } = changesSince(compiled, records);
    if (!getChatEntry(chatKey) || (added.length === 0 && !rebuild)) return 'nothing';

    await ensureCompilerPreset();
    await configureIndependentPreset(COMPILER_PRESET, {
        enabled: true,
        connectionProfileId: settings.compilerConnectionProfileId || '',
        maxTokens: Number(settings.compilerMaxTokens) || null,
        promptedHeader: COMPILER_HEADER,
    });

    const recordsById = new Map(records.map((r) => [r.id, r]));
    const resolver = await entityResolver(ref.chatId);
    const nameCache = new Map();
    const nameOf = (id) => nameCache.get(id) ?? null;
    for (const id of new Set(added.flatMap((r) => r.entity_ids))) nameCache.set(id, await resolver.nameOf(id));

    // A rebuild with no memories at all still goes once, to an empty result.
    const batches = [];
    for (let i = 0; i < added.length; i += COMPILE_BATCH) batches.push(added.slice(i, i + COMPILE_BATCH));
    if (batches.length === 0) batches.push([]);
    setStatus({ batches: batches.length });

    for (let b = 0; b < batches.length; b++) {
        setStatus({ batch: b + 1 });
        const batch = batches[b];
        const refs = refsFor(batch);
        await updateIndependentPresetContext(COMPILER_PRESET, compileContext(compiled, batch, nameOf));
        const { ok, error } = await runIndependentWithRetry(COMPILER_PRESET, ref.chatId);
        const rawFacts = await readAndClear(ref.chatId, FACTS_VARIABLE);
        const rawRelationships = await readAndClear(ref.chatId, RELATIONSHIPS_VARIABLE);
        if (!ok && rawFacts.length === 0) throw new Error(error);

        const resolve = await resolveNames(rawFacts, rawRelationships, resolver);
        const next = parseCompileOutput(rawFacts, rawRelationships, { previous: compiled, refs, recordsById, resolve });
        if (!next) throw new Error('the model\'s answer dropped every fact - the previous compiled memory is kept');
        compiled = {
            ...next,
            included: [...new Set([...compiled.included, ...batch.map((r) => r.id)])],
            compiledAt: new Date().toISOString(),
        };
        // Saved after every batch: a long rebuild keeps what it has done.
        await writeCompiled(chatKey, compiled);
        if (chatKey === openKey()) openCache = { chatKey, compiled };
    }
    return 'compiled';
}

// Compiles the open chat now (manual: Compile now; `rebuild`: from every
// memory, starting over). Resolves to false when a run is already going or
// no chat is open, true once it has finished (see getCompilerStatus()).
export async function compileOpenChat({ rebuild = false, reason = 'manual' } = {}) {
    if (isCompiling()) return false;
    const ref = getCurrentChatRef();
    if (!ref) return false;
    status = { running: true, chatKey: chatKeyFor(ref), chatId: ref.chatId, rebuild, reason, batch: 0, batches: 0, outcome: null, error: null, finishedAt: null };
    setStatus({});
    let outcome;
    try {
        outcome = await compileRun(ref, { rebuild });
        if (outcome === 'compiled') {
            console.info(LOG_PREFIX, `compiled the memories of "${ref.chatId}" (${reason})`);
            emitCompiled(chatKeyFor(ref), ref.chatId);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'compiling failed', err);
        outcome = 'failed';
        setStatus({ error: err?.message ?? String(err) });
    }
    setStatus({ running: false, outcome, finishedAt: new Date().toISOString() });
    return true;
}

// ------------------------------------------------------------ reading

let openCache = null; // { chatKey, compiled } for the open chat

// The compiled state of `chatKey`: the open chat's from the cache while it
// is still the one on record (the registry entry's compile time - deleting
// a chat's memories removes the entry, so a stale cache is never used),
// otherwise read from its file.
async function compiledFor(chatKey) {
    const recorded = getChatEntry(chatKey)?.compiler?.at ?? null;
    if (openCache?.chatKey === chatKey && openCache.compiled.compiledAt === recorded) return openCache.compiled;
    const compiled = await readCompiled(chatKey);
    if (chatKey === openKey()) openCache = { chatKey, compiled };
    return compiled;
}

function openKey() {
    const ref = getCurrentChatRef();
    return ref ? chatKeyFor(ref) : null;
}

// The compiled memory of a chat (a SillyTavern chat id or a registry chat
// key; omitted: the open chat) - see buildCompiledView() in compile-plan.js
// for the shape - or null when nothing was ever compiled for it. Built
// against the chat's memories as they are now: facts resting only on
// deleted memories, or another swipe's, are left out.
export async function getCompiledMemory(chatId) {
    let chatKey = chatId === undefined || chatId === null ? openKey() : (getChatEntry(chatId) ? chatId : null);
    if (!chatKey && chatId) {
        const open = getCurrentChatRef();
        chatKey = open && open.chatId === chatId ? chatKeyFor(open)
            : findChatEntriesById(chatId).sort((a, b) => String(b.entry.updatedAt ?? '').localeCompare(String(a.entry.updatedAt ?? '')))[0]?.chatKey ?? null;
    }
    if (!chatKey || !getChatEntry(chatKey)) return null;
    try {
        const compiled = await compiledFor(chatKey);
        if (!compiled.compiledAt) return null;
        return structuredClone(buildCompiledView(compiled, await getAllMemories(chatKey)));
    } catch (err) {
        console.warn(LOG_PREFIX, `could not read the compiled memory of "${chatId ?? chatKey}"`, err);
        return null;
    }
}

// ------------------------------------------------------------ scheduling

// Whether the open chat should be compiled now, by schedule.js's rules:
// { compile, reason, added, removed, meaningful }.
export async function checkSchedule({ now = Date.now() } = {}) {
    const chatKey = openKey();
    if (!chatKey || !getChatEntry(chatKey)) return { compile: false, reason: 'no memories' };
    const records = await getAllMemories(chatKey);
    const compiled = await compiledFor(chatKey);
    const { added, removed } = changesSince(compiled, records);
    const before = records.filter((r) => !added.includes(r));
    const meaningful = meaningfulCount(added, before);
    return { ...shouldCompile({ meaningful, lastCompiledAt: compiled.compiledAt, now, settings: getSettings() }), added: added.length, removed, meaningful };
}

// Runs a compile when the schedule says so (automatic compiling on, and
// Archivist enabled). Never throws.
export async function maybeCompile() {
    const settings = getSettings();
    if (!settings.enabled || !settings.compileAuto || isCompiling()) return;
    try {
        const decision = await checkSchedule();
        if (decision.compile) await compileOpenChat({ reason: decision.reason });
    } catch (err) {
        console.warn(LOG_PREFIX, 'compiler schedule check failed', err);
    }
}

const CHECK_EVERY_MS = 60_000;
let checkTimer = null;

// Starts following memory changes (and the clock, for the time rule).
export function startCompiler() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    let pending = null;
    eventSource.on(MEMORIES_CHANGED_EVENT, ({ chatKey } = {}) => {
        if (chatKey && chatKey !== openKey()) return;
        // A burst of changes (a catch-up chunk, a swipe) is checked once.
        clearTimeout(pending);
        pending = setTimeout(() => void maybeCompile(), 2000);
    });
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        openCache = null;
    });
    clearInterval(checkTimer);
    checkTimer = setInterval(() => void maybeCompile(), CHECK_EVERY_MS);
}
