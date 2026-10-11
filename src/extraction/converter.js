// Turns what the extraction variable holds - the model's answer, items of
// loosely-followed shape - into fields for addMemoryRecords()
// (src/memory/archivist.js), which builds the final Memory Records.
//
// - text            required; an item without it is dropped
// - subtype, scope,
//   importance      passed on; createMemoryRecord() normalizes or defaults
//                   them ("type" is accepted for "subtype")
// - entities        names (a list, or one comma-separated string), each
//                   looked up as a State Engine object by name or alias;
//                   names that match no object are left out. Archivist
//                   never creates objects for them.
// - message_index   (catch-up) which message the memory came from
//
// `options`:
//   chatId          the chat the memories belong to
//   sourceFor(item) -> source_message_id for an item
//   resolveEntity(name) -> Promise<object id | null>

const isText = (value) => typeof value === 'string' && value.trim() !== '';

function entityNames(item) {
    const raw = item.entities ?? item.entity_names ?? item.entity_ids;
    const list = typeof raw === 'string' ? raw.split(',') : (Array.isArray(raw) ? raw : []);
    return [...new Set(list.filter(isText).map((name) => name.trim()))];
}

export async function convertExtractedItems(items, { sourceFor, resolveEntity }) {
    if (!Array.isArray(items)) return [];
    const converted = [];

    for (const item of items) {
        if (!item || typeof item !== 'object' || !isText(item.text)) continue;

        // Two names can be the same object ("Mira", "mira", an alias).
        const entityIds = new Set();
        for (const name of entityNames(item)) {
            const id = await resolveEntity(name);
            if (id) entityIds.add(id);
        }

        converted.push({
            text: item.text,
            subtype: item.subtype ?? item.type,
            scope: item.scope,
            importance: item.importance,
            entity_ids: [...entityIds],
            source_message_id: sourceFor(item),
        });
    }
    return converted;
}

// A resolveEntity() for one chat: tries each object type in turn and
// remembers answers for the rest of the batch. `lookup(type, name)`
// resolves to an object ({ id }) or null.
export function createEntityResolver(typeIds, lookup) {
    const cache = new Map();
    return async (name) => {
        const key = name.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let id = null;
        for (const type of typeIds) {
            try {
                const found = await lookup(type, name);
                if (found?.id) {
                    id = found.id;
                    break;
                }
            } catch {
                // A failed lookup for one type is just "not that type".
            }
        }
        cache.set(key, id);
        return id;
    };
}
