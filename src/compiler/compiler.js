// The Archivist Compiler: turns a chat's raw memories into structured,
// deduplicated knowledge - character profiles and insights, scene state,
// session details, relationships, story threads and quests, the world
// (secrets, locations, factions, items, events, lore) and a timeline - with
// colour tags (src/compiler/compiled-schema.js).
//
// The model work runs through two of Archivist's own INDEPENDENT State
// Engine presets, on the compiler's own connection - like catch-up:
//
//   "Archivist Memory Compiler"  facts, relationships, character insights
//   "Archivist World Compiler"   story threads, the world
//
// Two presets, so each answer stays a manageable size and each prompt shows
// only the lists that part updates. Their answers come back in NEW EACH TURN
// record lists (one per list), read and cleared after each run. Grouping,
// the timeline, the relationship map, the colour tags and the scheduling are
// code (compile-plan.js, schedule.js). The world part can be switched off
// (settings.compileWorld).
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
import { runIndependent } from '../extraction/independent-run.js';
import {
    EMPTY_COMPILED, COMPILED_SCHEMA, refsFor, compileContext, worldContext, parseCompileOutput, parseCharacters, parseThreads, parseWorld, changesSince, buildCompiledView,
} from './compile-plan.js';
import { meaningfulCount, shouldCompile } from './schedule.js';

export const COMPILER_PRESET = 'Archivist Memory Compiler';
export const WORLD_COMPILER_PRESET = 'Archivist World Compiler';
export const FACTS_VARIABLE = 'compiled_facts';
export const RELATIONSHIPS_VARIABLE = 'compiled_relationships';
export const CHARACTERS_VARIABLE = 'compiled_characters';
export const THREADS_VARIABLE = 'compiled_threads';
export const WORLD_VARIABLE = 'compiled_world';

// Raised whenever the variables' definitions or the headers change (see
// LIVE_VARIABLE_VERSION in src/extraction/live.js).
// 2: character insights; relationship polarity, intensity, trend; the
// world compiler.
export const COMPILER_VARIABLE_VERSION = 2;

// New memories per compile run.
export const COMPILE_BATCH = 60;

// Emitted on SillyTavern's event bus after a chat's compiled memory changes,
// with { chatId, chatKey }.
export const COMPILED_CHANGED_EVENT = 'archivist_compiled_changed';

const SILENT = [
    'You are a silent background memory-compilation process for a roleplay chat application.',
    'You are not a character in the roleplay and must not narrate, comment, or add anything besides the requested output.',
    // Small models wrote `"motivations": [] (unknown)` - not JSON.
    'Answer in strict JSON: for anything not known, use [] or "" - never add notes, comments or anything else outside the quoted values.',
];

export const COMPILER_HEADER = [
    ...SILENT,
    'You will be given the current compiled knowledge about a story - facts (each with an id like [f3]), relationships and character insights - and new memories extracted from the story (each with a ref like [m1]).',
    'Update the compiled knowledge with the new memories: evaluate each variable according to its conditions and return the required JSON output.',
    '',
].join('\n');

export const WORLD_COMPILER_HEADER = [
    ...SILENT,
    'You will be given the current compiled knowledge about a story\'s world - story threads (each with an id like [t2]) and world entries (each with an id like [w5]) - and new memories extracted from the story (each with a ref like [m1]).',
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
    'The COMPLETE updated list of relationships, one item for each direction of a pair (how A sees B, and how B sees A, can differ) - keep the current ones that still hold, revise them as the new memories change them, add new ones.',
    'Each item is an object: {"from": a name; "to": a name;',
    '"type": what the relationship is, in your own words - friend, enemy, mentor, student, colleague, boss, client, rival, crush, partner, family, acquaintance, stranger, or whatever fits best;',
    '"polarity": how "from" feels toward "to", a whole number from -3 to 3: -3 hostile, -2 antagonistic, -1 wary, 0 neutral, 1 friendly, 2 close, 3 devoted;',
    '"intensity": how strong or central the relationship is to "from" - "low", "medium" or "high";',
    '"trend": "warming", "cooling", "stable" or "volatile";',
    '"text": one sentence describing it; "sources": the refs [m...] of the NEW memories that show it ([] if none)}.',
].join(' ');

const CHARACTERS_INSTRUCTIONS = [
    'The COMPLETE updated list of character insights - one item per character the memories show enough of, inferred from what they do, say, choose and go through; keep the current ones, revised and added to by the new memories.',
    'Each item is an object: {"name": the character\'s name as the story names them;',
    '"traits": personality traits their behaviour shows (a list of short phrases);',
    '"habits": habits and routines;',
    '"stressors": what puts them under strain or worries them;',
    '"motivations": what drives them - wants, needs, goals;',
    '"arc": one or two sentences on how they have changed over the story so far and where they seem to be heading;',
    '"emotional_state": how they have been feeling lately, in a few words;',
    '"sources": the refs [m...] of the NEW memories it draws on ([] if none)}.',
].join(' ');

