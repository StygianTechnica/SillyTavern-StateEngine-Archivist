import { buildIndexes } from '../src/memory/indexes.js';

const rec = (id, subtype, entity_ids) => ({ id, subtype, entity_ids });

describe('buildIndexes', () => {
    it('indexes by entity and by subtype, keeping stored order', () => {
        const a = rec('a', 'event', ['chr_mira', 'loc_inn']);
        const b = rec('b', 'fact', ['chr_mira']);
        const c = rec('c', 'event', []);
        const { memoryByEntity, memoryBySubtype } = buildIndexes([a, b, c]);

        expect(memoryByEntity.chr_mira).toEqual([a, b]);
        expect(memoryByEntity.loc_inn).toEqual([a]);
        expect(memoryBySubtype.event).toEqual([a, c]);
        expect(memoryBySubtype.fact).toEqual([b]);
        expect(Object.keys(memoryByEntity)).toEqual(['chr_mira', 'loc_inn']);
    });

    it('lists a record once under an entity it names twice', () => {
        const a = rec('a', 'event', ['chr_mira', 'chr_mira']);
        expect(buildIndexes([a]).memoryByEntity.chr_mira).toEqual([a]);
    });

    it('treats prototype-like keys as ordinary keys', () => {
        const a = rec('a', 'constructor', ['__proto__']);
        const { memoryByEntity, memoryBySubtype } = buildIndexes([a]);
        expect(memoryByEntity.__proto__).toEqual([a]);
        expect(memoryBySubtype.constructor).toEqual([a]);
        expect(memoryByEntity.toString).toBeUndefined();
    });

    it('returns empty indexes for no records', () => {
        const { memoryByEntity, memoryBySubtype } = buildIndexes([]);
        expect(Object.keys(memoryByEntity)).toEqual([]);
        expect(Object.keys(memoryBySubtype)).toEqual([]);
    });
});
