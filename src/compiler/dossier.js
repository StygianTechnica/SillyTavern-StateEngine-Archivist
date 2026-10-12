// An entity's dossier: everything Archivist knows about one State Engine
// object (a character, a location, a quest...) gathered in one place - so a
// character card, a quest panel or another extension can link from an
// object to its memories and compiled knowledge by the object's id (or its
// name).
//
// Links go by object id where there is one: memories carry entity_ids and
// witness_ids, compiled items carry { id, name, type } entities. A name the
// story uses that matches no object is matched by name instead.
//
//   getEntityDossier(entity, chatId?) -> Promise<dossier | null>
//   getRelationship(from, to, chatId?) -> Promise<{ forward, backward } | null>
//
// `entity`, `from`, `to`: an object id, a name or alias, or { id?, name? }.
// `chatId`: a SillyTavern chat id or registry chat key; omitted, the open chat.

import { LOG_PREFIX } from '../constants.js';
import { getAllMemories } from '../memory/archivist.js';
import { getChatEntry } from '../memory/registry.js';
import { getObject } from '../api/objects.js';
import { getCompiledMemory, resolveChatKey, entityResolver } from './compiler.js';

const lower = (value) => String(value ?? '').trim().toLowerCase();

// Whether compiled entity `e` is `target`: the same object, or - when
// either is only a name - the same name.
export function sameEntity(e, target) {
    if (!e || !target) return false;
    if (e.id && target.id) return e.id === target.id;
    return lower(e.name) !== '' && lower(e.name) === lower(target.name);
}

const involves = (items, target) => (items ?? []).some((e) => sameEntity(e, target));

// The dossier for `target` ({ id | null, name, type | null }) from a chat's
// compiled `view` (getCompiledMemory(), or null when never compiled) and its
// memory `records`:
//   { entity, profile, relationships: [relationship with direction 'out' |
//     'in' and other], threads, quests, world: [entry], secrets_known:
//     [entry], memories: [record], witnessed: [record], timeline: [entry],
//     compiledAt }
export function buildDossier(view, records, target) {
    const byId = (field) => (target.id ? records.filter((r) => (r[field] ?? []).includes(target.id)) : []);
    const profile = view?.character_profiles.find((p) => sameEntity({ id: p.entity_id, name: p.name }, target)) ?? null;
    const relationships = (view?.relationships ?? []).flatMap((r) => [
        ...(sameEntity(r.from, target) ? [{ ...r, direction: 'out', other: r.to }] : []),
        ...(sameEntity(r.to, target) ? [{ ...r, direction: 'in', other: r.from }] : []),
    ]);
    const threads = (view?.threads ?? []).filter((t) => sameEntity(t.entity, target) || involves(t.involved, target));
    const world = Object.values(view?.world ?? {}).flat()
        .filter((w) => sameEntity(w.entity, target) || involves(w.involved, target) || involves(w.known_by, target)
            || (w.kind !== 'secret' && !w.entity && lower(w.name) === lower(target.name)));
    return {
        entity: { ...target },
        compiledAt: view?.compiledAt ?? null,
        profile,
        relationships,
        threads,
        quests: threads.filter((t) => sameEntity(t.entity, target) || t.entity?.type === 'quest' || /quest/.test(t.kind)),
        world,
        secrets_known: world.filter((w) => w.kind === 'secret' && involves(w.known_by, target)),
        memories: byId('entity_ids'),
        witnessed: byId('witness_ids'),
        timeline: (view?.timeline ?? []).filter((t) => (target.id && (t.entity_ids.includes(target.id) || t.witnesses.some((w) => w.id === target.id)))),
    };
}

// `entity` (an id, a name or { id?, name? }) as { id | null, name, type | null }.
async function identify(entity, chatId, resolver) {
    const given = typeof entity === 'string' ? { id: null, name: entity } : { id: entity?.id ?? null, name: entity?.name ?? '' };
    // A string may be an object id.
    const id = given.id ?? (typeof entity === 'string' ? entity : null);
    if (id) {
        try {
            const object = await getObject(chatId, id);
            if (object) return { id, name: object.name ?? given.name, type: object.type ?? object.objectType ?? null };
        } catch {
            // Not an object id: try it as a name.
        }
    }
    return given.name ? resolver.resolve(given.name) : { id: given.id, name: given.name, type: null };
}

export async function getEntityDossier(entity, chatId) {
    const chatKey = resolveChatKey(chatId);
    if (!chatKey) return null;
    try {
        const sillyChatId = getChatEntry(chatKey).chatId;
        const target = await identify(entity, sillyChatId, await entityResolver(sillyChatId));
        if (!target.id && !target.name) return null;
        return buildDossier(await getCompiledMemory(chatKey), await getAllMemories(chatKey), target);
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not build an entity dossier', err);
        return null;
    }
}

// The compiled relationship from `from` to `to` and back:
// { forward: relationship | null, backward: relationship | null }, or null
// when the chat was never compiled.
export async function getRelationship(from, to, chatId) {
    const chatKey = resolveChatKey(chatId);
    if (!chatKey) return null;
    try {
        const sillyChatId = getChatEntry(chatKey).chatId;
        const resolver = await entityResolver(sillyChatId);
        const [a, b] = [await identify(from, sillyChatId, resolver), await identify(to, sillyChatId, resolver)];
        const view = await getCompiledMemory(chatKey);
        if (!view) return null;
        const find = (x, y) => view.relationships.find((r) => sameEntity(r.from, x) && sameEntity(r.to, y)) ?? null;
        return { forward: find(a, b), backward: find(b, a) };
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not look up a relationship', err);
        return null;
    }
}
