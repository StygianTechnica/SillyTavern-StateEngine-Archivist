import { describe, it, expect } from 'vitest';
// Cyril -> Inji read "colleague" over a dozen memories of them making love.
import { sharedBed } from '../src/compiler/compile-plan.js';

const records = new Map([
    ['a', { text: 'Inji kisses Cyril deeply, exploring his body intimately.' }],
    ['b', { text: 'Inji and Cyril lost themselves in passionate lovemaking.' }],
    ['c', { text: 'Inji identified three potential entry points for the museum infiltration.' }],
]);

describe('a tie its memories show in bed is a lover\'s', () => {
    it('adds lover when two of its memories show it', () => {
        expect(sharedBed({ type: 'colleague', sources: ['a', 'b', 'c'] }, records)).toBe('lover; colleague');
    });
    it('reads the memories of the other direction too', () => {
        expect(sharedBed({ type: 'colleague', sources: ['a', 'c'] }, records, ['b'])).toBe('lover; colleague');
    });
    it('leaves it when one memory, a named bond, an ex, or no records', () => {
        expect(sharedBed({ type: 'colleague', sources: ['a', 'c'] }, records)).toBe('colleague');
        expect(sharedBed({ type: 'lover; teammate', sources: ['a', 'b'] }, records)).toBe('lover; teammate');
        expect(sharedBed({ type: 'attracted_to', sources: ['a', 'b'] }, records)).toBe('attracted_to');
        expect(sharedBed({ type: 'ex-partner', sources: ['a', 'b'] }, records)).toBe('ex-partner');
        expect(sharedBed({ type: 'colleague', sources: ['a', 'b'] }, null)).toBe('colleague');
    });
});
