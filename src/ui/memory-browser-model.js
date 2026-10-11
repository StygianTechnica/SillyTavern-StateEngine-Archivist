// What the memory browser shows, as plain functions - kept apart from its
// DOM wiring (src/ui/memory-browser.js) so it can be tested on its own.

// The chat list: registry entries grouped by owner (a character or a
// group), owners by name, each owner's chats newest first.
// `entries`: [{ chatKey, entry }]; `existence`: Map chatKey -> true |
// false | null (src/memory/chat-existence.js); `openKey`: the open chat's key.
// -> [{ owner, label, chats: [{ chatKey, entry, missing, open }] }]
export function groupChats(entries, existence = new Map(), openKey = null) {
    const owners = new Map();
    for (const { chatKey, entry } of entries) {
        const owner = entry.groupId ? `group:${entry.groupId}` : `char:${entry.characterAvatar}`;
        if (!owners.has(owner)) {
            const fallback = entry.groupId ? 'Group chat' : String(entry.characterAvatar ?? '').replace(/\.png$/i, '');
            owners.set(owner, { owner, label: entry.displayName || fallback || 'Unknown', chats: [] });
        }
        owners.get(owner).chats.push({ chatKey, entry, missing: existence.get(chatKey) === false, open: chatKey === openKey });
    }
    for (const group of owners.values()) {
        group.chats.sort((a, b) => String(b.entry.updatedAt ?? '').localeCompare(String(a.entry.updatedAt ?? '')));
    }
    return [...owners.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// The filter dropdowns' choices for a chat's records: subtypes and entity
// ids, each sorted.
export function filterChoices(records) {
    const subtypes = new Set();
    const entities = new Set();
    for (const record of records) {
        subtypes.add(record.subtype);
        for (const id of record.entity_ids) entities.add(id);
    }
    return { subtypes: [...subtypes].sort(), entities: [...entities].sort() };
}

// The records passing every filter that is set ('' = any). `search`
// matches the text, case-insensitively; `names` (entity id -> name) lets it
// match the names of the entities a memory is about, too. Newest first.
export function filterRecords(records, { search = '', subtype = '', scope = '', importance = '', entity = '' } = {}, names = new Map()) {
    const query = search.trim().toLowerCase();
    return records.filter((record) => (!subtype || record.subtype === subtype)
        && (!scope || record.scope === scope)
        && (!importance || record.importance === importance)
        && (!entity || record.entity_ids.includes(entity))
        && (!query || record.text.toLowerCase().includes(query)
            || record.entity_ids.some((id) => (names.get(id) ?? id).toLowerCase().includes(query))))
        .reverse();
}

// An ISO timestamp as a short local date and time ('' for none).
export function shortDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// The message a memory came from, for people: "message #12", or the raw
// id when it is not one Archivist built (src/extraction/messages.js).
export function sourceLabel(sourceMessageId) {
    const match = /#(\d+)@/.exec(String(sourceMessageId ?? ''));
    return match ? `message #${match[1]}` : String(sourceMessageId ?? '');
}
