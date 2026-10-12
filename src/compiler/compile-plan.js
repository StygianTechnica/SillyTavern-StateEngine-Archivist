// The compiler's plain functions - no State Engine or SillyTavern calls, so
// they can be tested on their own. The runner is src/compiler/compiler.js.
//
// A COMPILED state (stored per chat, compiled-storage in compiler.js):
//   { facts, relationships, characters, threads, world: [...],
//     included: [memory ids already compiled in], compiledAt, schema }
//   entity        { id | null, name, type | null } - a State Engine object
//                 (type: its object type) or just a name the story uses
//   fact          { id: "f<n>", text, classification, theme,
//                   entities: [entity], sources: [memory ids],
//                   contradicts: [fact ids] }
//   relationship  { from: entity, to: entity, type, polarity (-3..3),
//                   intensity, trend, text, sources } - one per direction
//                   of a pair; `type` is the model's own words (friend,
//                   mentor, rival...), never a fixed list
//   character     { entity, traits, habits, stressors, motivations: [text],
//                   arc, emotional_state, sources } - inferred insights
//   thread        { id: "t<n>", kind, title, text, status, progress,
//                   entity (an object of its title - a quest - or null),
//                   involved: [entity], sources } - plot hooks, open
//                   threads, quest seeds
//   world entry   { id: "w<n>", kind (WORLD_KINDS), name, text,
//                   entity (the object it names, or null), known_by:
//                   [entity] (secrets), involved: [entity], status, sources }
//   schema        COMPILED_SCHEMA when compiled; an older state (1: facts
//                 and relationships only) is still read, and flagged
//                 `outdated` in the view until rebuilt
//
// A compile run is two parts, each through its own preset (compiler.js):
// the MEMORY part (facts, relationships, characters) and the WORLD part
// (threads, world). Each hands the model its current lists plus a batch of
// new memories (each as [m<n>]) and gets back the complete, updated lists;
// the parse* functions turn that answer into the next state, keeping each
// continued item's earlier sources. buildCompiledView() turns a state into
// what the API returns, colour-tagged, every item linked back to the chat
// messages it rests on (through its source memories, whose message indexes
// message-sync keeps current).

import {
    normalizeClassification, SCOPE_CLASSIFICATION, withColorTag, normalizePolarity, polarityLabel, normalizeIntensity, normalizeTrend,
    normalizeThreadStatus, normalizeWorldKind, normalizeSecretStatus, WORLD_KINDS, THREAD_STATUSES,
} from './compiled-schema.js';
import { parseSource, messageDateOf } from '../memory/message-sync-plan.js';

export const COMPILED_SCHEMA = 2;

export const EMPTY_COMPILED = Object.freeze({
    facts: [], relationships: [], characters: [], threads: [], world: [], included: [], compiledAt: null, schema: COMPILED_SCHEMA,
});

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const names = (value) => {
    const list = typeof value === 'string' ? value.split(',') : (Array.isArray(value) ? value : []);
    return [...new Set(list.filter(isText).map((n) => n.trim()))];
};
const text = (value) => (isText(value) ? value.trim() : '');
const words = (token) => String(token ?? '').replace(/_/g, ' ');
const messageIndexOf = (record) => parseSource(record?.source_message_id)?.index ?? null;
const entityKey = (e) => (e.id ?? `name:${String(e.name ?? '').toLowerCase()}`);
const nameOfEntity = (e) => e?.name ?? '';

// ---- the run's context

// Local refs for a batch of memories: [m1], [m2]... -> Map ref -> memory id.
export function refsFor(records) {
    return new Map(records.map((record, i) => [`m${i + 1}`, record.id]));
}

function entityList(entities) {
    return (entities ?? []).map(nameOfEntity).filter(Boolean).join(', ');
}

