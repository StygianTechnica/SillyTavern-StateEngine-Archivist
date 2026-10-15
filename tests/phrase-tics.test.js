// Phrase tics: finding repeated wording (phrase-tics.js), the compiler
// judging it, following it reply by reply with decay
// (phrase-tic-tracker.js), and the Curator block asking for variety.

import { getContext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef, chatKeyFor } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import {
    phraseKey, usesPhrase, findCandidates, candidateLines, parseTicAnswer, addFound, updateForReply, activeTics,
} from '../src/compiler/phrase-tics.js';
import { getChatPhraseTics, countNewestReply, removePhraseTic } from '../src/compiler/phrase-tic-tracker.js';
import { phraseTicBlock, REFERENCE_MARKER } from '../src/context/prompt-context.js';
import { compileOpenChat } from '../src/compiler/compiler.js';
import { getPhraseTics } from '../src/public-api.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const replies = [
    { index: 1, text: 'Kael leaned back. A wry smile tugged at his lips as the fire cracked.' },
    { index: 3, text: 'Mira laughed, and a wry smile tugged at her lips. *Outside, rain fell.*' },
    { index: 5, text: 'The door opened. His tone turned serious when he spoke of the war.' },
    { index: 7, text: 'Her tone turned serious. "We leave at dawn," she said.' },
];

describe('finding repeated wording', () => {
    it('matches across pronouns and markup', () => {
        expect(phraseKey('A wry smile tugged at HER lips.')).toBe('a wry smile tugged at their lips');
        expect(usesPhrase('...and *a wry smile tugged at his lips*.', 'wry smile tugged at their lips')).toBe(true);
        expect(usesPhrase('a wry smile', 'wry smile tugged at their lips')).toBe(false);
    });

    it('finds phrases repeated in different replies, longest first, without their shorter parts', () => {
        const candidates = findCandidates(replies);
        expect(candidates.map((c) => c.key)).toEqual(['a wry smile tugged at their lips', 'their tone turned serious']);
        expect(candidates[0]).toMatchObject({ ref: 'p1', text: 'A wry smile tugged at his lips', replies: [1, 3] });
        expect(candidates[0].example).toBe('A wry smile tugged at his lips as the fire cracked.');
        // Repeated within one reply only, or only filler words: not a candidate.
        expect(findCandidates([{ index: 1, text: 'and then it was and then it was' }, { index: 2, text: 'nothing alike here at all' }])).toEqual([]);
        expect(candidateLines([])).toEqual(['Repeated phrases in the latest replies:', '(none)']);
    });

    it('keeps one candidate per phrase, allows short tics that recur often, and skips short ones around a name', () => {
        const candidates = findCandidates([
            { index: 1, text: 'Varyn reached out, placing a hand on Remus\'s shoulder. Rain fell on the ruined tower. He raised an eyebrow. They went back to Remus.' },
            { index: 2, text: 'The wind howled across the plain. Mira reached out, placing a hand on Remus\'s shoulder. She raised an eyebrow, amused. Kael went back to Remus.' },
            { index: 3, text: 'Dawn broke slowly. He raised an eyebrow at the map. Varyn walked back to Remus quietly.' },
        ]);
        const keys = candidates.map((c) => c.key);
        // The long phrase once - not its shifted slices.
        expect(keys.filter((k) => k.includes('hand on remus'))).toHaveLength(1);
        expect(keys).toContain('they raised an eyebrow');
        expect(keys.some((k) => k === 'back to remus')).toBe(false);
        // Three words need three replies.
        expect(findCandidates([{ index: 1, text: 'Mira raised an eyebrow.' }, { index: 2, text: 'Kael raised an eyebrow.' }])).toEqual([]);
    });

    it('never runs a phrase across punctuation, into dialogue, or onto a dangling word', () => {
        const keys = findCandidates([
            { index: 1, text: 'Varyn said, his voice low. "For now, let\'s focus on the road," he added. It spoke volumes about the depth of their bond.' },
            { index: 2, text: 'Mira said, her voice low. "For now, let\'s focus on the road," she said. It spoke volumes about the depth of their trust.' },
        ]).map((c) => c.key);
        expect(keys).toEqual(['it spoke volumes about the depth']);
        expect(keys.some((k) => k.includes('said their voice'))).toBe(false);
        expect(keys.some((k) => k.includes('focus on the road'))).toBe(false);
        expect(keys.some((k) => k.endsWith(' their') || k.endsWith(' of'))).toBe(false);
        expect(usesPhrase('"A wry smile tugged at his lips," she joked.', 'a wry smile tugged at their lips')).toBe(false);
    });

    it('takes the model\'s answer in a loose shape - no ref, or plain strings', () => {
        const candidates = findCandidates(replies);
        expect(parseTicAnswer(['his tone turned serious', { phrase: 'a wry smile tugged at her lips' }, 'invented phrase'], candidates).map((t) => t.key))
            .toEqual(['their tone turned serious', 'a wry smile tugged at their lips']);
    });

    it('takes the model\'s judgement only for candidates it was given', () => {
        const candidates = findCandidates(replies);
        expect(parseTicAnswer([
            { ref: '[p1]', phrase: 'a wry smile tugged at his lips.' },
            { ref: 'p2', phrase: 'something else entirely' },
            { ref: 'p9', phrase: 'invented' },
        ], candidates)).toEqual([
            { key: 'a wry smile tugged at their lips', phrase: 'a wry smile tugged at his lips' },
            { key: 'their tone turned serious', phrase: 'His tone turned serious' },
        ]);
    });
});

