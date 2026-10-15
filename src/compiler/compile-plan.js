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
//   character     { entity, summary, traits, habits, stressors,
//                   motivations: [text], arc, emotional_state, sources } -
//                   inferred insights; `summary` is who they are NOW, what
//                   their actions so far show of them
//   (any item)    edited_at - set when the user edited it (memory browser)
//   thread        { id: "t<n>", kind, title, text, status, progress,
//                   entity (an object of its title - a quest - or null),
//                   involved: [entity], goal, steps: [step], sources } -
//                   plot hooks, open threads, quest seeds; a plan has a
//                   `goal` and its `steps` in order (else '' and [])
//   step          { text, status (STEP_STATUSES), involved: [entity], note }
//   world entry   { id: "w<n>", kind (WORLD_KINDS), name, text,
//                   entity (the object it names, or null), known_by:
//                   [entity] (secrets), involved: [entity], status, sources }
//   summary       { story, scene, sceneAt } - the story so far, the current
//                 scene (the memory part's two summaries; '' until
//                 compiled), and the newest message the scene summary was
//                 written from (null when unknown)
//   tension       [reading] - the story's tension, one reading per compile
//                 batch, oldest first (a rebuild starts the series over)
//   reading       { at: the newest message index of its batch (or null),
//                   memory_id: that batch's newest memory, threat,
//                   uncertainty, emotional (0..TENSION_MAX), overall (their
//                   average), reason }
//   dismissed     [{ kind, key, label }] - items the user deleted
//                 (dismissKey()); a later answer that brings one back is
//                 left out, so a rebuild does not restore them either
//   schema        COMPILED_SCHEMA when compiled; an older state (1: facts
//                 and relationships only) is still read, and flagged
//                 `outdated` in the view until rebuilt
//
// A compile run is two parts, each through its own preset (compiler.js):
// the MEMORY part (facts, relationships, characters) and the WORLD part
// (threads, world). Each hands the model its current lists plus a batch of
// new memories (each as [m<n>]) and gets back the complete, updated lists;
// the parse* functions turn that answer into the next state, keeping each
// continued item's earlier sources. An item the answer leaves out is KEPT
// (carriedForward()): models drop items from a long list without meaning
// to - a relationship, a secret, a quest seed - so only facts are ever
// dropped by the model ("no longer true"), and not more than half of them
// at once (ELIDED_FACTS_MIN). The user removes the rest. buildCompiledView() turns a state into
// what the API returns, colour-tagged, every item linked back to the chat
// messages it rests on (through its source memories, whose message indexes
// message-sync keeps current).

import {
    normalizeClassification, SCOPE_CLASSIFICATION, withColorTag, normalizePolarity, polarityLabel, normalizeIntensity, normalizeTrend,
    normalizeThreadStatus, normalizeStepStatus, stepsFromText, normalizeWorldKind, normalizeSecretStatus, WORLD_KINDS, THREAD_STATUSES,
    TENSION_AXES, normalizeTensionLevel, tensionOverall,
} from './compiled-schema.js';
import { parseSource, messageDateOf } from '../memory/message-sync-plan.js';

export const COMPILED_SCHEMA = 2;

export const EMPTY_COMPILED = Object.freeze({
    facts: [], relationships: [], characters: [], threads: [], world: [], tension: [], summary: Object.freeze({ story: '', scene: '', sceneAt: null }),
    dismissed: [], included: [], compiledAt: null, schema: COMPILED_SCHEMA,
});

// The next summary from the model's answers (strings): each one given
// replaces the previous, a missing or empty one keeps it. `sceneAt`: the
// newest message of the batch - when the scene summary is a new one.
export function parseSummary(story, scene, previous, sceneAt = null) {
    const clean = (value) => (typeof value === 'string' ? value.trim() : '');
    const newScene = clean(scene);
    return {
        story: clean(story) || previous?.story || '',
        scene: newScene || previous?.scene || '',
        sceneAt: newScene ? (sceneAt ?? previous?.sceneAt ?? null) : (previous?.sceneAt ?? null),
    };
}

