// Phrase tics: finding repeated wording in code (phrase-tics.js), following
// it reply by reply - fading to dormant, flagged again on its return - and
// the watch list per model (phrase-tic-tracker.js), and the Curator block
// asking for variety.

import { getContext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef, chatKeyFor } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import {
    phraseKey, usesPhrase, findCandidates, storyWordsOf, addFound, updateForReply, activeTics, prune, watchEntry, WARN_AT, MAX_TRACKED,
} from '../src/compiler/phrase-tics.js';
import {
    getChatPhraseTics, countNewestReply, removePhraseTic, getWatchList, getWatchText, setWatchText, currentModel, UNKNOWN_MODEL,
} from '../src/compiler/phrase-tic-tracker.js';
import { phraseTicBlock, REFERENCE_MARKER } from '../src/context/prompt-context.js';
import { compileOpenChat } from '../src/compiler/compiler.js';
import { getPhraseTics } from '../src/public-api.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const replies = [
    { index: 1, text: 'Kael leaned back. A wry smile tugged at his lips as the fire cracked. "We are in this together," he said.' },
    { index: 3, text: 'Mira laughed, and a wry smile tugged at her lips. *Outside, rain fell.* "We are in this together, you know."' },
    { index: 5, text: 'The door opened. His tone turned serious when he spoke of the war.' },
    { index: 7, text: 'Her tone turned serious. "We leave at dawn," she said.' },
];
const keys = (list) => list.map((c) => c.key);

describe('matching wording', () => {
    it('ignores pronouns, verb forms, plurals, markup and a name\'s possessive', () => {
        expect(phraseKey('Cupping HER cheeks.')).toBe('cup their cheek');
        expect(phraseKey('cupped Remus\'s cheek')).toBe('cup their cheek');
        expect(phraseKey('cups his cheek')).toBe('cup their cheek');
        expect(usesPhrase('...and *a wry smile tugged at his lips*.', phraseKey('wry smile tugged at their lips'))).toBe(true);
        expect(usesPhrase('Varyn gently cupped Remus\'s cheeks.', phraseKey('cupped his cheek'))).toBe(true);
        expect(usesPhrase('a wry smile', phraseKey('wry smile tugged at their lips'))).toBe(false);
    });

    it('takes a watch-list line of two words or more', () => {
        expect(watchEntry(' "Cupped his cheek." ')).toEqual({ phrase: 'Cupped his cheek', key: 'cup their cheek' });
        expect(watchEntry('smirk')).toBeNull();
        expect(watchEntry('')).toBeNull();
    });
});

describe('finding repeated wording', () => {
    it('finds wording repeated in different replies - narration and dialogue - most repeated, then longest, first', () => {
        const found = findCandidates(replies);
        expect(found.map((c) => c.text)).toEqual(['A wry smile tugged at his lips', 'We are in this together', 'His tone turned serious']);
        expect(found[0]).toMatchObject({ key: 'a wry smil tug at their lip', replies: [1, 3] });
        expect(found[0].example).toBe('A wry smile tugged at his lips as the fire cracked.');
        // Repeated within one reply only, or only filler words: not found.
        expect(findCandidates([{ index: 1, text: 'and then it was and then it was' }, { index: 2, text: 'nothing alike here at all' }])).toEqual([]);
    });

    it('leaves out names, the story\'s own words, what the user writes too, and what was ignored', () => {
        const story = [
            { index: 1, text: 'They walked to the old library at dusk. Varyn went back to Remus.' },
            { index: 2, text: 'Rain fell. They walked to the old library again. Mira went back to Remus.' },
            { index: 3, text: 'Night came. They walked to the old library. Kael went back to Remus.' },
        ];
        expect(keys(findCandidates(story)).some((k) => k.includes('remus'))).toBe(false);
        expect(keys(findCandidates(story)).some((k) => k.includes(phraseKey('walked to the old library')))).toBe(true);
        expect([...storyWordsOf(['The Liston Library', 'Varyn Vance'])]).toEqual(['liston', 'library', 'varyn', 'vanc']);
        expect(keys(findCandidates(story, { storyWords: storyWordsOf(['The Liston Library']) })).some((k) => k.includes('library'))).toBe(false);
        expect(findCandidates(replies, { userTexts: ['I tell him we are in this together.'] }).map((c) => c.text)).not.toContain('We are in this together');
        expect(findCandidates(replies, { ignored: new Set([phraseKey('his tone turned serious')]) }).map((c) => c.text)).not.toContain('His tone turned serious');
    });

    it('keeps one candidate per phrase, needs three replies for three words, and never runs across punctuation', () => {
        const found = keys(findCandidates([
            { index: 1, text: 'Varyn reached out, placing a hand on his shoulder. He raised an eyebrow.' },
            { index: 2, text: 'Mira reached out, placing a hand on her shoulder. She raised an eyebrow, amused.' },
            { index: 3, text: 'Dawn broke slowly. He raised an eyebrow at the map.' },
        ]));
        expect(found.filter((k) => k.includes('hand on their shoulder'))).toHaveLength(1);
        expect(found).toContain(phraseKey('he raised an eyebrow'));
        expect(findCandidates([{ index: 1, text: 'Mira raised an eyebrow.' }, { index: 2, text: 'Kael raised an eyebrow.' }])).toEqual([]);
        const spoken = keys(findCandidates([
            { index: 1, text: 'Varyn said, his voice low. It spoke volumes about the depth of their bond.' },
            { index: 2, text: 'Mira said, her voice low. It spoke volumes about the depth of their trust.' },
        ]));
        expect(spoken).toEqual([phraseKey('it spoke volumes about the depth')]);
    });
});

