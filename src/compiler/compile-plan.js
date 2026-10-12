// The compiler's plain functions - no State Engine or SillyTavern calls, so
// they can be tested on their own. The runner is src/compiler/compiler.js.
//
// A COMPILED state (stored per chat, compiled-storage in compiler.js):
//   { facts: [fact], relationships: [relationship], included: [memory ids
//     already compiled in], compiledAt }
//   fact          { id: "f<n>", text, classification, theme,
//                   entities: [{ id | null, name }], sources: [memory ids],
//                   contradicts: [fact ids] }
//   relationship  { from: { id | null, name }, to: {...}, type, text,
//                   sources: [memory ids] }
//
// A compile run hands the model the current facts and relationships plus a
// batch of new memories (each as [m<n>]), and gets back the complete,
// updated lists; parseCompileOutput() turns that answer into the next
// state, keeping each continued fact's earlier sources. buildCompiledView()
// turns a state into what the API returns: profiles, scene state, session
// details, relationships and the timeline, colour-tagged - each fact and
// relationship linked back to the chat messages it rests on (through its
// source memories, whose message indexes message-sync keeps current).

import { normalizeClassification, SCOPE_CLASSIFICATION, withColorTag } from './compiled-schema.js';
import { parseSource } from '../memory/message-sync-plan.js';

export const EMPTY_COMPILED = Object.freeze({ facts: [], relationships: [], included: [], compiledAt: null });

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const names = (value) => {
    const list = typeof value === 'string' ? value.split(',') : (Array.isArray(value) ? value : []);
    return [...new Set(list.filter(isText).map((n) => n.trim()))];
};
const words = (token) => String(token ?? '').replace(/_/g, ' ');
const messageIndexOf = (record) => parseSource(record?.source_message_id)?.index ?? null;

// ---- the run's context

// Local refs for a batch of memories: [m1], [m2]... -> Map ref -> memory id.
export function refsFor(records) {
    return new Map(records.map((record, i) => [`m${i + 1}`, record.id]));
}

function entityList(entities) {
    return entities.map((e) => e.name).filter(Boolean).join(', ');
}

// What the model reads: the current compiled knowledge, then the new
// memories. `nameOf(id)` -> a display name for an entity id (or null).
export function compileContext(previous, batch, nameOf = () => null) {
    const lines = ['Current compiled knowledge:', 'Facts:'];
    if (previous.facts.length === 0) lines.push('(none yet)');
    for (const fact of previous.facts) {
        const about = entityList(fact.entities);
        lines.push(`[${fact.id}] ${fact.classification} · ${fact.theme || 'general'}${about ? ` · about ${about}` : ''}: ${fact.text}`);
    }
    lines.push('Relationships:');
    if (previous.relationships.length === 0) lines.push('(none yet)');
    for (const r of previous.relationships) lines.push(`- ${r.from.name} ${r.type} ${r.to.name}: ${r.text}`);
    lines.push('', 'New memories:');
    const refs = [...refsFor(batch).keys()];
    batch.forEach((record, i) => {
        const about = record.entity_ids.map((id) => nameOf(id) ?? id).join(', ');
        const where = messageIndexOf(record);
        lines.push(`[${refs[i]}] (${record.subtype}, ${words(record.scope)}, ${record.importance}${where !== null ? `, message #${where}` : ''})${about ? ` about ${about}` : ''}: ${record.text}`);
    });
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

// The next compiled state from the model's answer, or null when the answer
// can't be trusted (it would drop every fact while there were some).
//   rawFacts, rawRelationships  the two variables' values
//   previous                    the compiled state the run started from
//   refs                        refsFor() of the batch
//   recordsById                 Map id -> memory record (for fallbacks)
//   resolve(name)               -> { id | null, name } for an entity name
export function parseCompileOutput(rawFacts, rawRelationships, { previous, refs, recordsById, resolve }) {
    const previousById = new Map(previous.facts.map((f) => [f.id, f]));
    const toIds = (value) => names(value).map((ref) => refs.get(ref.replace(/^\[|\]$/g, ''))).filter(Boolean);

    let next = Math.max(0, ...previous.facts.map((f) => Number(f.id.slice(1)) || 0)) + 1;
    const seen = new Set();
    const facts = [];
    for (const raw of Array.isArray(rawFacts) ? rawFacts : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.text)) continue;
        let id = String(raw.id ?? '').trim();
        if (!/^f\d+$/.test(id) || seen.has(id)) id = `f${next++}`;
        else if (!previousById.has(id)) next = Math.max(next, Number(id.slice(1)) + 1);
        seen.add(id);
        const sources = [...new Set([...(previousById.get(id)?.sources ?? []), ...toIds(raw.sources)])];
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

    const previousRel = new Map(previous.relationships.map((r) => [relKey(r), r]));
    const relationships = [];
    const relSeen = new Set();
    for (const raw of Array.isArray(rawRelationships) ? rawRelationships : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.from) || !isText(raw.to) || !isText(raw.type)) continue;
        const rel = { from: resolve(raw.from.trim()), to: resolve(raw.to.trim()), type: raw.type.trim().toLowerCase(), text: isText(raw.text) ? raw.text.trim() : '', sources: [] };
        const key = relKey(rel);
        if (relSeen.has(key)) continue;
        relSeen.add(key);
        rel.sources = [...new Set([...(previousRel.get(key)?.sources ?? []), ...toIds(raw.sources)])];
        if (!rel.text) rel.text = `${rel.from.name} ${rel.type} ${rel.to.name}.`;
        relationships.push(rel);
    }
    return { facts, relationships };
}