// The tension series with the model's reading for a batch added: `raw` is
// its answer (a list with one { threat, uncertainty, emotional, reason }),
// `batch` the memories it read. A reading at the same message as the
// last one replaces it; an answer without all three levels adds nothing.
export function parseTension(raw, previousTension, batch) {
    const series = Array.isArray(previousTension) ? previousTension : [];
    const answer = (Array.isArray(raw) ? raw : [raw]).find((item) => item && typeof item === 'object');
    if (!answer) return series;
    const levels = Object.fromEntries(TENSION_AXES.map((axis) => [axis, normalizeTensionLevel(answer[axis])]));
    if (Object.values(levels).some((level) => level === null)) return series;
    const at = newestMessageIndex(batch);
    const newest = [...(batch ?? [])].sort((a, b) => (messageIndexOf(a) ?? -1) - (messageIndexOf(b) ?? -1)).at(-1);
    const reading = { at, memory_id: newest?.id ?? null, ...levels, overall: tensionOverall(levels), reason: text(answer.reason) };
    const last = series.at(-1);
    return last && at !== null && last.at === at ? [...series.slice(0, -1), reading] : [...series, reading];
}

// The newest message index among `records` (null when none has one).
export function newestMessageIndex(records) {
    const indexes = (records ?? []).map((r) => messageIndexOf(r)).filter((i) => i !== null);
    return indexes.length ? Math.max(...indexes) : null;
}

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
// Words only: "the Old Inn", "old inn." -> "inn old".
const looseKey = (value) => String(value ?? '').toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !['a', 'an', 'the'].includes(w)).sort().join(' ');

// ---- dismissed items

// What identifies an item the user deleted, so the model can't bring it
// back: its words, not its id - a rebuild gives new ids. '' for none.
export function dismissKey(kind, item) {
    if (!item) return '';
    const nameOf = (value) => (typeof value === 'string' ? value : nameOfEntity(value));
    switch (kind) {
        case 'fact': return looseKey(item.text);
        case 'relationship': return `${looseKey(nameOf(item.from))}|${looseKey(nameOf(item.to))}`;
        case 'character': return looseKey(item.entity ? nameOfEntity(item.entity) : item.name);
        case 'thread': return looseKey(item.title || item.text);
        case 'world': return `${normalizeWorldKind(item.kind)}:${looseKey(item.name || item.text)}`;
        default: return '';
    }
}

// (kind, item) -> whether the user deleted an item like it.
export function dismissedTest(dismissed) {
    const keys = new Set((dismissed ?? []).map((d) => `${d.kind}#${d.key}`));
    return (kind, item) => keys.size > 0 && keys.has(`${kind}#${dismissKey(kind, item)}`);
}

// `next` plus every item of `previousItems` it left out (by `keyOf`), in
// their earlier order after the answer's own.
export function carriedForward(next, previousItems, keyOf) {
    const seen = new Set(next.map(keyOf));
    return [...next, ...(previousItems ?? []).filter((item) => !seen.has(keyOf(item)))];
}

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
    if (c.summary) parts.push(`now: ${c.summary}`);
    for (const field of ['traits', 'habits', 'stressors', 'motivations']) if (c[field]?.length) parts.push(`${field}: ${c[field].join(', ')}`);
    if (c.arc) parts.push(`arc: ${c.arc}`);
    if (c.emotional_state) parts.push(`feeling: ${c.emotional_state}`);
    return `- ${c.entity.name}: ${parts.join('; ') || '(nothing yet)'}`;
}

// The latest tension readings, so the next one is judged on the same scale.
export const TENSION_CONTEXT = 5;

function tensionLines(tension) {
    const recent = (tension ?? []).slice(-TENSION_CONTEXT);
    if (!recent.length) return ['Story tension so far: (none yet)'];
    return ['Story tension so far (latest readings, oldest first):', ...recent.map((t) => (
        `- ${t.at === null ? 'at an earlier point' : `at message #${t.at}`}: threat ${t.threat}, uncertainty ${t.uncertainty}, emotional ${t.emotional} (overall ${t.overall})${t.reason ? ` - ${t.reason}` : ''}`
    ))];
}

// What the MEMORY part's model reads: the current facts, relationships and
// character insights, then the new memories. `nameOf(id)` -> a display
// name for an entity id (or null).
// `extraLines`: more to read before the new memories (the repeated phrases
// of the latest replies, for the phrase tics).
export function compileContext(previous, batch, nameOf = () => null, extraLines = []) {
    const lines = [
        'Current compiled knowledge:',
        `Story so far: ${previous.summary?.story || '(none yet)'}`,
        `Current scene: ${previous.summary?.scene || '(none yet)'}`,
        ...tensionLines(previous.tension),
        'Facts:',
    ];
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
    lines.push(...dismissedLines(previous, ['fact', 'relationship', 'character']));
    lines.push(...extraLines);
    lines.push(...newMemoryLines(batch, nameOf));
    return lines.join('\n');
}

