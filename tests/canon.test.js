// The library's roles and factions held as fixed (src/compiler/canon.js):
// Dr. Adrigo Tole, of Omicron Innovations, written down as "a consultant
// for White Cerberus" after one reply's slip.

import { canonFacts, canonLine, canonPromptLines, strayFaction, scrubProfile, canonFor } from '../src/compiler/canon.js';
import { buildPromptContext, scrubText } from '../src/context/prompt-context.js';

const tole = { id: 'chr_t', name: 'Doctor Adrigo Tole', aliases: ['Dr. Tole', 'Tole'], role: 'Lead Cybernetics Researcher at Omicron Innovations' };
const vex = { id: 'chr_v', name: 'Vex', aliases: [], role: 'Field agent' };
const cyril = { id: 'chr_c', name: 'Cyril', aliases: [] };
const factions = [
    { id: 'fac_o', name: 'Omicron Innovations', aliases: ['Omicron'], members: ['chr_t'] },
    { id: 'fac_w', name: 'White Cerberus', aliases: [], members: ['chr_v', 'chr_c'] },
];
const canon = canonFacts([tole, vex, cyril], factions);
const toleCanon = canonFor(canon, { id: 'chr_t' });

describe('canonFacts', () => {
    it('holds each character\'s role and factions', () => {
        expect(toleCanon.factions).toEqual(['Omicron Innovations']);
        expect(canonLine(toleCanon)).toBe('- Doctor Adrigo Tole: Lead Cybernetics Researcher at Omicron Innovations; of Omicron Innovations');
        expect(canonFor(canon, { name: 'Dr. Tole' })?.id).toBe('chr_t');
    });

    it('gives the compiler the canon of the people the batch speaks of, and nothing when none', () => {
        const lines = canonPromptLines(canon, { ids: ['chr_t'] });
        expect(lines[0]).toMatch(/^Fixed facts from the world library/);
        expect(lines.slice(1)).toEqual([canonLine(toleCanon)]);
        expect(canonPromptLines(canon, { names: ['nobody'] })).toEqual([]);
    });
});

describe('strayFaction', () => {
    it('catches a tie to a faction they are not of', () => {
        expect(strayFaction('Tole, a consultant for White Cerberus, wants a deal.', toleCanon)).toBe('White Cerberus');
        expect(strayFaction('maximizing profit for White Cerberus', toleCanon)).toBe('White Cerberus');
        expect(strayFaction('a White Cerberus agent with cold eyes', toleCanon)).toBe('White Cerberus');
        expect(strayFaction('he works for White Cerberus now', toleCanon)).toBe('White Cerberus');
    });

    it('leaves their own side, opposition and plain mentions alone', () => {
        expect(strayFaction('a researcher for Omicron Innovations', toleCanon)).toBe('');
        expect(strayFaction('he is not an agent of White Cerberus', toleCanon)).toBe('');
        expect(strayFaction('wants to take Cyril away from White Cerberus', toleCanon)).toBe('');
        expect(strayFaction('He met White Cerberus at their safehouse.', toleCanon)).toBe('');
    });
});

describe('the prompt blocks', () => {
    const view = {
        story_summary: 'Cyril met Dr. Tole at the safehouse. Dr. Tole, a consultant for White Cerberus, offered a deal.',
        character_profiles: [{ entity_id: 'chr_t', name: 'Doctor Adrigo Tole', summary: 'Tole is a consultant for White Cerberus. He is cold and precise.', traits: ['cold'], motivations: ['maximizing profit for White Cerberus', 'pushing cybernetics'] }],
        relationships: [{ from: { id: 'chr_c', name: 'Cyril' }, to: { id: 'chr_t', name: 'Doctor Adrigo Tole' }, type: 'consultant/client', polarity: 1, polarity_label: 'friendly', intensity: 'low', trend: '', text: 'Tole serves as an advisor to White Cerberus.' }],
        threads: [], timeline: [], world: {},
    };
    const out = buildPromptContext(view, { present: [tole, cyril], canon });

    it('leads with who they are and drops what ties them elsewhere', () => {
        expect(out.ctx_scene_characters).toContain('who: Lead Cybernetics Researcher at Omicron Innovations; of Omicron Innovations');
        expect(out.ctx_scene_characters).toContain('He is cold and precise.');
        expect(out.ctx_scene_characters).toContain('pushing cybernetics');
        expect(out.ctx_scene_characters).not.toMatch(/White Cerberus/);
    });

    it('keeps the relationship\'s feeling but not its stray words', () => {
        expect(out.ctx_scene_relationships).toContain('- Cyril -> Doctor Adrigo Tole: friendly (+1).');
        expect(out.ctx_scene_relationships).not.toMatch(/White Cerberus/);
    });

    it('drops the stray sentence from the story so far', () => {
        expect(out.ctx_story_summary).toContain('Cyril met Dr. Tole at the safehouse.');
        expect(out.ctx_story_summary).not.toMatch(/consultant/);
        expect(scrubText('Vex, an agent of White Cerberus, waits.', canon)).toBe('Vex, an agent of White Cerberus, waits.');
    });

    it('changes nothing without canon', () => {
        expect(scrubProfile({ summary: 'x' }, null)).toEqual({ summary: 'x' });
        expect(buildPromptContext(view, { present: [tole, cyril] }).ctx_scene_characters).toMatch(/White Cerberus/);
    });
});
