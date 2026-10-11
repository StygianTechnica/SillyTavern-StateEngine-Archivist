// The two MVP indexes (spec section 4), built from a chat's records:
//
//   memoryByEntity   { entity_id: [memory_record, ...] }
//   memoryBySubtype  { subtype:   [memory_record, ...] }
//
// Always rebuilt in full - at load, after catch-up, and after new memory
// is added (src/memory/archivist.js). Records keep their stored order
// within each list. The maps have no prototype, so an id like
// "constructor" or "__proto__" is just another key.

export function buildIndexes(records) {
    const memoryByEntity = Object.create(null);
    const memoryBySubtype = Object.create(null);

    for (const record of records) {
        // A record naming the same entity twice is listed under it once.
        for (const entityId of new Set(record.entity_ids)) {
            (memoryByEntity[entityId] ??= []).push(record);
        }
        (memoryBySubtype[record.subtype] ??= []).push(record);
    }

    return { memoryByEntity, memoryBySubtype };
}
