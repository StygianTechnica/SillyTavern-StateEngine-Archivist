// @vitest-environment jsdom
//
// Linking the names the compiler's model writes to State Engine objects
// (src/compiler/entity-link.js), and getCompiledMemory() linking names to
// objects that only exist after the compile (src/compiler/compiler.js).

import { getContext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { nameKey, objectNameIndex, relinkCompiled, aliasSuggestions } from '../src/compiler/entity-link.js';
import { compileOpenChat, getCompiledMemory } from '../src/compiler/compiler.js';
import { EMPTY_COMPILED } from '../src/compiler/compile-plan.js';
import { openMemoryBrowser, closeMemoryBrowser } from '../src/ui/memory-browser.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

describe('aliasSuggestions', () => {
    const objects = [
        { id: 'chr_g', type: 'character', name: 'A lead gremlin', aliases: [] },
        { id: 'chr_s', type: 'character', name: 'Syrvanus Voxaris', aliases: ['Syr'] },
        { id: 'chr_z', type: 'character', name: 'Zeno', aliases: [] },
    ];

    it('offers the names the story uses for an object that it does not have, once each', () => {
        const compiled = {
            ...EMPTY_COMPILED,
            relationships: [
                { from: { id: 'chr_s', name: 'Syrvanus Voxaris' }, to: { id: 'chr_g', name: 'gremlin (lead)' } },
                { from: { id: 'chr_g', name: 'Gremlin (Lead)' }, to: { id: 'chr_s', name: 'syr' } },
                { from: { id: 'chr_g', name: 'Zeno' }, to: { id: null, name: 'Rydia' } },
            ],
        };
        expect(aliasSuggestions(compiled, objects)).toEqual([
            { object_id: 'chr_g', object_name: 'A lead gremlin', object_type: 'character', alias: 'gremlin (lead)' },
        ]);
    });
});

describe('nameKey', () => {
    it('reduces a name to its words, in any order, without articles or punctuation', () => {
        expect(nameKey('gremlin (lead)')).toBe(nameKey('A lead gremlin'));
        expect(nameKey('The Old Inn')).toBe(nameKey('old inn'));
        expect(nameKey("Lucian's apartment")).toBe(nameKey('Lucian apartment'));
        expect(nameKey('Zeno')).not.toBe(nameKey('Zeno Voxaris'));
        expect(nameKey('  ')).toBe('');
    });
});

describe('objectNameIndex', () => {
    const lookup = objectNameIndex([
        { id: 'chr_g', type: 'character', name: 'A lead gremlin', aliases: [] },
        { id: 'chr_s', type: 'character', name: 'Syrvanus Voxaris', aliases: ['Syr'] },
        { id: 'loc_a', type: 'location', name: 'Twin Hall', aliases: [] },
        { id: 'loc_b', type: 'location', name: 'Hall Twin', aliases: [] },
    ]);

    it('finds an object by its name or an alias, loosely', () => {
        expect(lookup('gremlin (lead)')).toEqual({ id: 'chr_g', name: 'A lead gremlin', type: 'character' });
        expect(lookup('syr')).toMatchObject({ id: 'chr_s' });
    });

    it('finds nothing for an unknown or ambiguous name', () => {
        expect(lookup('Zeno')).toBeNull();
        expect(lookup('the twin hall')).toBeNull();
    });
});

describe('relinkCompiled', () => {
    const lookup = objectNameIndex([
        { id: 'chr_g', type: 'character', name: 'A lead gremlin' },
        { id: 'qst_1', type: 'quest', name: 'Find Alvaryx' },
        { id: 'itm_1', type: 'item', name: 'Promotion' },
    ]);
    const gremlin = { id: null, name: 'gremlin (lead)', type: null };
    const syr = { id: 'chr_s', name: 'Syrvanus', type: 'character' };
    const compiled = {
        ...EMPTY_COMPILED,
        facts: [{ id: 'f1', text: 't', entities: [gremlin, syr], sources: [], contradicts: [] }],
        relationships: [{ from: syr, to: gremlin, type: 'ally', sources: [] }],
        characters: [{ entity: gremlin, traits: [], sources: [] }],
        threads: [
            { id: 't1', title: 'Find Alvaryx', entity: null, involved: [gremlin], sources: [] },
            { id: 't2', title: 'Promotion', entity: null, involved: [], sources: [] },
        ],
        world: [{ id: 'w1', kind: 'secret', name: 'gremlin (lead)', entity: null, known_by: [gremlin], involved: [], sources: [] }],
    };
    const linked = relinkCompiled(compiled, lookup);

    it('links unlinked names everywhere, and leaves linked ones alone', () => {
        const g = { id: 'chr_g', name: 'gremlin (lead)', type: 'character' };
        expect(linked.facts[0].entities).toEqual([g, syr]);
        expect(linked.relationships[0]).toMatchObject({ from: syr, to: g });
        expect(linked.characters[0].entity).toEqual(g);
        expect(linked.threads[0].involved).toEqual([g]);
        expect(linked.world[0].known_by).toEqual([g]);
    });

    it('links a thread title only to a quest, and never a secret by its name', () => {
        expect(linked.threads[0].entity).toEqual({ id: 'qst_1', name: 'Find Alvaryx', type: 'quest' });
        expect(linked.threads[1].entity).toBeNull();
        expect(linked.world[0].entity).toBeNull();
    });

    it('does not change the state it was given', () => {
        expect(compiled.relationships[0].to.id).toBeNull();
    });
});

describe('getCompiledMemory', () => {
    it('links a name to an object approved after the compile', async () => {
        const fake = resetFakeStateEngine();
        fake.addObject('chr_s', 'character', 'Syrvanus Voxaris');
        fake.respond = async () => ({
            archivist__compiled_facts: [{ text: 'The gremlins offered help.', entities: ['gremlin (lead)'], sources: ['m1'] }],
            archivist__compiled_relationships: [{ from: 'Syrvanus Voxaris', to: 'gremlin (lead)', type: 'ally', polarity: 2, sources: ['m1'] }],
        });
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, { name: 'Bot', mes: 'Gremlins.', send_date: 'd1' }];
        Object.assign(getSettings(), { enabled: true, compileWorld: false });
        await loadCurrentChat();
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'A lead gremlin offered help.', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        expect((await getCompiledMemory()).relationships[0].to).toMatchObject({ id: null });

        fake.addObject('chr_g', 'character', 'A lead gremlin');
        const view = await getCompiledMemory();
        expect(view.relationships[0].to).toMatchObject({ id: 'chr_g', type: 'character' });
        expect(view.relationships[0].from).toMatchObject({ id: 'chr_s' });
        expect(view.alias_suggestions).toEqual([{ object_id: 'chr_g', object_name: 'A lead gremlin', object_type: 'character', alias: 'gremlin (lead)' }]);

        // The memory browser offers it; a click adds it, and it is no longer suggested.
        document.body.innerHTML = '';
        globalThis.toastr = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
        await openMemoryBrowser({ view: 'compiled' });
        await vi.waitFor(() => expect(document.querySelector('[data-mb-alias]')).not.toBeNull());
        document.querySelector('[data-mb-alias]').click();
        await vi.waitFor(() => expect(document.querySelector('[data-mb-alias]')).toBeNull());
        expect(fake.calls.find((c) => c.name === 'addObjectAlias').args).toEqual(['Chat A', 'chr_g', 'gremlin (lead)']);
        expect(globalThis.toastr.success).toHaveBeenCalled();
        closeMemoryBrowser();
    });
});
