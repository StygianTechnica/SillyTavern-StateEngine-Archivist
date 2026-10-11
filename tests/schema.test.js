import {
    createMemoryRecord, isMemoryRecord, generateMemoryId,
    normalizeScope, normalizeImportance, normalizeSubtype, normalizeEntityIds,
} from '../src/memory/schema.js';

const base = { text: 'Mira hid the key.', chat_id: 'Chat A', source_message_id: 'Chat A#4@1' };

describe('createMemoryRecord', () => {
    it('builds a schema-valid record with every field', () => {
        const record = createMemoryRecord({ ...base, subtype: 'secret', scope: 'long_term', importance: 'high', entity_ids: ['chr_mira', 'itm_key'] });
        expect(Object.keys(record).sort()).toEqual(['chat_id', 'created_at', 'entity_ids', 'id', 'importance', 'scope', 'source_message_id', 'subtype', 'text']);
        expect(record).toMatchObject({ subtype: 'secret', scope: 'long_term', importance: 'high', entity_ids: ['chr_mira', 'itm_key'] });
        expect(record.id).toMatch(/^mem_[0-9a-f]{20}$/);
        expect(new Date(record.created_at).toISOString()).toBe(record.created_at);
        expect(isMemoryRecord(record)).toBe(true);
    });

    it('keeps a given id and created_at', () => {
        const record = createMemoryRecord({ ...base, id: 'mem_given', created_at: '2026-01-01T00:00:00.000Z' });
        expect(record.id).toBe('mem_given');
        expect(record.created_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('falls back for missing or unknown enum values', () => {
        const record = createMemoryRecord({ ...base, scope: 'forever', importance: 'critical' });
        expect(record).toMatchObject({ subtype: 'fact', scope: 'session', importance: 'medium', entity_ids: [] });
    });

    it.each(['text', 'chat_id', 'source_message_id'])('rejects a record without %s', (field) => {
        expect(createMemoryRecord({ ...base, [field]: '  ' })).toBeNull();
        expect(createMemoryRecord({ ...base, [field]: undefined })).toBeNull();
    });

    it('rejects non-objects', () => {
        expect(createMemoryRecord(null)).toBeNull();
        expect(createMemoryRecord('text')).toBeNull();
    });

    it('trims the text', () => {
        expect(createMemoryRecord({ ...base, text: '  spaced  ' }).text).toBe('spaced');
    });
});

describe('normalizers', () => {
    it('normalizes scope spellings', () => {
        expect(normalizeScope('Long Term')).toBe('long_term');
        expect(normalizeScope('long-term')).toBe('long_term');
        expect(normalizeScope('SCENE')).toBe('scene');
    });

    it('normalizes importance', () => {
        expect(normalizeImportance(' High ')).toBe('high');
        expect(normalizeImportance(3)).toBe('medium');
    });

    it('keeps open-ended subtypes as lowercase tokens', () => {
        expect(normalizeSubtype('Relationship')).toBe('relationship');
        expect(normalizeSubtype('World Rule')).toBe('world_rule');
        expect(normalizeSubtype('')).toBe('fact');
    });

    it('dedupes entity ids and drops non-strings', () => {
        expect(normalizeEntityIds(['chr_a', ' chr_a ', '', 5, null, 'loc_b'])).toEqual(['chr_a', 'loc_b']);
        expect(normalizeEntityIds('chr_a')).toEqual([]);
    });
});

describe('isMemoryRecord', () => {
    const valid = () => createMemoryRecord(base);

    it.each([
        ['missing id', { id: undefined }],
        ['bad scope', { scope: 'forever' }],
        ['bad importance', { importance: 'urgent' }],
        ['entity_ids not a list', { entity_ids: 'chr_a' }],
        ['non-string entity id', { entity_ids: [1] }],
        ['empty text', { text: '' }],
    ])('rejects a record with %s', (_label, patch) => {
        expect(isMemoryRecord({ ...valid(), ...patch })).toBe(false);
    });

    it('rejects non-records', () => {
        expect(isMemoryRecord(null)).toBe(false);
        expect(isMemoryRecord([])).toBe(false);
    });
});

it('generateMemoryId produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 200 }, generateMemoryId));
    expect(ids.size).toBe(200);
});