// What the user deleted, so the model does not add it again.
function dismissedLines(previous, kinds) {
    const labels = (previous.dismissed ?? []).filter((d) => kinds.includes(d.kind) && d.label).map((d) => `- ${d.label}`);
    return labels.length ? ['Removed by the user - do not add these again:', ...labels] : [];
}

// What the WORLD part's model reads: the current threads and world entries,
// then the new memories.
export function worldContext(previous, batch, nameOf = () => null) {
    const lines = ['Current compiled knowledge:', 'Story threads:'];
    if (!previous.threads?.length) lines.push('(none yet)');
    for (const t of previous.threads ?? []) {
        const involved = entityList(t.involved);
        lines.push(`[${t.id}] ${t.kind} · ${t.status}${involved ? ` · involves ${involved}` : ''}: ${t.title} - ${t.text}${t.progress ? ` (progress: ${t.progress})` : ''}`);
        if (t.goal) lines.push(`    goal: ${t.goal}`);
        (t.steps ?? []).forEach((s, i) => lines.push(`    ${i + 1}. [${s.status}] ${s.text}${s.note ? ` (${s.note})` : ''}`));
    }
    lines.push('World:');
    if (!previous.world?.length) lines.push('(none yet)');
    for (const w of previous.world ?? []) {
        const knownBy = entityList(w.known_by);
        lines.push(`[${w.id}] ${w.kind} · ${w.name}${knownBy ? ` · known by ${knownBy}` : ''}${w.status ? ` · ${w.status}` : ''}: ${w.text}`);
    }
    lines.push(...dismissedLines(previous, ['thread', 'world']));
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
// A facts answer that keeps fewer than half of at least this many current
// facts is taken as shortened ("f1, f2, ..., f40" - small models elide long
// lists), not as that many facts no longer holding: the ones it left out
// are kept.
export const ELIDED_FACTS_MIN = 6;

export function parseCompileOutput(rawFacts, rawRelationships, { previous, refs, recordsById, resolve }) {
    const previousById = new Map(previous.facts.map((f) => [f.id, f]));
    const nextId = idAssigner('f', previous.facts);
    const dismissed = dismissedTest(previous.dismissed);
    let facts = [];
    for (const raw of Array.isArray(rawFacts) ? rawFacts : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.text) || dismissed('fact', raw)) continue;
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
    const kept = facts.filter((f) => previousById.has(f.id)).length;
    if (previous.facts.length >= ELIDED_FACTS_MIN && kept < previous.facts.length / 2) facts = carriedForward(facts, previous.facts, (f) => f.id);
    const ids = new Set(facts.map((f) => f.id));
    for (const fact of facts) fact.contradicts = fact.contradicts.filter((other) => other !== fact.id && ids.has(other));

    return { facts, relationships: parseRelationships(rawRelationships, { previous, refs, resolve }) };
}

// One relationship per direction of a pair: from -> to.
const relKey = (r) => `${entityKey(r.from)}|${entityKey(r.to)}`;

// A relationship's type as the model gave it, without what it copied from
// the context's relationship lines ("mentor · wary (-1) · high intensity ·
// cooling: a note" -> "mentor").
export function relationshipType(value) {
    const raw = text(value).toLowerCase();
    return raw.split(/\s*[·:(]\s*/)[0].trim() || raw;
}

export function parseRelationships(rawRelationships, { previous, refs, resolve }) {
    const previousRel = new Map((previous.relationships ?? []).map((r) => [relKey(r), r]));
    const dismissed = dismissedTest(previous.dismissed);
    const relationships = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawRelationships) ? rawRelationships : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.from) || !isText(raw.to) || !isText(raw.type)) continue;
        if (dismissed('relationship', raw)) continue;
        const rel = {
            from: resolve(raw.from.trim()),
            to: resolve(raw.to.trim()),
            type: relationshipType(raw.type),
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
    return carriedForward(relationships, previous.relationships, relKey);
}

