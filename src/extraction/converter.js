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
// - present         the characters present (witnesses), resolved the same
//                   way into witness_ids ("witnesses" is accepted too)
// - tags, tone      passed on; createMemoryRecord() keeps the known tags
// - entity_types    built here: { id: object type } for every resolved id
// - message_index   (catch-up) which message the memory came from
//
// `options`:
//   chatId          the chat the memories belong to
//   sourceFor(item) -> source_message_id for an item
//   resolveEntity(name) -> Promise<{ id, type } | object id | null>
//   mentionsIn(text) -> [{ id, type }]  objects the text itself names
//                   (src/memory/object-mentions.js), added to the entities

const isText = (value) => typeof value === 'string' && value.trim() !== '';

function nameList(raw) {
    const list = typeof raw === 'string' ? raw.split(',') : (Array.isArray(raw) ? raw : []);
    return [...new Set(list.filter(isText).map((name) => name.trim()))];
}

const entityNames = (item) => nameList(item.entities ?? item.entity_names ?? item.entity_ids);
const witnessNames = (item) => nameList(item.present ?? item.witnesses ?? item.witness_ids);

export async function convertExtractedItems(items, { sourceFor, resolveEntity, mentionsIn = () => [] }) {
    if (!Array.isArray(items)) return [];
    const converted = [];

    for (const item of items) {
        if (!item || typeof item !== 'object' || !isText(item.text)) continue;

        // Two names can be the same object ("Mira", "mira", an alias).
        const types = {};
        const resolveAll = async (names) => {
            const ids = new Set();
            for (const name of names) {
                const found = await resolveEntity(name);
                const id = typeof found === 'string' ? found : found?.id;
                if (!id) continue;
                ids.add(id);
                if (found?.type) types[id] = found.type;
            }
            return [...ids];
        };
        const entityIds = await resolveAll(entityNames(item));
        for (const object of mentionsIn(item.text)) {
            if (entityIds.includes(object.id)) continue;
            entityIds.push(object.id);
            if (object.type) types[object.id] = object.type;
        }
        const witnessIds = await resolveAll(witnessNames(item));

        converted.push({
            text: item.text,
            subtype: item.subtype ?? item.type,
            scope: item.scope,
            importance: item.importance,
            entity_ids: entityIds,
            witness_ids: witnessIds,
            tags: item.tags,
            tone: item.tone,
            entity_types: types,
            source_message_id: sourceFor(item),
        });
    }
    return converted;
}

// A resolveEntity() for one chat: tries each object type in turn and
// remembers answers for the rest of the batch. `lookup(type, name)`
// resolves to an object ({ id }) or null. Resolves to { id, type } - the
// object type it was found as - or null.
export function createEntityResolver(typeIds, lookup) {
    const cache = new Map();
    return async (name) => {
        const key = name.toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let entity = null;
        for (const type of typeIds) {
            try {
                const found = await lookup(type, name);
                if (found?.id) {
                    entity = { id: found.id, type };
                    break;
                }
            } catch {
                // A failed lookup for one type is just "not that type".
            }
        }
        cache.set(key, entity);
        return entity;
    };
}
