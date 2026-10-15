// Memories linked to the objects their own text names - locations,
// creatures, any type the user made - when stored and again later
// (src/memory/object-mentions.js, archivist.js linkObjectMentions).

import { getContext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords, linkObjectMentions, getMemoriesForEntity, getAllMemories } from '../src/memory/archivist.js';
import { getCurrentChatRef, chatKeyFor } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { mentionMatcher, mentionMatcherFor, withMentions } from '../src/memory/object-mentions.js';
import { convertExtractedItems } from '../src/extraction/converter.js';
import { compileOpenChat } from '../src/compiler/compiler.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const objects = [
    { id: 'loc_town', type: 'location', name: 'Town of Liston', aliases: ['near Liston\'s gates'] },
    { id: 'loc_lib', type: 'location', name: 'The Liston Library', aliases: ['the_old_library', 'Library'] },
    { id: 'crt_hollow', type: 'creature', name: 'The Hollow Chronicler' },
    { id: 'chr_remus', type: 'character', name: 'Remus Watt', aliases: ['Remus'] },
    { id: 'loc_a', type: 'location', name: 'The Gate', aliases: ['Old Gate'] },
    { id: 'loc_b', type: 'location', name: 'North Gate', aliases: ['Old Gate'] },
    { id: 'item_x', type: 'item', name: 'Ox' },
];
const ids = (list) => list.map((o) => o.id);

describe('finding the objects a text names', () => {
    const mentionsIn = mentionMatcher(objects);

    it('matches names and aliases as whole words, ignoring case, articles, possessives and underscores', () => {
        expect(ids(mentionsIn('Remus and Varyn left the Liston Library\'s dusty halls.'))).toEqual(['loc_lib', 'chr_remus']);
        expect(ids(mentionsIn('The Hollow Chronicler watched from the old library.'))).toEqual(['loc_lib', 'crt_hollow']);
        expect(ids(mentionsIn('They reached the town of Liston.'))).toEqual(['loc_town']);
        expect(ids(mentionsIn('A librarian and a Remuskin.'))).toEqual([]);
    });

    it('leaves out a name two objects share, and names too short to trust', () => {
        expect(ids(mentionsIn('They passed the Old Gate.'))).toEqual([]);
        expect(ids(mentionsIn('They passed The Gate.'))).toEqual(['loc_a']);
        expect(ids(mentionsIn('An ox pulled the cart.'))).toEqual([]);
    });

    it('adds only the links a memory lacks', () => {
        const record = { text: 'Remus read in the library.', entity_ids: ['chr_remus'], entity_types: { chr_remus: 'character' } };
        expect(withMentions(record, mentionsIn)).toEqual({ ...record, entity_ids: ['chr_remus', 'loc_lib'], entity_types: { chr_remus: 'character', loc_lib: 'location' } });
        const quiet = { ...record, text: 'Remus slept.' };
        expect(withMentions(quiet, mentionsIn)).toBe(quiet);
    });

    it('links them when a memory is stored, besides the names the model gave', async () => {
        const [fields] = await convertExtractedItems([{ text: 'The Hollow Chronicler appeared in the library.', entities: ['Remus'] }], {
            sourceFor: () => 'C#1@d', resolveEntity: async (name) => (name === 'Remus' ? { id: 'chr_remus', type: 'character' } : null), mentionsIn,
        });
        expect(fields.entity_ids).toEqual(['chr_remus', 'crt_hollow', 'loc_lib']);
        expect(fields.entity_types).toEqual({ chr_remus: 'character', loc_lib: 'location', crt_hollow: 'creature' });
    });
});

describe('in a chat', () => {
    let fake;
    beforeEach(async () => {
        fake = resetFakeStateEngine();
        Object.assign(getSettings(), { enabled: true, compileWorld: false });
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, { name: 'GM', mes: 'They walk.', send_date: 'd1' }];
        await loadCurrentChat();
    });

    it('links stored memories to objects made after them - once, writing only when something changes', async () => {
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'They reached the Liston Library at dusk.', source_message_id: 'Chat A#1@d1' }]);
        const chatKey = chatKeyFor(getCurrentChatRef());
        expect(await linkObjectMentions(chatKey, await mentionMatcherFor('Chat A'))).toBe(0);

        fake.addObject('loc_lib', 'location', 'The Liston Library', 'Library');
        expect(await linkObjectMentions(chatKey, await mentionMatcherFor('Chat A'))).toBe(1);
        expect(getMemoriesForEntity('loc_lib').map((m) => m.text)).toEqual(['They reached the Liston Library at dusk.']);
        expect((await getAllMemories())[0].entity_types).toEqual({ loc_lib: 'location' });
        expect(await linkObjectMentions(chatKey, await mentionMatcherFor('Chat A'))).toBe(0);
    });

    it('links them before a compile', async () => {
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'The Hollow Chronicler blocked the door.', source_message_id: 'Chat A#1@d1' }]);
        fake.addObject('crt_hollow', 'creature', 'The Hollow Chronicler');
        fake.respond = async () => ({ archivist__compiled_facts: [{ text: 'x', sources: ['m1'] }] });
        await compileOpenChat();
        expect(getMemoriesForEntity('crt_hollow')).toHaveLength(1);
    });
});