// A list's phrases, without what a model writes for an empty one ("none
// mentioned", "n/a").
const NOTHING = /^(none|nothing|n\/?a|unknown|not (yet )?(mentioned|known|shown|stated)|none (mentioned|known|shown|yet)|-+)$/i;
const phraseList = (value) => names(value).map((p) => p.replace(/\.$/, '').trim()).filter((p) => p && !NOTHING.test(p));

// Character insights, one per entity.
export function parseCharacters(rawCharacters, { previous, refs, resolve }) {
    const previousByKey = new Map((previous.characters ?? []).map((c) => [entityKey(c.entity), c]));
    const dismissed = dismissedTest(previous.dismissed);
    const characters = [];
    const seen = new Set();
    for (const raw of Array.isArray(rawCharacters) ? rawCharacters : []) {
        if (!raw || typeof raw !== 'object' || !isText(raw.name) || dismissed('character', raw)) continue;
        const entity = resolve(raw.name.trim());
        const key = entityKey(entity);
        if (seen.has(key)) continue;
        seen.add(key);
        characters.push({
            entity,
            // A missing summary keeps the last one.
            summary: text(raw.summary) || previousByKey.get(key)?.summary || '',
            traits: phraseList(raw.traits),
            habits: phraseList(raw.habits),
            stressors: phraseList(raw.stressors),
            motivations: phraseList(raw.motivations),
            arc: text(raw.arc),
            emotional_state: text(raw.emotional_state ?? raw.feeling),
            sources: [...new Set([...(previousByKey.get(key)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])],
        });
    }
    return carriedForward(characters, previous.characters, (c) => entityKey(c.entity));
}

// A title's or name's own words: 3 letters or more, without the small
// words every title has.
const TITLE_STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'about', 'his', 'her', 'their', 'its', 'our', 'your', 'who', 'what', 'how', 'why', 'new', 'old']);
const titleWords = (value) => String(value ?? '').toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !TITLE_STOP_WORDS.has(w));

// Small models number their answer's items t1, t2, t3... afresh, so an id
// can come back on something else entirely - and continuing the current
// item under it would overwrite that one. An answer item whose title (or
// name) shares no word with the current item of its id is taken as new:
// its id is dropped, and the current one is kept (carriedForward()).
function withoutReusedIds(raws, previousItems, titleOf) {
    const previousById = new Map(previousItems.map((item) => [item.id, item]));
    return raws.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const current = previousById.get(String(raw.id ?? '').trim());
        if (!current) return raw;
        const mine = titleWords(titleOf(raw));
        const theirs = new Set(titleWords(titleOf(current)));
        if (mine.length === 0 || theirs.size === 0 || mine.some((w) => theirs.has(w))) return raw;
        const { id, ...rest } = raw;
        return rest;
    });
}

// A thread or world entry the answer gives a NEW id while it is plainly a
// current one (same words in its title or name, and the current one not
// answered under its own id) continues that one. `raws` are the answer's
// items; returns them with ids filled in where so.
function matchByWords(raws, previousItems, wordsOf, prefix) {
    const pattern = new RegExp(`^${prefix}\\d+$`);
    const previousIds = new Set(previousItems.map((item) => item.id));
    const answered = new Set(raws.map((raw) => String(raw?.id ?? '').trim()).filter((id) => previousIds.has(id)));
    const byWords = new Map();
    for (const item of previousItems) {
        const key = wordsOf(item);
        if (key && !answered.has(item.id) && !byWords.has(key)) byWords.set(key, item.id);
    }
    return raws.map((raw) => {
        if (!raw || typeof raw !== 'object') return raw;
        const id = String(raw.id ?? '').trim();
        if (pattern.test(id) && previousIds.has(id)) return raw;
        const match = byWords.get(wordsOf(raw));
        if (!match) return raw;
        byWords.delete(wordsOf(raw));
        return { ...raw, id: match };
    });
}

