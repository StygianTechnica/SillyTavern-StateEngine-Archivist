// Inji had slept with Cyril days before; one compile of mission planning
// made the tie "teammate", and Zane, who had kissed him, became "support".
import { keptBond } from '../src/compiler/compile-plan.js';

describe('a bond outlasts a batch of work', () => {
    it('stays in front of the new type', () => {
        expect(keptBond({ type: 'lover' }, { type: 'teammate', text: 'Inji works closely with Cyril on the operation.' })).toBe('lover; teammate');
        expect(keptBond({ type: 'lover; teammate' }, { type: 'partner on the job', text: '' })).toBe('lover; partner on the job');
        expect(keptBond({ type: 'rival' }, { type: 'ally', text: 'They work the heist together.' })).toBe('rival; ally');
        expect(keptBond({ type: 'sworn enemy' }, { type: 'reluctant guide', text: 'Brannoc leads Maelis through the pass.' })).toBe('sworn enemy; reluctant guide');
    });
    it('until a bond replaces it or the story ends it', () => {
        expect(keptBond({ type: 'lover' }, { type: 'ex-lover', text: '' })).toBe('ex-lover');
        expect(keptBond({ type: 'lover' }, { type: 'colleague', text: 'They broke up after the heist and keep it professional.' })).toBe('colleague');
        expect(keptBond({ type: 'colleague' }, { type: 'teammate', text: '' })).toBe('teammate');
        expect(keptBond(null, { type: 'teammate' })).toBe('teammate');
    });
});