describe('following tics', () => {
    const now = '2026-10-14T12:00:00.000Z';
    const found = [{ key: 'their tone turned serious', phrase: 'his tone turned serious' }];

    it('starts a found tic at 1, raises it when a reply uses it again, and fades it after quiet replies', () => {
        let tics = addFound([], found, { now, counter: 4 });
        expect(tics).toEqual([{ phrase: 'his tone turned serious', key: 'their tone turned serious', count: 1, last_used: now, seen_at: 4, decay_from: 4 }]);
        expect(addFound(tics, found, { now, counter: 9 })).toEqual(tics);
        tics = updateForReply(tics, 'Her tone turned serious again.', { now, counter: 5, fadeAfter: 3 });
        expect(tics[0].count).toBe(2);
        expect(activeTics(tics).map((t) => t.phrase)).toEqual(['his tone turned serious']);
        tics = updateForReply(tics, 'Nothing.', { now, counter: 7, fadeAfter: 3 });
        expect(tics[0].count).toBe(2);
        tics = updateForReply(tics, 'Nothing.', { now, counter: 8, fadeAfter: 3 });
        expect(tics[0]).toMatchObject({ count: 1, decay_from: 8 });
        expect(activeTics(tics)).toEqual([]);
        expect(updateForReply(tics, 'Nothing.', { now, counter: 11, fadeAfter: 3 })).toEqual([]);
    });

    it('asks for variety in a block with no apostrophes, only while a tic is in use', () => {
        expect(phraseTicBlock([{ phrase: 'Kael’s jaw tightened', count: 1 }])).toBe('');
        expect(phraseTicBlock([{ phrase: 'Kael’s jaw tightened', count: 3, last_used: now }, { phrase: 'shot a sidelong glance', count: 2, last_used: '2026-10-13' }])).toBe([
            REFERENCE_MARKER,
            'Recent phrase tics detected. Please avoid the following phrases for now and vary your wording:',
            '- Kaels jaw tightened',
            '- shot a sidelong glance',
            'Use alternative gestures or emotional cues. Maintain character voice and scene logic.',
        ].join('\n'));
    });
});

describe('in a chat', () => {
    let fake;
    beforeEach(async () => {
        fake = resetFakeStateEngine();
        Object.assign(getSettings(), { enabled: true, compileWorld: false, phraseTicFadeAfter: 2 });
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, ...replies.map((r) => ({ name: 'GM', mes: r.text, send_date: `d${r.index}` }))];
        await loadCurrentChat();
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'Kael smiled', source_message_id: 'Chat A#1@d1' }]);
    });

    it('the compiler finds them; each new reply counts and fades them; the user can forget one', async () => {
        let context = '';
        fake.respond = async (text) => {
            context ||= text;
            return {
                archivist__compiled_facts: [{ text: 'Kael smiles a lot.', sources: ['m1'] }],
                archivist__compiled_phrase_tics: [{ ref: 'p1', phrase: 'a wry smile tugged at his lips' }],
            };
        };
        await compileOpenChat();
        expect(getChatPhraseTics().map((t) => [t.phrase, t.count])).toEqual([['a wry smile tugged at his lips', 1]]);
        expect(getPhraseTics('Chat A')).toEqual([{ phrase: 'a wry smile tugged at his lips', count: 1, last_used: expect.any(String) }]);

        getContext().chat.push({ name: 'GM', mes: 'A wry smile tugged at his lips once more.', send_date: 'd9' });
        countNewestReply();
        countNewestReply(); // the same reply counts once
        expect(getChatPhraseTics()[0].count).toBe(2);

        for (const n of [10, 11, 12, 13]) {
            getContext().chat.push({ name: 'GM', mes: 'Plain words.', send_date: `d${n}` });
            countNewestReply();
        }
        expect(getChatPhraseTics()).toEqual([]);

        await compileOpenChat({ rebuild: true });
        expect(getChatPhraseTics()).toHaveLength(1);
        removePhraseTic(chatKeyFor(getCurrentChatRef()), getChatPhraseTics()[0].key);
        expect(getChatPhraseTics()).toEqual([]);
        expect(context).toContain('[p1] "A wry smile tugged at his lips" - in 2 replies');
    });

    it('drops tics the older rules found', () => {
        const entry = getSettings().chats[chatKeyFor(getCurrentChatRef())];
        entry.phraseTics = { tics: [{ phrase: 'said his voice', key: 'said their voice', count: 1 }], counter: 3, lastReply: null };
        expect(getChatPhraseTics()).toEqual([]);
    });

    it('does nothing while tracking is off', async () => {
        getSettings().trackPhraseTics = false;
        fake.respond = async () => ({
            archivist__compiled_facts: [{ text: 'x', sources: ['m1'] }],
            archivist__compiled_phrase_tics: [{ ref: 'p1', phrase: 'a wry smile tugged at his lips' }],
        });
        await compileOpenChat();
        expect(getChatPhraseTics()).toEqual([]);
    });
});