const THREADS_INSTRUCTIONS = [
    'The COMPLETE updated list of story threads: plot hooks, unresolved narrative threads, open questions, promises, plans and quest seeds - anything set up that could be picked up later or is still open.',
    'Keep the current ones, update their status and progress from the new memories, add new ones; keep a resolved thread, marked resolved.',
    'Each item is an object: {"id": the id of the current thread it continues, or t<number> for a new one;',
    '"kind": "plot hook", "unresolved thread", "quest seed", "quest", "mystery", "goal" or another short label;',
    '"title": a short name for it;',
    '"text": what it is and why it matters;',
    '"status": "open" (set up, not taken up yet), "active" (being pursued), "resolved" or "abandoned";',
    '"progress": what has happened with it so far and what is next ("" if nothing yet);',
    '"involved": the names of the characters, places, factions and things involved;',
    '"sources": the refs [m...] of the NEW memories it uses ([] if none)}.',
].join(' ');

const WORLD_INSTRUCTIONS = [
    'The COMPLETE updated list of what the memories establish about the world - keep the current entries, revised by the new memories, and add new ones. Record every place mentioned, and anything that appears more than once.',
    'Each item is an object: {"id": the id of the current entry it continues, or w<number> for a new one;',
    '"kind": "secret" (something hidden from some of the characters), "location" (any place - a building, a room, a street, a city), "faction" (a group, team, business, organization, gang, staff or crowd), "item" (an object that matters or keeps appearing), "event" (an ongoing world event or condition - weather, shortages, holidays, emergencies, local happenings) or "lore" (how the world works - rules, customs, cultural norms, recurring patterns);',
    '"name": its name, or a short label;',
    '"text": what is known about it;',
    '"known_by": for a secret, the names of the characters who know it ([] otherwise);',
    '"involved": the names of the characters, places, factions and things connected to it;',
    '"status": for an event, "ongoing" or "over" ("" otherwise);',
    '"sources": the refs [m...] of the NEW memories it uses ([] if none)}.',
].join(' ');