function relKey(r) {
    return `${(r.from.id ?? r.from.name).toLowerCase()}|${r.type}|${(r.to.id ?? r.to.name).toLowerCase()}`;
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

// A fact or relationship still stands while at least one memory it rests on
// is present (one with no sources stands).
const stands = (item, present) => item.sources.length === 0 || item.sources.some((id) => present.has(id));

// Where in the chat an item comes from, through its present source
// memories: { chat_id, source_memory_ids, source_messages: [{ memory_id,
// message_index, source_message_id }] in story order, message_range:
// { from, to } | null } - so a UI can jump to that part of the chat.
function withMessageLinks(item, byId) {
    const sources = item.sources.map((id) => byId.get(id)).filter(Boolean);
    const messages = sources
        .map((r) => ({ memory_id: r.id, message_index: messageIndexOf(r), source_message_id: r.source_message_id }))
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

// The compiled view of `compiled` for the chat's `records` as they are now
// (deleted memories and other swipes' left out):
//   { compiledAt, character_profiles: [{ entity_id, name, facts }],
//     scene_state: [fact], session_details: [fact], relationships: [rel],
//     timeline: [{ memory_id, text, entity_ids, message_index,
//     source_message_id, chat_id, scope, importance, created_at }],
//     pending: memories not compiled in yet }
// Every fact and relationship carries its colour tag and its message links
// (withMessageLinks() above).
export function buildCompiledView(compiled, records) {
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

    const profiles = new Map();
    for (const fact of tagged.filter((f) => f.classification === 'PERMANENT')) {
        const about = fact.entities.length ? fact.entities : [{ id: null, name: '' }];
        for (const entity of about) {
            const key = entity.id ?? `name:${entity.name.toLowerCase()}`;
            if (!profiles.has(key)) profiles.set(key, { entity_id: entity.id, name: entity.name || 'General', facts: [] });
            profiles.get(key).facts.push(fact);
        }
    }

    const timeline = records
        .filter((r) => r.subtype === 'event')
        .map((r, order) => ({ r, order, index: messageIndexOf(r) }))
        .sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity) || a.order - b.order)
        .map(({ r, index }) => ({
            memory_id: r.id, text: r.text, entity_ids: [...r.entity_ids], message_index: index, source_message_id: r.source_message_id,
            chat_id: r.chat_id, scope: r.scope, importance: r.importance, created_at: r.created_at,
        }));

    return {
        compiledAt: compiled.compiledAt,
        character_profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
        scene_state: tagged.filter((f) => f.classification === 'SCENE'),
        session_details: tagged.filter((f) => f.classification === 'SESSION'),
        relationships: compiled.relationships.filter((r) => stands(r, present)).map((r) => withColorTag(withMessageLinks(r, byId), { relationship: true })),
        timeline,
        pending: changesSince(compiled, records).added.length,
    };
}
