// Linking the names the compiler's model writes to State Engine objects -
// plain functions, so they can be tested on their own.
//
// A model rarely writes a name exactly as the object has it: "gremlin
// (lead)" for the object "A lead gremlin", "the Old Inn" for "Old Inn". So
// besides State Engine's own name/alias match, a name counts as an object's
// when both come down to the same words: lower case, without punctuation or
// brackets, without a leading article, in any order. Only an unambiguous
// match counts (one object with those words).
//
// Names are linked when compiled (compiler.js entityResolver) and again
// whenever the compiled memory is read (relinkCompiled): an object approved
// after the compile still gets its links.

const ARTICLES = new Set(['a', 'an', 'the']);

// "gremlin (lead)" and "A lead gremlin" -> "gremlin lead"; '' for none.
export function nameKey(name) {
    const words = String(name ?? '').toLowerCase().replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return [...new Set(words.filter((w) => !ARTICLES.has(w)))].sort().join(' ');
}

// A lookup name -> { id, name, type } | null over `objects` ([{ id, name,
// aliases, type }]): by nameKey of a name or alias, only when exactly one
// object has it.
export function objectNameIndex(objects) {
    const byKey = new Map();
    for (const object of objects) {
        if (!object?.id) continue;
        for (const name of [object.name, ...(Array.isArray(object.aliases) ? object.aliases : [])]) {
            const key = nameKey(name);
            if (!key) continue;
            const found = byKey.get(key) ?? new Map();
            found.set(object.id, { id: object.id, name: object.name, type: object.type ?? null });
            byKey.set(key, found);
        }
    }
    return (name) => {
        const found = byKey.get(nameKey(name));
        return found && found.size === 1 ? [...found.values()][0] : null;
    };
}

// `entity` ({ id | null, name, type }) linked to its object when it has no
// id yet and `lookup` knows its name; otherwise as it is.
function relink(entity, lookup) {
    if (!entity || entity.id) return entity;
    const found = lookup(entity.name);
    return found ? { ...entity, id: found.id, type: found.type } : entity;
}

const relinkAll = (list, lookup) => (Array.isArray(list) ? list.map((e) => relink(e, lookup)) : list);

// A copy of compiled state `compiled` with every unlinked entity it names
// linked through `lookup`, where it can be. Nothing else changes.
export function relinkCompiled(compiled, lookup) {
    return {
        ...compiled,
        facts: compiled.facts.map((f) => ({ ...f, entities: relinkAll(f.entities, lookup) })),
        relationships: compiled.relationships.map((r) => ({ ...r, from: relink(r.from, lookup), to: relink(r.to, lookup) })),
        characters: (compiled.characters ?? []).map((c) => ({ ...c, entity: relink(c.entity, lookup) })),
        // A thread is linked by its title only to a quest object.
        threads: (compiled.threads ?? []).map((t) => ({ ...t, entity: t.entity ?? questOrNull(t.title, lookup), involved: relinkAll(t.involved, lookup) })),
        world: (compiled.world ?? []).map((w) => ({
            ...w,
            entity: w.entity ? relink(w.entity, lookup) : (w.kind === 'secret' ? null : linkedOrNull(w.name, lookup)),
            known_by: relinkAll(w.known_by, lookup),
            involved: relinkAll(w.involved, lookup),
        })),
    };
}

function questOrNull(title, lookup) {
    const found = lookup(title);
    return found?.type === 'quest' ? { id: found.id, name: title, type: 'quest' } : null;
}

// Every entity a compiled state names, wherever it appears.
function entitiesOf(compiled) {
    const out = [];
    for (const f of compiled.facts ?? []) out.push(...(f.entities ?? []));
    for (const r of compiled.relationships ?? []) out.push(r.from, r.to);
    for (const c of compiled.characters ?? []) out.push(c.entity);
    for (const t of compiled.threads ?? []) out.push(t.entity, ...(t.involved ?? []));
    for (const w of compiled.world ?? []) out.push(w.entity, ...(w.known_by ?? []), ...(w.involved ?? []));
    return out.filter(Boolean);
}

// ALIAS SUGGESTIONS: a name linked to an object only by the loose word
// match ("gremlin (lead)" -> "A lead gremlin") is a name the story uses for
// it that the object doesn't have. As an alias, State Engine's own exact
// match - extraction, the tracker, every extension - would know it too.
// Archivist never changes objects itself: these are offered to the user
// (the memory browser's Compiled view), who adds them with one click.
//
// `objects`: [{ id, name, aliases, type }] the chat sees. Returns
// [{ object_id, object_name, object_type, alias }], one per object and
// name, leaving out a name another object already has.
export function aliasSuggestions(compiled, objects) {
    const byId = new Map(objects.filter((o) => o?.id).map((o) => [o.id, o]));
    const taken = new Set(objects.flatMap((o) => [o.name, ...(o.aliases ?? [])]).map((n) => String(n ?? '').trim().toLowerCase()));
    const seen = new Set();
    const out = [];
    for (const entity of entitiesOf(compiled)) {
        const object = entity.id ? byId.get(entity.id) : null;
        const alias = String(entity.name ?? '').trim();
        const key = `${entity.id}|${alias.toLowerCase()}`;
        if (!object || !alias || taken.has(alias.toLowerCase()) || seen.has(key)) continue;
        seen.add(key);
        out.push({ object_id: object.id, object_name: object.name, object_type: object.type ?? null, alias });
    }
    return out;
}

// A world entry with no object yet: its name's object, if one has it now.
function linkedOrNull(name, lookup) {
    const found = lookup(name);
    return found ? { id: found.id, name, type: found.type } : null;
}