function variableDef(instructions, label, itemSchema) {
    return {
        label,
        description: 'Archivist compiler output. Read and cleared by Archivist after each run.',
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

const PRESETS = [
    {
        name: COMPILER_PRESET,
        header: COMPILER_HEADER,
        description: 'Archivist: compiles a chat\'s memories into facts, relationships and character insights. Run from the Archivist drawer.',
        variables: [
            [FACTS_VARIABLE, () => variableDef(FACTS_INSTRUCTIONS, 'Compiled facts', { text: { type: 'string' } })],
            [RELATIONSHIPS_VARIABLE, () => variableDef(RELATIONSHIPS_INSTRUCTIONS, 'Compiled relationships', { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string' } })],
            [CHARACTERS_VARIABLE, () => variableDef(CHARACTERS_INSTRUCTIONS, 'Compiled character insights', { name: { type: 'string' } })],
        ],
    },
    {
        name: WORLD_COMPILER_PRESET,
        header: WORLD_COMPILER_HEADER,
        description: 'Archivist: compiles a chat\'s memories into story threads, quests, secrets, locations, factions, items, world events and lore. Run from the Archivist drawer.',
        variables: [
            [THREADS_VARIABLE, () => variableDef(THREADS_INSTRUCTIONS, 'Compiled story threads', { text: { type: 'string' } })],
            [WORLD_VARIABLE, () => variableDef(WORLD_INSTRUCTIONS, 'Compiled world', { text: { type: 'string' } })],
        ],
    },
];

// ------------------------------------------------------------- the presets

// Creates the compiler presets and their variables if missing, updating
// the variables when COMPILER_VARIABLE_VERSION has moved on. Throws if
// State Engine refuses.
export async function ensureCompilerPreset() {
    const settings = getSettings();
    const outdated = settings.compilerVariableVersion !== COMPILER_VARIABLE_VERSION;
    for (const preset of PRESETS) {
        if (!await findPreset(preset.name)) {
            const created = await createIndependentPreset({ name: preset.name, description: preset.description, promptedHeader: preset.header });
            if (!created) throw new Error(`could not create the ${preset.name} preset`);
        }
        for (const [name, def] of preset.variables) {
            if (!await getVariable(preset.name, name)) {
                if (!await createVariable(preset.name, name, def())) throw new Error(`could not create the ${name} variable`);
            } else if (outdated && !await updateVariable(preset.name, name, def())) {
                throw new Error(`could not update the ${name} variable`);
            }
        }
    }
    if (outdated) {
        settings.compilerVariableVersion = COMPILER_VARIABLE_VERSION;
        saveSettings();
    }
}

// ------------------------------------------------------------ storage

const list = (value) => (Array.isArray(value) ? value : []);

// A file from before the world compiler has no `schema`: it is 1.
const normalizeCompiled = (data) => ({
    facts: list(data?.facts),
    relationships: list(data?.relationships),
    characters: list(data?.characters),
    threads: list(data?.threads),
    world: list(data?.world),
    included: list(data?.included),
    compiledAt: data?.compiledAt ?? null,
    schema: data ? (data.schema ?? 1) : COMPILED_SCHEMA,
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

// The current (or last) run, for the drawer and the memory browser:
// { running, chatKey, chatId, rebuild, reason, batch, batches, part:
//   'memory' | 'world' | null, outcome: null | 'compiled' | 'nothing' |
//   'failed', error, finishedAt }
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

// Looks entity names up among State Engine's objects, for one chat.
export async function entityResolver(chatId) {
    const types = await listObjectTypeIds();
    const cache = new Map();
    const names = new Map();
    return {
        // { id | null, name, type | null } for a name.
        async resolve(name) {
            const key = name.toLowerCase();
            if (cache.has(key)) return cache.get(key);
            let found = null;
            let foundType = null;
            for (const type of types) {
                try {
                    found = await getObjectByAlias(chatId, type, name);
                } catch {
                    found = null;
                }
                if (found?.id) {
                    foundType = type;
                    break;
                }
            }
            const entity = found?.id ? { id: found.id, name: found.name ?? name, type: foundType } : { id: null, name, type: null };
            cache.set(key, entity);
            return entity;
        },
        // A display name for an entity id, or null.
        async nameOf(id) {
            if (names.has(id)) return names.get(id);
            let name = null;
            try {
                name = (await getObject(chatId, id))?.name ?? null;
            } catch {
                name = null;
            }
            names.set(id, name);
            return name;
        },
    };
}

// The parse functions need a synchronous resolve(): names are looked up
// first, then handed over.
async function resolveNames(answers, resolver) {
    const wanted = new Set();
    const add = (v) => {
        const items = typeof v === 'string' ? v.split(',') : (Array.isArray(v) ? v : []);
        for (const n of items) if (typeof n === 'string' && n.trim()) wanted.add(n.trim());
    };
    for (const f of list(answers.facts)) add(f?.entities);
    for (const r of list(answers.relationships)) add([r?.from, r?.to]);
    for (const c of list(answers.characters)) add([c?.name]);
    for (const t of list(answers.threads)) {
        add([t?.title]);
        add(t?.involved ?? t?.entities);
    }
    for (const w of list(answers.world)) {
        add([w?.name]);
        add(w?.known_by);
        add(w?.involved ?? w?.entities);
    }
    const resolved = new Map();
    for (const name of wanted) resolved.set(name, await resolver.resolve(name));
    return (name) => resolved.get(name) ?? { id: null, name, type: null };
}

async function readAndClear(chatId, presetName, name) {
    const value = await getVariableValue(chatId, name);
    if (Array.isArray(value) && value.length) await setVariableValue(chatId, presetName, name, []);
    return Array.isArray(value) ? value : [];
}

// Runs one part's preset with `context`; resolves to its variables'
// answers, by variable name. Throws when the run failed and wrote nothing.
async function runPart(presetName, variables, context, chatId) {
    await updateIndependentPresetContext(presetName, context);
    const { ok, error } = await runIndependent(presetName, chatId);
    const answers = {};
    for (const name of variables) answers[name] = await readAndClear(chatId, presetName, name);
    if (!ok && Object.values(answers).every((a) => a.length === 0)) throw new Error(error);
    return answers;
}

async function compileRun(ref, { rebuild }) {
    const settings = getSettings();
    const chatKey = chatKeyFor(ref);
    const records = await getAllMemories(chatKey);
    let compiled = rebuild ? { ...EMPTY_COMPILED } : await compiledFor(chatKey);
    const { added } = changesSince(compiled, records);
    if (!getChatEntry(chatKey) || (added.length === 0 && !rebuild)) return 'nothing';
    const withWorld = settings.compileWorld !== false;

    await ensureCompilerPreset();
    for (const preset of PRESETS) {
        await configureIndependentPreset(preset.name, {
            enabled: preset.name === COMPILER_PRESET || withWorld,
            connectionProfileId: settings.compilerConnectionProfileId || '',
            maxTokens: Number(settings.compilerMaxTokens) || null,
            promptedHeader: preset.header,
        });
    }

    const recordsById = new Map(records.map((r) => [r.id, r]));
    const resolver = await entityResolver(ref.chatId);
    const nameCache = new Map();
    const nameOf = (id) => nameCache.get(id) ?? null;
    for (const id of new Set(added.flatMap((r) => [...r.entity_ids, ...(r.witness_ids ?? [])]))) nameCache.set(id, await resolver.nameOf(id));

    // A rebuild with no memories at all still goes once, to an empty result.
    const batches = [];
    for (let i = 0; i < added.length; i += COMPILE_BATCH) batches.push(added.slice(i, i + COMPILE_BATCH));
    if (batches.length === 0) batches.push([]);
    setStatus({ batches: batches.length });

    for (let b = 0; b < batches.length; b++) {
        setStatus({ batch: b + 1, part: 'memory' });
        const batch = batches[b];
        const refs = refsFor(batch);
        const memory = await runPart(COMPILER_PRESET, [FACTS_VARIABLE, RELATIONSHIPS_VARIABLE, CHARACTERS_VARIABLE], compileContext(compiled, batch, nameOf), ref.chatId);
        let world = { [THREADS_VARIABLE]: [], [WORLD_VARIABLE]: [] };
        if (withWorld) {
            setStatus({ part: 'world' });
            world = await runPart(WORLD_COMPILER_PRESET, [THREADS_VARIABLE, WORLD_VARIABLE], worldContext(compiled, batch, nameOf), ref.chatId);
        }

        const resolve = await resolveNames({
            facts: memory[FACTS_VARIABLE], relationships: memory[RELATIONSHIPS_VARIABLE], characters: memory[CHARACTERS_VARIABLE],
            threads: world[THREADS_VARIABLE], world: world[WORLD_VARIABLE],
        }, resolver);
        const options = { previous: compiled, refs, recordsById, resolve };
        const next = parseCompileOutput(memory[FACTS_VARIABLE], memory[RELATIONSHIPS_VARIABLE], options);
        if (!next) throw new Error('the model\'s answer dropped every fact - the previous compiled memory is kept');
        compiled = {
            ...next,
            characters: parseCharacters(memory[CHARACTERS_VARIABLE], options),
            threads: withWorld ? parseThreads(world[THREADS_VARIABLE], options) : compiled.threads,
            world: withWorld ? parseWorld(world[WORLD_VARIABLE], options) : compiled.world,
            included: [...new Set([...compiled.included, ...batch.map((r) => r.id)])],
            compiledAt: new Date().toISOString(),
            // An older state stays flagged until rebuilt: its insights,
            // threads and world only cover the memories since.
            schema: compiled.schema,
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
    status = { running: true, chatKey: chatKeyFor(ref), chatId: ref.chatId, rebuild, reason, batch: 0, batches: 0, part: null, outcome: null, error: null, finishedAt: null };
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
    setStatus({ running: false, part: null, outcome, finishedAt: new Date().toISOString() });
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

// The registry chat key for a SillyTavern chat id or a chat key (omitted:
// the open chat), or null.
export function resolveChatKey(chatId) {
    let chatKey = chatId === undefined || chatId === null ? openKey() : (getChatEntry(chatId) ? chatId : null);
    if (!chatKey && chatId) {
        const open = getCurrentChatRef();
        chatKey = open && open.chatId === chatId ? chatKeyFor(open)
            : findChatEntriesById(chatId).sort((a, b) => String(b.entry.updatedAt ?? '').localeCompare(String(a.entry.updatedAt ?? '')))[0]?.chatKey ?? null;
    }
    return chatKey && getChatEntry(chatKey) ? chatKey : null;
}

// Names for every witness on the timeline: id -> name.
async function witnessNames(chatId, records) {
    const ids = new Set(records.filter((r) => r.subtype === 'event').flatMap((r) => r.witness_ids ?? []));
    const names = new Map();
    for (const id of ids) {
        try {
            names.set(id, (await getObject(chatId, id))?.name ?? null);
        } catch {
            names.set(id, null);
        }
    }
    return names;
}

// The compiled memory of a chat (a SillyTavern chat id or a registry chat
// key; omitted: the open chat) - see buildCompiledView() in compile-plan.js
// for the shape - or null when nothing was ever compiled for it. Built
// against the chat's memories as they are now: items resting only on
// deleted memories, or another swipe's, are left out.
export async function getCompiledMemory(chatId) {
    const chatKey = resolveChatKey(chatId);
    if (!chatKey) return null;
    try {
        const compiled = await compiledFor(chatKey);
        if (!compiled.compiledAt) return null;
        const records = await getAllMemories(chatKey);
        const names = await witnessNames(getChatEntry(chatKey).chatId, records);
        return structuredClone(buildCompiledView(compiled, records, (id) => names.get(id) ?? null));
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
