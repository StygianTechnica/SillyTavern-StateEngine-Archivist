import { describe, it, expect } from 'vitest';
// Inji -> Cyril rested on ~55 memories; one sarcastic remark made it
// "sarcastic tension", wary (-1).
import { steadyTie } from '../src/compiler/compile-plan.js';

const many = Array.from({ length: 55 }, (_, i) => `m${i}`);
const close = { type: 'lover; partner', polarity: 2, intensity: 'high', trend: 'stable', text: 'Inji is close to Cyril and sleeps with him.', sources: many };
const remark = { type: 'sarcastic tension', polarity: -1, intensity: 'medium', trend: 'stable', text: "Inji's sarcastic remark to Cyril was dripping with tension.", sources: [...many, 'new'] };

describe('an established tie does not turn on one moment', () => {
    it('keeps its type and text, one step cooler', () => {
        const kept = steadyTie(close, remark, 1);
        expect(kept.type).toBe('lover; partner');
        expect(kept.text).toBe(close.text);
        expect(kept.polarity).toBe(1);
        expect(kept.trend).toBe('cooling');
        expect(kept.sources).toEqual(remark.sources);
    });
    it('moves one step at most without flipping', () => {
        expect(steadyTie({ ...close, polarity: 3 }, { ...remark, polarity: 1, type: 'colleague' }, 1)).toMatchObject({ polarity: 2, type: 'colleague' });
    });
    it('lets a new tie, a big batch, a small change or an ending through', () => {
        expect(steadyTie({ ...close, sources: ['a', 'b'] }, remark, 1)).toBe(remark);
        expect(steadyTie(close, remark, 5)).toBe(remark);
        const small = { ...remark, polarity: 1 };
        expect(steadyTie(close, small, 1)).toBe(small);
        const ended = { ...remark, text: 'They broke up after the job.' };
        expect(steadyTie(close, ended, 1)).toBe(ended);
        expect(steadyTie(null, remark, 1)).toBe(remark);
    });
});