// Story threads: plot hooks, unresolved threads, quest seeds. `resolve`
// links a thread whose title names an object (a quest) to it.
export function parseThreads(rawThreads, { previous, refs, resolve }) {
    const previousById = new Map((previous.threads ?? []).map((t) => [t.id, t]));
    const nextId = idAssigner('t', previous.threads ?? []);
    const dismissed = dismissedTest(previous.dismissed);
    const threads = [];
    const fresh = withoutReusedIds(Array.isArray(rawThreads) ? rawThreads : [], previous.threads ?? [], (t) => t.title);
    const raws = matchByWords(fresh, previous.threads ?? [], (t) => looseKey(t?.title), 't');
    for (const raw of raws) {
        if (!raw || typeof raw !== 'object' || !(isText(raw.text) || isText(raw.title)) || dismissed('thread', raw)) continue;
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
            goal: text(raw.goal) || (previousById.get(id)?.goal ?? ''),
            // An answer without steps keeps the plan's earlier ones.
            steps: Array.isArray(raw.steps) && raw.steps.length ? parseSteps(raw.steps, resolve) : (previousById.get(id)?.steps ?? []),
            sources: [...new Set([...(previousById.get(id)?.sources ?? []), ...sourceIdsOf(raw.sources, refs)])],
        });
    }
    return carriedForward(threads, previous.threads, (t) => t.id);
}

// A plan's steps, in the answer's order. A step may come as a plain string.
export function parseSteps(rawSteps, resolve = (name) => ({ id: null, name, type: null })) {
    return (Array.isArray(rawSteps) ? rawSteps : [])
        .map((raw) => (typeof raw === 'string' ? { text: raw } : raw))
        .filter((raw) => raw && typeof raw === 'object' && isText(raw.text))
        .map((raw) => ({
            text: text(raw.text),
            status: normalizeStepStatus(raw.status),
            involved: names(raw.involved ?? raw.entities).map(resolve),
            note: text(raw.note),
        }));
}

