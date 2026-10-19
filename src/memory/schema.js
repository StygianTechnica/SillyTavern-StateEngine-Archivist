// The Memory Record schema (spec section 2) - fixed for the MVP:
//
//   id                 string     unique memory id ("mem_...")
//   subtype            string     event | fact | relationship | secret | ...
//   scope              string     scene | session | long_term
//   text               string     the extracted memory text
//   entity_ids         string[]   State Engine object ids involved
//   source_message_id  string     the chat message that produced it
//   chat_id            string     the chat it belongs to
//   created_at         string     ISO timestamp
//   importance         string     low | medium | high
//
// Optional - added 2026-10-12, so older records don't have them (read them
// with `?? []` / `?? {}` / `?? ''`); createMemoryRecord() always writes them:
//
//   witness_ids        string[]   State Engine object ids of the characters
//                                 present - who saw it happen or heard it
//   tags               string[]   any of important | trivial | contextual |
//                                 emotional (MEMORY_TAGS) - for prioritizing
//   tone               string     its emotional tone, a word or two ('' if none)
//   entity_types       object     { object id: object type } for every id in
//                                 entity_ids and witness_ids ('character',
//                                 'location'...) - which kind of object each is
//
// Optional - added 2026-10-19, written only when true:
//
//   private            boolean    one person's inner experience (a dream,
//                                 vision, thought, unspoken feeling,
//                                 something seen alone): witness_ids is
//                                 only that person, whoever else was there
//
// When the chat message was written is not stored again: it is the
// send_date inside source_message_id (messageDateOf() in
// src/memory/message-sync-plan.js).
//
// createMemoryRecord() is the only way Archivist builds a record, so every
// record it writes passes isMemoryRecord(). Records read back from a file
// are checked with isMemoryRecord() before they are indexed or returned.

export const SCOPES = Object.freeze(['scene', 'session', 'long_term']);
export const IMPORTANCE_LEVELS = Object.freeze(['low', 'medium', 'high']);

// Subtypes the extraction prompt offers. Subtype is an open string (the
// spec's "etc."), so this list is a suggestion, not a whitelist.
// plan: a course of action the characters lay out or agree on - kept whole,
// its steps in order, so the compiler can follow it as a quest.
export const KNOWN_SUBTYPES = Object.freeze(['event', 'fact', 'relationship', 'secret', 'plan', 'promise']);

// Prioritization tags. Only these are kept - a closed list, so they can be
// filtered on.
export const MEMORY_TAGS = Object.freeze(['important', 'trivial', 'contextual', 'emotional']);

// Fallbacks for a missing or unrecognized value.
export const DEFAULT_SUBTYPE = 'fact';
export const DEFAULT_SCOPE = 'session';
export const DEFAULT_IMPORTANCE = 'medium';

const ID_PREFIX = 'mem_';

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

export function generateMemoryId() {
    const random = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID().replace(/-/g, '')
        : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    return `${ID_PREFIX}${random.slice(0, 20)}`;
}

// "Long Term" / "long-term" -> "long_term"; anything else -> ''.
function toToken(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

export function normalizeSubtype(value) {
    return toToken(value) || DEFAULT_SUBTYPE;
}

export function normalizeScope(value) {
    const token = toToken(value);
    return SCOPES.includes(token) ? token : DEFAULT_SCOPE;
}

export function normalizeImportance(value) {
    const token = toToken(value);
    return IMPORTANCE_LEVELS.includes(token) ? token : DEFAULT_IMPORTANCE;
}

// Unique, non-empty string ids, in first-seen order.
export function normalizeEntityIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(isNonEmptyString).map((id) => id.trim()))];
}

// The known tags in `value` (a list or a comma-separated string), in
// MEMORY_TAGS order.
export function normalizeTags(value) {
    const list = typeof value === 'string' ? value.split(',') : (Array.isArray(value) ? value : []);
    const tokens = new Set(list.map(toToken));
    return MEMORY_TAGS.filter((tag) => tokens.has(tag));
}

// A short tone: trimmed, lower case, at most 40 characters ('' if none).
export function normalizeTone(value) {
    return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 40) : '';
}

// { id: type } with non-empty string keys and values only.
export function normalizeEntityTypes(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    for (const [id, type] of Object.entries(value)) {
        if (isNonEmptyString(id) && isNonEmptyString(type)) out[id.trim()] = type.trim();
    }
    return out;
}

// Builds a schema-valid record from loose fields, or returns null when a
// field with no sensible fallback is missing (text, chat_id,
// source_message_id). id and created_at are generated when not given.
export function createMemoryRecord(fields) {
    if (!fields || typeof fields !== 'object') return null;
    const { text, chat_id: chatId, source_message_id: sourceMessageId } = fields;
    if (!isNonEmptyString(text) || !isNonEmptyString(chatId) || !isNonEmptyString(sourceMessageId)) return null;

    return {
        id: isNonEmptyString(fields.id) ? fields.id : generateMemoryId(),
        subtype: normalizeSubtype(fields.subtype),
        scope: normalizeScope(fields.scope),
        text: text.trim(),
        entity_ids: normalizeEntityIds(fields.entity_ids),
        source_message_id: sourceMessageId,
        chat_id: chatId,
        created_at: isNonEmptyString(fields.created_at) ? fields.created_at : new Date().toISOString(),
        importance: normalizeImportance(fields.importance),
        witness_ids: normalizeEntityIds(fields.witness_ids),
        tags: normalizeTags(fields.tags),
        tone: normalizeTone(fields.tone),
        entity_types: normalizeEntityTypes(fields.entity_types),
        ...(fields.private === true ? { private: true } : {}),
    };
}

// True when `record` has every schema field with a valid value.
export function isMemoryRecord(record) {
    return !!record
        && typeof record === 'object'
        && !Array.isArray(record)
        && isNonEmptyString(record.id)
        && isNonEmptyString(record.subtype)
        && SCOPES.includes(record.scope)
        && isNonEmptyString(record.text)
        && Array.isArray(record.entity_ids)
        && record.entity_ids.every((id) => typeof id === 'string')
        && isNonEmptyString(record.source_message_id)
        && isNonEmptyString(record.chat_id)
        && isNonEmptyString(record.created_at)
        && IMPORTANCE_LEVELS.includes(record.importance)
        // The optional fields, when there.
        && (record.witness_ids === undefined || (Array.isArray(record.witness_ids) && record.witness_ids.every((id) => typeof id === 'string')))
        && (record.tags === undefined || (Array.isArray(record.tags) && record.tags.every((tag) => typeof tag === 'string')))
        && (record.tone === undefined || typeof record.tone === 'string')
        && (record.entity_types === undefined || (!!record.entity_types && typeof record.entity_types === 'object' && !Array.isArray(record.entity_types)))
        && (record.private === undefined || typeof record.private === 'boolean');
}