// One new memory, as the model reads it.
function memoryLine(record, ref, nameOf) {
    const named = (ids) => (ids ?? []).map((id) => nameOf(id) ?? id).join(', ');
    const about = named(record.entity_ids);
    const where = messageIndexOf(record);
    const details = [record.subtype, words(record.scope), record.importance];
    if (where !== null) details.push(`message #${where}`);
    const extra = [];
    if (record.tags?.length) extra.push(`tags: ${record.tags.join(', ')}`);
    if (record.tone) extra.push(`tone: ${record.tone}`);
    if (record.witness_ids?.length) extra.push(`present: ${named(record.witness_ids)}`);
    return `[${ref}] (${details.join(', ')}${extra.length ? `; ${extra.join('; ')}` : ''})${about ? ` about ${about}` : ''}: ${record.text}`;
}

function newMemoryLines(batch, nameOf) {
    const refs = [...refsFor(batch).keys()];
    return ['', 'New memories:', ...batch.map((record, i) => memoryLine(record, refs[i], nameOf))];
}

function relationshipLine(r) {
    const polarity = normalizePolarity(r.polarity);
    const details = [r.type, `${polarityLabel(polarity)} (${polarity > 0 ? '+' : ''}${polarity})`, `${r.intensity ?? 'medium'} intensity`];
    if (r.trend) details.push(r.trend);
    return `- ${r.from.name} -> ${r.to.name}: ${details.join(' · ')}: ${r.text}`;
}

function characterLine(c) {
    const parts = [];
    for (const field of ['traits', 'habits', 'stressors', 'motivations']) if (c[field]?.length) parts.push(`${field}: ${c[field].join(', ')}`);
    if (c.arc) parts.push(`arc: ${c.arc}`);
    if (c.emotional_state) parts.push(`feeling: ${c.emotional_state}`);
    return `- ${c.entity.name}: ${parts.join('; ') || '(nothing yet)'}`;
}

// What the MEMORY part's model reads: the current facts, relationships and
// character insights, then the new memories. `nameOf(id)` -> a display
// name for an entity id (or null).
export function compileContext(previous, batch, nameOf = () => null) {
    const lines = ['Current compiled knowledge:', 'Facts:'];
    if (previous.facts.length === 0) lines.push('(none yet)');
    for (const fact of previous.facts) {
        const about = entityList(fact.entities);
        lines.push(`[${fact.id}] ${fact.classification} · ${fact.theme || 'general'}${about ? ` · about ${about}` : ''}: ${fact.text}`);
    }
    lines.push('Relationships:');
    if (previous.relationships.length === 0) lines.push('(none yet)');
    for (const r of previous.relationships) lines.push(relationshipLine(r));
    lines.push('Characters:');
    if (!previous.characters?.length) lines.push('(none yet)');
    for (const c of previous.characters ?? []) lines.push(characterLine(c));
    lines.push(...newMemoryLines(batch, nameOf));
    return lines.join('\n');
}

// What the WORLD part's model reads: the current threads and world entries,
// then the new memories.
export function worldContext(previous, batch, nameOf = () => null) {
    const lines = ['Current compiled knowledge:', 'Story threads:'];
    if (!previous.threads?.length) lines.push('(none yet)');
    for (const t of previous.threads ?? []) {
        const involved = entityList(t.involved);
        lines.push(`[${t.id}] ${t.kind} · ${t.status}${involved ? ` · involves ${involved}` : ''}: ${t.title} - ${t.text}${t.progress ? ` (progress: ${t.progress})` : ''}`);
    }
    lines.push('World:');
    if (!previous.world?.length) lines.push('(none yet)');
    for (const w of previous.world ?? []) {
        const knownBy = entityList(w.known_by);
        lines.push(`[${w.id}] ${w.kind} · ${w.name}${knownBy ? ` · known by ${knownBy}` : ''}${w.status ? ` · ${w.status}` : ''}: ${w.text}`);
    }
    lines.push(...newMemoryLines(batch, nameOf));
    return lines.join('\n');
}

// ---- the run's answer