// World entries: secrets, locations, factions, items, events, lore.
export function parseWorld(rawWorld, { previous, refs, resolve }) {
    const previousById = new Map((previous.world ?? []).map((w) => [w.id, w]));
    const nextId = idAssigner('w', previous.world ?? []);
    const dismissed = dismissedTest(previous.dismissed);
    const world = [];
    const fresh = withoutReusedIds(Array.isArray(rawWorld) ? rawWorld : [], previous.world ?? [], (w) => w.name);
    const raws = matchByWords(fresh, previous.world ?? [], (w) => (w?.name ? `${normalizeWorldKind(w.kind)}:${looseKey(w.name)}` : ''), 'w');
    for (const raw of raws) {
        if (!raw || typeof raw !== 'object' || !(isText(raw.text) || isText(raw.name)) || dismissed('world', raw)) continue;
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
    return carriedForward(world, previous.world, (w) => w.id);
}

// ---- the user's edits (the memory browser)

// Each kind of item: its list in the compiled state, and its key there.
const ITEM_LISTS = Object.freeze({
    fact: ['facts', (f) => f.id],
    relationship: ['relationships', relKey],
    character: ['characters', (c) => entityKey(c.entity)],
    thread: ['threads', (t) => t.id],
    world: ['world', (w) => w.id],
});
export const EDITABLE_KINDS = Object.freeze(Object.keys(ITEM_LISTS));

// The key editCompiledItem() and removeCompiledItem() find `item` by.
export function compiledItemKey(kind, item) {
    return ITEM_LISTS[kind] ? String(ITEM_LISTS[kind][1](item)) : '';
}

// A user's text for a list ("kind, stubborn" or ['kind']) as phrases.
const phrasesFrom = (value) => phraseList(typeof value === 'string' ? value.split(/[,\n]/) : value);
const has = (patch, field) => Object.prototype.hasOwnProperty.call(patch, field);

// `item` with the user's `patch` applied - only the fields a user edits,
// each normalized like the model's answer.
function patched(kind, item, patch) {
    const next = { ...item };
    const set = (field, fn) => {
        if (has(patch, field)) next[field] = fn(patch[field]);
    };
    switch (kind) {
        case 'fact':
            set('text', (v) => text(v) || item.text);
            set('classification', (v) => normalizeClassification(v, item.classification));
            set('theme', (v) => text(v).toLowerCase() || 'general');
            break;
        case 'relationship':
            set('type', (v) => text(v).toLowerCase() || item.type);
            set('polarity', normalizePolarity);
            set('intensity', normalizeIntensity);
            set('trend', normalizeTrend);
            set('text', text);
            break;
        case 'character':
            set('summary', text);
            for (const field of ['traits', 'habits', 'stressors', 'motivations']) set(field, phrasesFrom);
            set('arc', text);
            set('emotional_state', text);
            break;
        case 'thread':
            set('title', (v) => text(v) || item.title);
            set('kind', (v) => text(v).toLowerCase() || item.kind);
            set('status', normalizeThreadStatus);
            set('text', (v) => text(v) || item.text);
            set('progress', text);
            set('goal', text);
            // Steps as the user left them - [{ text, status, note }] or
            // stepsToText() lines - in order; a step keeps the involved of
            // the step that was at its position.
            set('steps', (v) => parseSteps(typeof v === 'string' ? stepsFromText(v) : v).map((step, i) => (step.involved.length ? step : { ...step, involved: item.steps?.[i]?.involved ?? [] })));
            break;
        case 'world':
            set('name', (v) => text(v) || item.name);
            set('kind', normalizeWorldKind);
            set('text', (v) => text(v) || item.text);
            set('known_by', (v) => phrasesFrom(v).map((name) => item.known_by?.find((e) => e.name === name) ?? { id: null, name, type: null }));
            next.status = next.kind === 'secret' ? normalizeSecretStatus(has(patch, 'status') ? patch.status : item.status) : (has(patch, 'status') ? text(patch.status).toLowerCase() : item.status);
            break;
        default:
    }
    return { ...next, edited_at: new Date().toISOString() };
}

// `compiled` with item `key` of `kind` changed by the user's `patch`, or
// null when there is no such item.
export function editCompiledItem(compiled, kind, key, patch = {}) {
    const [listName, keyOf] = ITEM_LISTS[kind] ?? [];
    const items = compiled?.[listName];
    if (!Array.isArray(items)) return null;
    const index = items.findIndex((item) => String(keyOf(item)) === String(key));
    if (index === -1) return null;
    const list = [...items];
    list[index] = patched(kind, items[index], patch ?? {});
    return { ...compiled, [listName]: list };
}

// What the dismissed list (and the model) calls a deleted item.
function dismissLabel(kind, item) {
    switch (kind) {
        case 'fact': return item.text;
        case 'relationship': return `${item.from?.name} -> ${item.to?.name} (${item.type})`;
        case 'character': return `insights about ${item.entity?.name}`;
        case 'thread': return `${item.kind}: ${item.title}`;
        case 'world': return `${item.kind}: ${item.name}`;
        default: return '';
    }
}

// `compiled` without item `key` of `kind` - remembered as dismissed, so no
// later compile brings it back - or null when there is no such item.
export function removeCompiledItem(compiled, kind, key) {
    const [listName, keyOf] = ITEM_LISTS[kind] ?? [];
    const items = compiled?.[listName];
    const item = Array.isArray(items) ? items.find((i) => String(keyOf(i)) === String(key)) : null;
    if (!item) return null;
    const next = { ...compiled, [listName]: items.filter((i) => i !== item) };
    if (kind === 'fact') next.facts = next.facts.map((f) => (f.contradicts?.includes(item.id) ? { ...f, contradicts: f.contradicts.filter((id) => id !== item.id) } : f));
    const dismissKeyOfItem = dismissKey(kind, item);
    if (dismissKeyOfItem) {
        const others = (compiled.dismissed ?? []).filter((d) => !(d.kind === kind && d.key === dismissKeyOfItem));
        next.dismissed = [...others, { kind, key: dismissKeyOfItem, label: dismissLabel(kind, item) }];
    }
    return next;
}

// `compiled` with the user's text for the story ('story') or scene
// ('scene') summary.
export function editCompiledSummary(compiled, which, value) {
    if (which !== 'story' && which !== 'scene') return null;
    return { ...compiled, summary: { ...(compiled.summary ?? {}), [which]: text(value) } };
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

// How far back from the newest memory's message "the current scene" reaches.
export const SCENE_WINDOW = 12;

// The current scene from the memories themselves, not the model's
// classification (which rarely says SCENE): the scene-scope memories of
// the last SCENE_WINDOW messages before the newest memory, in story order -
// [{ memory_id, text, message_index, tone, entity_ids, witness_ids }].
export function recentSceneMemories(records, window = SCENE_WINDOW) {
    const indexed = records.map((r) => ({ r, index: messageIndexOf(r) })).filter((x) => x.index !== null);
    if (indexed.length === 0) return [];
    const newest = Math.max(...indexed.map((x) => x.index));
    return indexed
        .filter((x) => x.r.scope === 'scene' && x.index > newest - window)
        .sort((a, b) => a.index - b.index)
        .map(({ r, index }) => ({
            memory_id: r.id, text: r.text, message_index: index, tone: r.tone ?? '', entity_ids: [...r.entity_ids], witness_ids: [...(r.witness_ids ?? [])],
        }));
}

// The compiled view of `compiled` for the chat's `records` as they are now
// (deleted memories and other swipes' left out). `nameOf(id)` gives names
// for the witnesses on the timeline (null when unknown).
//   { compiledAt, outdated, story_summary, scene_summary (the compiler's
//     own summaries, '' until compiled with them), scene_summary_at (the
//     newest message the scene summary saw, or null), newest_message_index,
//     scene_recent: recentSceneMemories() - the scene from the memories,
//     character_profiles: [{ entity_id, entity_type, name, facts, summary,
//       traits, habits, stressors, motivations, arc, emotional_state,
//       relationships: [relationship with direction 'out' | 'in'],
//       insights_key (compiledItemKey of its insights, null without) }],
//     scene_state: [fact], session_details: [fact],
//     relationships: [relationship + item_key], relationship_map: { entities: [entity],
//       cells: [{ from, to, polarity, polarity_label, type, intensity }] },
//     threads: [thread], quests: [thread] (those with an object or kind
//       quest), world: { secret: [...], location: [...], ... },
//     tension: [{ message_index, threat, uncertainty, emotional, overall,
//       reason }] (oldest first - a graph's points), tension_now (the last
//       one, or null),
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
        .map((r) => withColorTag(withMessageLinks({ ...relationshipView(r), item_key: relKey(r) }, byId), { relationship: true }));
    const characters = (compiled.characters ?? []).filter((c) => stands(c, present));

    // Profiles: one per entity with lasting facts or character insights.
    const profiles = new Map();
    const profileOf = (entity) => {
        const key = entity.id ?? `name:${String(entity.name ?? '').toLowerCase()}`;
        if (!profiles.has(key)) {
            profiles.set(key, {
                entity_id: entity.id ?? null, entity_type: entity.type ?? null, name: entity.name || 'General', facts: [],
                summary: '', traits: [], habits: [], stressors: [], motivations: [], arc: '', emotional_state: '', relationships: [],
                insights_key: null,
            });
        }
        return profiles.get(key);
    };
    for (const fact of tagged.filter((f) => f.classification === 'PERMANENT')) {
        for (const entity of fact.entities.length ? fact.entities : [{ id: null, name: '' }]) profileOf(entity).facts.push(fact);
    }
    for (const c of characters) {
        const { entity, sources, ...insights } = c;
        Object.assign(profileOf(entity), insights, { insights_key: entityKey(entity), source_memory_ids: sources.filter((id) => present.has(id)) });
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

    // A thread compiled before plans has no goal or steps.
    const threads = (compiled.threads ?? []).filter((t) => stands(t, present)).map((t) => withMessageLinks({ goal: '', steps: [], ...t }, byId))
        .sort((a, b) => THREAD_STATUSES.indexOf(a.status) - THREAD_STATUSES.indexOf(b.status));
    const world = Object.fromEntries(WORLD_KINDS.map((kind) => [kind, []]));
    for (const w of (compiled.world ?? []).filter((item) => stands(item, present))) world[w.kind]?.push(withMessageLinks(w, byId));

    // A reading follows its memory's message when messages move (message-sync).
    const tension = (compiled.tension ?? []).map((t) => ({
        message_index: (t.memory_id && byId.has(t.memory_id) ? messageIndexOf(byId.get(t.memory_id)) : null) ?? t.at ?? null,
        threat: t.threat, uncertainty: t.uncertainty, emotional: t.emotional, overall: t.overall, reason: t.reason ?? '',
    }));

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
        story_summary: compiled.summary?.story ?? '',
        scene_summary: compiled.summary?.scene ?? '',
        scene_summary_at: compiled.summary?.sceneAt ?? null,
        newest_message_index: newestMessageIndex(records),
        character_profiles: [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name)),
        scene_state: tagged.filter((f) => f.classification === 'SCENE'),
        scene_recent: recentSceneMemories(records),
        session_details: tagged.filter((f) => f.classification === 'SESSION'),
        relationships,
        relationship_map: relationshipMap,
        threads,
        quests: threads.filter((t) => t.entity?.type === 'quest' || /quest/.test(t.kind)),
        world,
        tension,
        tension_now: tension.at(-1) ?? null,
        timeline,
        recent_tone: recentTone(records),
        pending: changesSince(compiled, records).added.length,
    };
}
