import { convertExtractedItems, createEntityResolver } from '../src/extraction/converter.js';
import { sourceMessageId, lastReplyIndex, isStoryReply } from '../src/extraction/messages.js';
import { memoryVariableDef } from '../src/extraction/memory-variable.js';

const known = { mira: 'chr_mira', 'the old inn': 'loc_inn' };
const resolveEntity = async (name) => known[name.toLowerCase()] ?? null;
const options = { sourceFor: () => 'Chat A#3@d', resolveEntity };

describe('convertExtractedItems', () => {
    it('maps an item to memory record fields, resolving entity names to ids', async () => {
        const [fields] = await convertExtractedItems([
            { text: 'Mira hid the key at the inn.', subtype: 'secret', scope: 'long_term', importance: 'high', entities: ['Mira', 'The Old Inn'] },
        ], options);
        expect(fields).toEqual({
            text: 'Mira hid the key at the inn.', subtype: 'secret', scope: 'long_term', importance: 'high',
            entity_ids: ['chr_mira', 'loc_inn'], witness_ids: [], tags: undefined, tone: undefined, entity_types: {},
            source_message_id: 'Chat A#3@d',
        });
    });

    it('resolves who was present into witness_ids, and records each object type', async () => {
        const typed = { mira: { id: 'chr_mira', type: 'character' }, tom: { id: 'chr_tom', type: 'character' }, 'the old inn': { id: 'loc_inn', type: 'location' } };
        const [fields] = await convertExtractedItems([
            { text: 'Mira hid the key.', entities: ['Mira', 'The Old Inn'], present: 'Mira, Tom, Nobody', tags: ['important', 'emotional'], tone: 'Tense' },
        ], { ...options, resolveEntity: async (name) => typed[name.toLowerCase()] ?? null });
        expect(fields).toMatchObject({
            entity_ids: ['chr_mira', 'loc_inn'],
            witness_ids: ['chr_mira', 'chr_tom'],
            entity_types: { chr_mira: 'character', chr_tom: 'character', loc_inn: 'location' },
            tags: ['important', 'emotional'],
            tone: 'Tense',
        });
    });

    it('leaves out names that match no object, and duplicates', async () => {
        const [fields] = await convertExtractedItems([{ text: 't', entities: ['Mira', 'Stranger', 'mira', ' Mira '] }], options);
        expect(fields.entity_ids).toEqual(['chr_mira']);
    });

    it('accepts entities as a comma-separated string, and "type" for subtype', async () => {
        const [fields] = await convertExtractedItems([{ text: 't', type: 'event', entities: 'Mira, The Old Inn' }], options);
        expect(fields.subtype).toBe('event');
        expect(fields.entity_ids).toEqual(['chr_mira', 'loc_inn']);
    });

    it('drops items without text, and non-items', async () => {
        const out = await convertExtractedItems([{ text: '' }, { subtype: 'event' }, null, 'text', { text: 'kept' }], options);
        expect(out.map((f) => f.text)).toEqual(['kept']);
    });

    it('returns [] for a non-list', async () => {
        expect(await convertExtractedItems(null, options)).toEqual([]);
    });

    it('asks sourceFor about each item', async () => {
        const out = await convertExtractedItems([{ text: 'a', message_index: 2 }, { text: 'b', message_index: 7 }], {
            ...options, sourceFor: (item) => `chat#${item.message_index}`,
        });
        expect(out.map((f) => f.source_message_id)).toEqual(['chat#2', 'chat#7']);
    });
});

describe('createEntityResolver', () => {
    it('tries each type in order and caches answers case-insensitively', async () => {
        const lookup = vi.fn(async (type, name) => (type === 'location' && name.toLowerCase() === 'inn' ? { id: 'loc_inn' } : null));
        const resolve = createEntityResolver(['character', 'location', 'item'], lookup);

        expect(await resolve('Inn')).toEqual({ id: 'loc_inn', type: 'location' });
        expect(lookup.mock.calls.map(([type]) => type)).toEqual(['character', 'location']);
        expect(await resolve('INN')).toEqual({ id: 'loc_inn', type: 'location' });
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('treats a failing lookup as no match and keeps looking', async () => {
        const resolve = createEntityResolver(['character', 'item'], async (type) => {
            if (type === 'character') throw new Error('boom');
            return { id: 'itm_key' };
        });
        expect(await resolve('key')).toEqual({ id: 'itm_key', type: 'item' });
    });

    it('resolves to null when nothing matches', async () => {
        expect(await createEntityResolver(['character'], async () => null)('nobody')).toBeNull();
    });
});

describe('messages', () => {
    const chat = [
        { is_user: true, mes: 'hi', send_date: 'd0' },
        { is_user: false, mes: 'hello', send_date: 'd1' },
        { is_user: false, is_system: true, mes: 'note' },
        { is_user: true, mes: 'and?' },
    ];

    it('finds the newest model-written message', () => {
        expect(lastReplyIndex(chat)).toBe(1);
        expect(lastReplyIndex([{ is_user: true }])).toBe(-1);
        expect(lastReplyIndex(undefined)).toBe(-1);
        expect(isStoryReply(chat[2])).toBe(false);
    });

    it('builds a source id from chat, index and send date', () => {
        expect(sourceMessageId('Chat A', 1, chat[1])).toBe('Chat A#1@d1');
        expect(sourceMessageId('Chat A', 3, chat[3])).toBe('Chat A#3@');
    });
});

describe('memoryVariableDef', () => {
    it('is a prompted record list that requires only text', () => {
        const def = memoryVariableDef('live');
        expect(def).toMatchObject({ type: 'array', itemType: 'record', itemSchema: { text: { type: 'string' } }, defaultValue: [], showInTracker: false, behaviors: { prompted: true, increment: false } });
        expect(def.prompted.instructions).toContain('most recent roleplay message');
        expect(def).not.toHaveProperty('value');
    });

    it('is NEW EACH TURN in both modes, so the model never just repeats the emptied list', () => {
        expect(memoryVariableDef('live').prompted.newEachTurn).toBe(true);
        expect(memoryVariableDef('catch-up').prompted.newEachTurn).toBe(true);
    });

    it('asks for small concrete details as low importance, and [] only when nothing happens', () => {
        for (const mode of ['live', 'catch-up']) {
            const text = memoryVariableDef(mode).prompted.instructions;
            expect(text).toContain('Include small concrete details too, as "low" importance');
            expect(text).toContain('Answer [] only when nothing at all happens');
        }
    });

    it('asks catch-up runs for the source message index', () => {
        expect(memoryVariableDef('catch-up').prompted.instructions).toContain('message_index');
        expect(memoryVariableDef('live').prompted.instructions).not.toContain('message_index');
    });
});
