// Objects a memory names in its own text. The model lists a memory's
// entities, but often not every one, and not always as the object is
// called ("Liston" for "Town of Liston") - so each memory is also matched
// against the names and aliases of the objects that exist: characters,
// locations, creatures, factions, items, any type. Archivist only links to
// objects the user (or State Engine) made; it never creates one.
//
// Matching is whole words, ignoring case, punctuation, a possessive ("the
// Liston Library's doors") and a leading article; a name or alias two
// objects share links neither. Applied when a memory is stored
// (src/extraction/) and again to the stored ones (linkObjectMentions() in
// archivist.js) when a chat opens and before a compile, so an object made
// later still gets the memories that named it.

import { listObjectTypeIds, listObjects } from '../api/objects.js';

const ARTICLES = new Set(['the', 'a', 'an']);

// "The Liston Library's" -> "liston library"; words only.
function words(text) {
    return String(text ?? '').toLowerCase().replace(/['’]s\b/g, '').replace(/_/g, ' ')
        .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function phraseOf(name) {
    const list = words(name);
    while (list.length > 1 && ARTICLES.has(list[0])) list.shift();
    return list.join(' ');
}

// A matcher over `objects` ([{ id, type, name, aliases }]): text -> the
// objects it names, [{ id, type }]. Names shorter than three letters, or
// only an article, never match.
export function mentionMatcher(objects) {
    const owners = new Map(); // phrase -> Map(id -> { id, type })
    for (const object of objects ?? []) {
        if (!object?.id) continue;
        for (const name of [object.name, ...(Array.isArray(object.aliases) ? object.aliases : [])]) {
            const phrase = phraseOf(name);
            if (phrase.replace(/ /g, '').length < 3 || ARTICLES.has(phrase)) continue;
            if (!owners.has(phrase)) owners.set(phrase, new Map());
            owners.get(phrase).set(object.id, { id: object.id, type: object.type ?? null });
        }
    }
    // Longest first: a longer name claims its words ("the Old Gate" is
    // not also "the Gate"), even one two objects share and so links neither.
    const phrases = [...owners]
        .map(([phrase, ids]) => [phrase.split(' '), ids.size === 1 ? [...ids.values()][0] : null])
        .sort((a, b) => b[0].length - a[0].length);
    return (text) => {
        const list = words(text);
        const taken = new Array(list.length).fill(false);
        const found = new Map();
        for (const [phrase, object] of phrases) {
            for (let i = 0; i + phrase.length <= list.length; i++) {
                if (phrase.some((w, k) => list[i + k] !== w || taken[i + k])) continue;
                for (let k = 0; k < phrase.length; k++) taken[i + k] = true;
                if (object) found.set(object.id, object);
            }
        }
        return [...found.values()];
    };
}

// `record` with the objects its text names (`mentionsIn`) added to its
// entity_ids and entity_types - itself when it names none it lacks.
export function withMentions(record, mentionsIn) {
    const missing = mentionsIn(record.text).filter((o) => !record.entity_ids?.includes(o.id));
    if (missing.length === 0) return record;
    return {
        ...record,
        entity_ids: [...(record.entity_ids ?? []), ...missing.map((o) => o.id)],
        entity_types: { ...(record.entity_types ?? {}), ...Object.fromEntries(missing.filter((o) => o.type).map((o) => [o.id, o.type])) },
    };
}

// The matcher for a chat: every object of every type it sees. One that
// can't be listed is left out; never throws.
export async function mentionMatcherFor(chatId) {
    const objects = [];
    try {
        for (const type of await listObjectTypeIds()) {
            try {
                for (const object of await listObjects(chatId, type)) objects.push({ ...object, type: object.type ?? type });
            } catch {
                // That type is just not listed.
            }
        }
    } catch {
        // No types: nothing to match.
    }
    return mentionMatcher(objects);
}