// The classification most of a fact's sources point to, by their scope.
function classificationFromSources(sourceIds, recordsById) {
    const counts = {};
    for (const id of sourceIds) {
        const c = SCOPE_CLASSIFICATION[recordsById.get(id)?.scope];
        if (c) counts[c] = (counts[c] ?? 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'SESSION';
}

// "[m2]", "m2" -> memory id via `refs`; unknown refs are dropped.
const sourceIdsOf = (value, refs) => names(value).map((ref) => refs.get(ref.replace(/^\[|\]$/g, ''))).filter(Boolean);

// Ids for a list answer with "<prefix><n>" ids: a continued item keeps its
// id, a missing, malformed or repeated one gets the next free number.
// Returns a function raw -> id.
function idAssigner(prefix, previousItems) {
    const pattern = new RegExp(`^${prefix}\\d+$`);
    const previousIds = new Set(previousItems.map((item) => item.id));
    let next = Math.max(0, ...previousItems.map((item) => Number(String(item.id).slice(prefix.length)) || 0)) + 1;
    const seen = new Set();
    return (raw) => {
        let id = String(raw?.id ?? '').trim();
        if (!pattern.test(id) || seen.has(id)) id = `${prefix}${next++}`;
        else if (!previousIds.has(id)) next = Math.max(next, Number(id.slice(prefix.length)) + 1);
        seen.add(id);
        return id;
    };
}

// The next facts and relationships from the model's answer, or null when
// the answer can't be trusted (it would drop every fact while there were
// some).
//   rawFacts, rawRelationships  the two variables' values
//   previous                    the compiled state the run started from
//   refs                        refsFor() of the batch
//   recordsById                 Map id -> memory record (for fallbacks)
//   resolve(name)               -> entity for a name
export function parseCompileOutput(rawFacts, rawRelationships, { previous, refs, recordsById, resolve }) {
    const previousById = new Map(previous.facts.map((f) => [f.id, f]));
    const nextId = idAssigner('f', previous.facts);
    const facts = [];
    for (const raw of Array.isArray(rawFacts) ? rawFacts : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.text)) continue;
        const id = nextId(raw);
        const sources = [...new Set([...(previousById.get(id)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])];
        facts.push({
            id,
            text: raw.text.trim(),
            classification: normalizeClassification(raw.classification, classificationFromSources(sources, recordsById)),
            theme: isText(raw.theme) ? raw.theme.trim().toLowerCase() : 'general',
            entities: names(raw.entities).map(resolve),
            sources,
            contradicts: names(raw.contradicts),
        });
    }
    if (previous.facts.length > 0 && facts.length === 0) return null;
    const ids = new Set(facts.map((f) => f.id));
    for (const fact of facts) fact.contradicts = fact.contradicts.filter((other) => other !== fact.id && ids.has(other));

    return { facts, relationships: parseRelationships(rawRelationships, { previous, refs, resolve }) };
}

// One relationship per direction of a pair: from -> to.
const relKey = (r) => `${entityKey(r.from)}|${entityKey(r.to)}`;

// An empty answer for a list that had items is taken as the model leaving
// it out, not as everything in it ending: the previous items are kept.
function keepIfLeftOut(next, previousItems) {
    return next.length === 0 && previousItems.length > 0 ? previousItems : next;
}

export function parseRelationships(rawRelationships, { previous, refs, resolve }) {
    const previousRel = new Map((previous.relationships ?? []).map((r) => [relKey(r), r]));
    const relationships = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawRelationships) ? rawRelationships : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.from) || !isText(raw.to) || !isText(raw.type)) continue;
        const rel = {
            from: resolve(raw.from.trim()),
            to: resolve(raw.to.trim()),
            type: raw.type.trim().toLowerCase(),
            polarity: normalizePolarity(raw.polarity),
            intensity: normalizeIntensity(raw.intensity),
            trend: normalizeTrend(raw.trend),
            text: text(raw.text),
            sources: [],
        };
        const key = relKey(rel);
        if (seen.has(key)) continue;
        seen.add(key);
        rel.sources = [...new Set([...(previousRel.get(key)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])];
        if (!rel.text) rel.text = `${rel.from.name} -> ${rel.to.name}: ${rel.type}.`;
        relationships.push(rel);
    }
    return keepIfLeftOut(relationships, previous.relationships ?? []);
}

