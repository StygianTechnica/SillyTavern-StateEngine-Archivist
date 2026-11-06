// Pronouns from the library held as fixed (src/compiler/canon.js).
// Assassins Inc: Inji Miyama, "he" all through his sheet, was compiled as
// "leveraging her underworld connections" and "demonstrated her value".
import { canonFacts, canonFor, canonLine, canonPromptLines, genderOf, fixPronouns, swapPronouns, scrubProfile } from '../src/compiler/canon.js';

const inji = { id: 'chr_i', name: 'Inji Miyama', aliases: ['Inji'], description: 'Inji is lean and athletic. He has close-cropped white hair. His face is sharp. He favors black suits.' };
const vex = { id: 'chr_v', name: 'Vex', aliases: [], description: 'Vex lights her cigarette. She drives. Her eyes are emerald.' };
const cyril = { id: 'chr_c', name: 'Cyril', aliases: [], gender: 'male' };
const brannoc = { id: 'chr_b', name: 'Ser Brannoc', aliases: ['Brannoc'], description: 'A knight. He rides a grey. His shield is notched. He is old.' };
const nobody = { id: 'chr_n', name: 'Riven', aliases: [] };
const canon = canonFacts([inji, vex, cyril, brannoc, nobody], []);
const injiCanon = canonFor(canon, { id: 'chr_i' });

describe('pronouns from the library', () => {
    it('reads them from the sheet', () => {
        expect(genderOf(inji)).toBe('m');
        expect(genderOf(vex)).toBe('f');
        expect(genderOf(cyril)).toBe('m');
        expect(genderOf(nobody)).toBe('');
        expect(canonLine(injiCanon)).toBe('- Inji Miyama: he/him');
        expect(canonPromptLines(canon, { ids: ['chr_i'] })[0]).toMatch(/write each person with the pronouns given/);
    });
    it('puts a profile right', () => {
        const p = fixPronouns({
            summary: 'Inji is a highly capable agent assigned by Miller to lead the museum infiltration alongside Cyril, leveraging her underworld connections for intel and coordination.',
            arc: 'Inji has demonstrated her value as a skilled operative, now entrusted with leading complex missions.',
            traits: ['strategic'],
        }, injiCanon, canon);
        expect(p.summary).toMatch(/leveraging his underworld connections/);
        expect(p.arc).toBe('Inji has demonstrated his value as a skilled operative, now entrusted with leading complex missions.');
    });
    it('leaves a sentence where "her" may be someone else', () => {
        const p = fixPronouns({ summary: 'Inji trusts Vex and follows her lead. She annoys him. Inji hides her doubts.' }, injiCanon, canon);
        expect(p.summary).toBe('Inji trusts Vex and follows her lead. She annoys him. Inji hides his doubts.');
    });
    it('her as him or his, and the other way round', () => {
        expect(swapPronouns('Doc trusts her. Her blade is notched; the cloak is hers.', 'm')).toBe('Doc trusts him. His blade is notched; the cloak is his.');
        expect(swapPronouns('Lyra saw him draw his sword; the win was his.', 'f')).toBe('Lyra saw her draw her sword; the win was hers.');
        const knight = scrubProfile({ summary: 'Ser Brannoc rode out; she would not yield.' }, canonFor(canon, { id: 'chr_b' }), canon);
        expect(knight.summary).toBe('Ser Brannoc rode out; he would not yield.');
    });
});

// Galice's profile: "He asks about the endgame after manipulating Bartin
// and Tiago against each other" - the sentence names other men, but it
// opens on her.
describe('a profile sentence that opens on a pronoun', () => {
    it('is about its person', () => {
        const galice = { id: 'chr_g', name: 'Galice Buckar', aliases: ['Galice'], description: 'Her hair. Her eyes. She types.' };
        const bartin = { id: 'chr_b', name: 'Bartin Medina', aliases: ['Bartin'], gender: 'male' };
        const all = canonFacts([galice, bartin], []);
        const p = fixPronouns({ summary: 'Galice is a close ally of Cyril. He asks about the endgame after manipulating Bartin against his brother.' }, canonFor(all, { id: 'chr_g' }), all);
        expect(p.summary).toBe('Galice is a close ally of Cyril. She asks about the endgame after manipulating Bartin against his brother.');
    });
});