describe('following tics', () => {
    const now = '2026-10-15T12:00:00.000Z';
    const tone = { key: phraseKey('his tone turned serious'), text: 'his tone turned serious', replies: [5, 7] };

    it('flags a found tic at once, fades it to dormant without dropping it, and flags it again the moment it returns', () => {
        let tics = addFound([], [tone], { now, counter: 4 });
        expect(tics).toEqual([{ phrase: 'his tone turned serious', key: tone.key, count: WARN_AT, last_used: now, seen_at: 4, decay_from: 4 }]);
        expect(activeTics(tics)).toHaveLength(1);
        for (const counter of [7, 10]) tics = updateForReply(tics, 'Nothing.', { now, counter, fadeAfter: 3 });
        expect(tics[0].count).toBe(0);
        expect(activeTics(tics)).toEqual([]);
        tics = updateForReply(tics, 'Nothing.', { now, counter: 20, fadeAfter: 3 });
        expect(tics).toHaveLength(1);
        tics = updateForReply(tics, 'Her tone turned serious again.', { now, counter: 21, fadeAfter: 3 });
        expect(tics[0]).toMatchObject({ count: WARN_AT, seen_at: 21 });
        tics = updateForReply(tics, 'His tone turned serious.', { now, counter: 22, fadeAfter: 3 });
        expect(tics[0].count).toBe(WARN_AT + 1);
        // Found again by a compile: flagged, never lowered.
        expect(addFound(tics, [tone], { now, counter: 23 })[0].count).toBe(WARN_AT + 1);
    });

    it('flags a watched phrase on its first use', () => {
        const watch = [watchEntry('cupped his cheek')];
        expect(updateForReply([], 'Plain words.', { now, counter: 1, fadeAfter: 3, watch })).toEqual([]);
        const tics = updateForReply([], 'She cupped Remus\'s cheek.', { now, counter: 2, fadeAfter: 3, watch });
        expect(tics).toEqual([{ phrase: 'cupped his cheek', key: 'cup their cheek', count: WARN_AT, last_used: now, seen_at: 2, decay_from: 2 }]);
    });

    it('keeps at most MAX_TRACKED, letting the dormant ones longest unused go first', () => {
        const tics = Array.from({ length: MAX_TRACKED + 2 }, (_, i) => ({ key: `k${i}`, count: i < 3 ? 0 : 1, last_used: `2026-10-${String(10 + i % 10).padStart(2, '0')}` }));
        const kept = prune(tics);
        expect(kept).toHaveLength(MAX_TRACKED);
        expect(kept.map((t) => t.key)).not.toContain('k0');
        expect(kept.map((t) => t.key)).not.toContain('k1');
        expect(kept.map((t) => t.key)).toContain('k2');
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
    const reply = (mes, sendDate, model = 'stheno-8b') => ({ name: 'GM', mes, send_date: sendDate, extra: { model } });
    beforeEach(async () => {
        fake = resetFakeStateEngine();
        Object.assign(getSettings(), { enabled: true, compileWorld: false, phraseTicFadeAfter: 2 });
        delete getSettings().phraseTicWatch;
        delete getSettings().phraseTicIgnored;
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, ...replies.map((r) => reply(r.text, `d${r.index}`))];
        await loadCurrentChat();
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'Kael smiled', source_message_id: 'Chat A#1@d1' }]);
        fake.respond = async () => ({ archivist__compiled_facts: [{ text: 'Kael smiles a lot.', entities: ['Kael'], sources: ['m1'] }] });
    });

    it('a compile flags what repeats and puts it on the model\'s watch list; replies fade it and flag it again', async () => {
        await compileOpenChat();
        expect(getChatPhraseTics().map((t) => [t.phrase, t.count])).toEqual([
            ['A wry smile tugged at his lips', 2], ['We are in this together', 2], ['His tone turned serious', 2],
        ]);
        expect(getPhraseTics('Chat A')).toHaveLength(3);
        expect(currentModel()).toBe('stheno-8b');
        expect(getWatchList('stheno-8b').map((w) => w.phrase)).toEqual(expect.arrayContaining(['cupped his cheek', 'We are in this together']));
        // Another model's list is untouched.
        expect(getWatchList('other-model').map((w) => w.phrase)).not.toContain('We are in this together');

        for (const n of [10, 11, 12, 13, 14, 15, 16, 17]) {
            getContext().chat.push(reply('Plain words.', `d${n}`));
            countNewestReply();
        }
        expect(getChatPhraseTics().every((t) => t.count === 0)).toBe(true);
        expect(getChatPhraseTics()).toHaveLength(3);

        getContext().chat.push(reply('"We are in this together," Mira whispered.', 'd20'));
        countNewestReply();
        countNewestReply(); // the same reply counts once
        expect(getChatPhraseTics().find((t) => t.phrase === 'We are in this together').count).toBe(WARN_AT);
    });

    it('flags a phrase on the writing model\'s watch list at its first use - not another model\'s', () => {
        getContext().chat.push(reply('Varyn cupped Remus\'s cheek.', 'd9', 'other-model'));
        countNewestReply();
        expect(getChatPhraseTics().map((t) => t.phrase)).toEqual(['cupped his cheek']);

        // A phrase on one model's list only.
        setWatchText(`${getWatchText('stheno-8b')}\nhis jaw tightened`, 'stheno-8b');
        getContext().chat.push(reply('Her jaw tightened.', 'd10', 'third-model'));
        countNewestReply();
        expect(getChatPhraseTics().map((t) => t.phrase)).not.toContain('his jaw tightened');
        getContext().chat.push(reply('Her jaw tightened.', 'd11', 'stheno-8b'));
        countNewestReply();
        expect(getChatPhraseTics().find((t) => t.phrase === 'his jaw tightened').count).toBe(WARN_AT);

        // Taken off one model's list: ignored everywhere.
        setWatchText(getWatchText('stheno-8b').replace('cupped his cheek\n', ''), 'stheno-8b');
        getContext().chat.push(reply('She cupped his cheek.', 'd12', 'third-model'));
        countNewestReply();
        expect(getChatPhraseTics().find((t) => t.phrase === 'cupped his cheek')).toBeUndefined();
    });

    it('the user can stop tracking a tic - in every chat and list, for good - and put it back', async () => {
        await compileOpenChat();
        const key = getChatPhraseTics().find((t) => t.phrase === 'We are in this together').key;
        removePhraseTic(chatKeyFor(getCurrentChatRef()), key);
        expect(getChatPhraseTics().map((t) => t.key)).not.toContain(key);
        expect(getWatchText('stheno-8b')).not.toContain('We are in this together');
        await compileOpenChat({ rebuild: true });
        expect(getChatPhraseTics().map((t) => t.key)).not.toContain(key);

        setWatchText(`${getWatchText('stheno-8b')}\nWe are in this together`, 'stheno-8b');
        getContext().chat.push(reply('"We are in this together."', 'd30'));
        countNewestReply();
        // Caught again - by the default "in this together", or the phrase put back.
        expect(getChatPhraseTics().some((t) => key.includes(t.key) && t.count >= WARN_AT)).toBe(true);
    });

    it('drops tics the older rules found, and knows no model before a reply', () => {
        const entry = getSettings().chats[chatKeyFor(getCurrentChatRef())];
        entry.phraseTics = { rules: 2, tics: [{ phrase: 'said his voice', key: 'said their voice', count: 1 }], counter: 3, lastReply: null };
        expect(getChatPhraseTics()).toEqual([]);
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }];
        expect(currentModel()).toBe(UNKNOWN_MODEL);
    });

    it('does nothing while tracking is off', async () => {
        getSettings().trackPhraseTics = false;
        await compileOpenChat();
        getContext().chat.push(reply('Varyn cupped his cheek.', 'd9'));
        countNewestReply();
        expect(getChatPhraseTics()).toEqual([]);
        getSettings().trackPhraseTics = true;
    });
});