const phraseList = (value) => names(value).map((p) => p.replace(/\.$/, ''));

// Character insights, one per entity.
export function parseCharacters(rawCharacters, { previous, refs, resolve }) {
    const previousByKey = new Map((previous.characters ?? []).map((c) => [entityKey(c.entity), c]));
    const characters = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawCharacters) ? rawCharacters : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.name)) continue;
        const entity = resolve(raw.name.trim());
        const key = entityKey(entity);
        if (seen.has(key)) continue;
        seen.add(key);
        characters.push({
            entity,
            traits: phraseList(raw.traits),
            habits: phraseList(raw.habits),
            stressors: phraseList(raw.stressors),
            motivations: phraseList(raw.motivations),
            arc: text(raw.arc),
            emotional_state: text(raw.emotional_state ?? raw.feeling),
            sources: [...new Set([...(previousByKey.get(key)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])],
        });
    }
    return keepIfLeftOut(characters, previous.characters ?? []);
}

// Story threads: plot hooks, unresolved threads, quest seeds. `resolve`
// links a thread whose title names an object (a quest) to it.
export function parseThreads(rawThreads, { previous, refs, resolve }) {
    const previousById = new Map((previous.threads ?? []).map((t) => [t.id, t]));
    const nextId = idAssigner('t', previous.threads ?? []);
    const threads = [];
    for (const raw of Array.isArray(rawThreads) ? rawThreads : []) {
        if (!raw || typeof raw !== 'object' || !(isText(raw.text) || isText(raw.title))) continue;
        const id = nextId(raw);
        const title = text(raw.title) || text(raw.text).split(/[.!?]/)[0].slice(0, 80);
        const linked = resolve(title);
        threads.push({
            id,
            kind: text(raw.kind).toLowerCase() || 'unresolved thread',
            title,
            text: text(raw.text) || title,
            status: normalizeThreadStatus(raw.status),
            progress: text(raw.progress),
            entity: linked.id ? linked : null,
            involved: names(raw.involved ?? raw.entities).map(resolve),
            sources: [...new Set([...(previousById.get(id)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])],
        });
    }
    return keepIfLeftOut(threads, previous.threads ?? []);
}

// World entries: secrets, locations, factions, items, events, lore.
export function parseWorld(rawWorld, { previous, refs, resolve }) {
    const previousById = new Map((previous.world ?? []).map((w) => [w.id, w]));
    const nextId = idAssigner('w', previous.world ?? []);
    const world = [];
    for (const raw of Array.isArray(rawWorld) ? rawWorld : []) {
        if (!raw || typeof raw !== 'object' || !(isText(raw.text) || isText(raw.name))) continue;
        const id = nextId(raw);
        const kind = normalizeWorldKind(raw.kind);
        const name = text(raw.name) || text(raw.text).split(/[.!?]/)[0].slice(0, 80);
        // A secret is named by what it hides, not by an object.
        const linked = kind === 'secret' ? { id: null } : resolve(name);
        world.push({
            id,
            kind,
            name,
            text: text(raw.text) || name,
            entity: linked.id ? linked : null,
            known_by: names(raw.known_by).map(resolve),
            involved: names(raw.involved ?? raw.entities).map(resolve),
            status: kind === 'secret' ? normalizeSecretStatus(raw.status) : text(raw.status).toLowerCase(),
            sources: [...new Set([...(previousById.get(id)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])],
        });
    }
    return keepIfLeftOut(world, previous.world ?? []);
}

// ---- what is new since the last compile

// { added: records not compiled in yet, removed: how many compiled-in
// memories are gone (deleted, or a swipe not shown) }.
export function changesSince(compiled, records) {
    const included = new Set(compiled.included);
    const present = new Set(records.map((r) => r.id));
    return {
        added: records.filter((r) => !included.has(r.id)),
        removed: compiled.included.filter((id) => !present.has(id)).length,
    };
}

// ---- the view the API returns

// An item still stands while at least one memory it rests on is present
// (one with no sources stands).
const stands = (item, present) => item.sources.length === 0 || item.sources.some((id) => present.has(id));

// Where in the chat an item comes from, through its present source
// memories: { chat_id, source_memory_ids, source_messages: [{ memory_id,
// message_index, source_message_id, message_date }] in story order,
// message_range: { from, to } | null } - so a UI can jump to that part of
// the chat.
function withMessageLinks(item, byId) {
    const sources = item.sources.map((id) => byId.get(id)).filter(Boolean);
    const messages = sources
        .map((r) => ({ memory_id: r.id, message_index: messageIndexOf(r), source_message_id: r.source_message_id, message_date: messageDateOf(r) }))
        .sort((a, b) => (a.message_index ?? Infinity) - (b.message_index ?? Infinity));
    const indexes = messages.map((m) => m.message_index).filter((i) => i !== null);
    return {
        ...item,
        chat_id: sources[0]?.chat_id ?? null,
        source_memory_ids: sources.map((r) => r.id),
        source_messages: messages,
        message_range: indexes.length ? { from: Math.min(...indexes), to: Math.max(...indexes) } : null,
    };
}

// A relationship as the view hands it out: its polarity's word too.
const relationshipView = (r) => ({ ...r, polarity: normalizePolarity(r.polarity), polarity_label: polarityLabel(r.polarity), intensity: r.intensity ?? 'medium', trend: r.trend ?? '' });

// The newest tones among the memories, most frequent first:
// [{ tone, count }], at most 3, from the last `window` memories in story
// order.
function recentTone(records, window = 20) {
    const ordered = records
        .map((r, order) => ({ r, order, index: messageIndexOf(r) }))
        .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || a.order - b.order)
        .slice(-window);
    const counts = new Map();
    for (const { r } of ordered) if (r.tone) counts.set(r.tone, (counts.get(r.tone) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tone, count]) => ({ tone, count }));
}

// The compiled view of `compiled` for the chat's `records` as they are now
// (deleted memories and other swipes' left out). `nameOf(id)` gives names
// for the witnesses on the timeline (null when unknown).
//   { compiledAt, outdated,
//     character_profiles: [{ entity_id, entity_type, name, facts, traits,
//       habits, stressors, motivations, arc, emotional_state,
//       relationships: [relationship with direction 'out' | 'in'] }],
//     scene_state: [fact], session_details: [fact],
//     relationships: [relationship], relationship_map: { entities: [entity],
//       cells: [{ from, to, polarity, polarity_label, type, intensity }] },
//     threads: [thread], quests: [thread] (those with an object or kind
//       quest), world: { secret: [...], location: [...], ... },
//     timeline: [{ memory_id, text, entity_ids, witnesses: [{ id, name }],
//       major, tags, tone, importance, message_index, message_date,
//       source_message_id, chat_id, scope, created_at }],
//     recent_tone: [{ tone, count }], pending }
// Every item carries its colour tag (facts, relationships) and its message
// links (withMessageLinks() above).
export function buildCompiledView(compiled, records, nameOf = () => null) {
    const present = new Set(records.map((r) => r.id));
    const byId = new Map(records.map((r) => [r.id, r]));
    const facts = compiled.facts.filter((f) => stands(f, present));
    const live = new Set(facts.map((f) => f.id));
    const contradicted = new Set();
    for (const f of facts) {
        for (const other of f.contradicts) {
            if (!live.has(other)) continue;
            contradicted.add(f.id);
            contradicted.add(other);
        }
    }
    const tagged = facts.map((f) => withColorTag(withMessageLinks({ ...f, contradicts: f.contradicts.filter((id) => live.has(id)) }, byId), {
        classification: f.classification, contradiction: contradicted.has(f.id),
    }));
    const relationships = (compiled.relationships ?? []).filter((r) => stands(r, present))
        .map((r) => withColorTag(withMessageLinks(relationshipView(r), byId), { relationship: true }));
    const characters = (compiled.characters ?? []).filter((c) => stands(c, present));

    // Profiles: one per entity with lasting facts or character insights.
    const profiles = new Map();
    const profileOf = (entity) => {
        const key = entity.id ?? `name:${String(entity.name ?? '').toLowerCase()}`;
        if (!profiles.has(key)) {
            profiles.set(key, {
                entity_id: entity.id ?? null, entity_type: entity.type ?? null, name: entity.name || 'General', facts: [],
                traits: [], habits: [], stressors: [], motivations: [], arc: '', emotional_state: '', relationships: [],
            });
        }
        return profiles.get(key);
    };
    for (const fact of tagged.filter((f) => f.classification === 'PERMANENT')) {
        for (const entity of fact.entities.length ? fact.entities : [{ id: null, name: '' }]) profileOf(entity).facts.push(fact);
    }
    for (const c of characters) {
        const { entity, sources, ...insights } = c;
        Object.assign(profileOf(entity), insights, { source_memory_ids: sources.filter((id) => present.has(id)) });
    }
    for (const r of relationships) {
        if (profiles.has(entityKey(r.from))) profiles.get(entityKey(r.from)).relationships.push({ ...r, direction: 'out', other: r.to });
        if (profiles.has(entityKey(r.to))) profiles.get(entityKey(r.to)).relationships.push({ ...r, direction: 'in', other: r.from });
    }

    // The relationship map: every entity in a relationship, and a cell per
    // relationship - a grid a UI can colour by polarity.
    const mapEntities = new Map();
    for (const r of relationships) for (const e of [r.from, r.to]) if (!mapEntities.has(entityKey(e))) mapEntities.set(entityKey(e), e);
    const relationshipMap = {
        entities: [...mapEntities.values()].sort((a, b) => a.name.localeCompare(b.name)),
        cells: relationships.map((r) => ({ from: r.from, to: r.to, polarity: r.polarity, polarity_label: r.polarity_label, type: r.type, intensity: r.intensity, trend: r.trend })),
    };

    const threads = (compiled.threads ?? []).filter((t) => stands(t, present)).map((t) => withMessageLinks(t, byId))
        .sort((a, b) => THREAD_STATUSES.indexOf(a.status) - THREAD_STATUSES.indexOf(b.status));
    const world = Object.fromEntries(WORLD_KINDS.map((kind) => [kind, []]));
    for (const w of (compiled.world ?? []).filter((item) => stands(item, present))) world[w.kind]?.push(withMessageLinks(w, byId));

    const timeline = records
        .filter((r) => r.subtype === 'event')
        .map((r, order) => ({ r, order, index: messageIndexOf(r) }))
        .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || a.order - b.order)
        .map(({ r, index }) => ({
            memory_id: r.id, text: r.text, entity_ids: [...r.entity_ids],
            witnesses: (r.witness_ids ?? []).map((id) => ({ id, name: nameOf(id) })),
            major: r.importance === 'high' || (r.tags ?? []).includes('important'),
            tags: [...(r.tags ?? [])], tone: r.tone ?? '',
            message_index: index, message_date: messageDateOf(r), source_message_id: r.source_message_id,
            chat_id: r.chat_id, scope: r.scope, importance: r.importance, created_at: r.created_at,
        }));

    return {
        compiledAt: compiled.compiledAt,
        outdated: (compiled.schema ?? 1) < COMPILED_SCHEMA,
        character_profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
        scene_state: tagged.filter((f) => f.classification === 'SCENE'),
        session_details: tagged.filter((f) => f.classification === 'SESSION'),
        relationships,
        relationship_map: relationshipMap,
        threads,
        quests: threads.filter((t) => t.entity?.type === 'quest' || /quest/.test(t.kind)),
        world,
        timeline,
        recent_tone: recentTone(records),
        pending: changesSince(compiled, records).added.length,
    };
}
