// The Archivist Compiler: colour tags (compiled-schema.js), planning,
// parsing and the view (compile-plan.js), scheduling (schedule.js), and
// runs through the compiler's independent preset (compiler.js) against the
// State Engine stand-in, whose `respond` plays the model.

import { getContext, files, eventSource } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords, deleteChatMemories } from '../src/memory/archivist.js';
import { getCurrentChatRef, getChatEntry, compiledFileFor } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { colorTagFor, normalizeClassification, withColorTag, COLOR_TAGS } from '../src/compiler/compiled-schema.js';
import { refsFor, compileContext, parseCompileOutput, changesSince, buildCompiledView, EMPTY_COMPILED } from '../src/compiler/compile-plan.js';
import { similarity, meaningfulCount, shouldCompile } from '../src/compiler/schedule.js';
import {
    compileOpenChat, getCompiledMemory, getCompilerStatus, checkSchedule, maybeCompile, COMPILER_PRESET, COMPILER_HEADER, COMPILED_CHANGED_EVENT, COMPILE_BATCH,
} from '../src/compiler/compiler.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const ALICE = 'char:alice.png:Chat A';
const rec = (id, extra = {}) => ({ id, subtype: 'fact', scope: 'session', importance: 'medium', text: id, entity_ids: [], source_message_id: `C#${extra.at ?? 0}@d`, chat_id: 'C', created_at: 't', ...extra });
const resolve = (name) => ({ id: name === 'Lucian' ? 'chr_lucian' : null, name });

describe('colour tags', () => {
    it('go by classification, with relationship and contradiction overriding', () => {
        expect(colorTagFor({ classification: 'PERMANENT' })).toEqual({ name: 'Permanent', color: 'Blue', hex: '#4a90d9' });
        expect(colorTagFor({ classification: 'SESSION' }).color).toBe('Yellow');
        expect(colorTagFor({ classification: 'SCENE' }).color).toBe('Green');
        expect(colorTagFor({ classification: 'SCENE', relationship: true }).color).toBe('Purple');
        expect(colorTagFor({ classification: 'SCENE', relationship: true, contradiction: true }).color).toBe('Red');
    });

    it('are attached in both shapes', () => {
        expect(withColorTag({ text: 't' }, { classification: 'PERMANENT' })).toMatchObject({ tag: COLOR_TAGS.PERMANENT, color_tag: 'Blue', color_name: 'Permanent', color_hex: '#4a90d9' });
    });

    it('classifications normalize, from scopes too', () => {
        expect(normalizeClassification('permanent')).toBe('PERMANENT');
        expect(normalizeClassification('long_term')).toBe('PERMANENT');
        expect(normalizeClassification('Scene')).toBe('SCENE');
        expect(normalizeClassification('whatever', 'SCENE')).toBe('SCENE');
    });
});

describe('planning and parsing', () => {
    const previous = {
        facts: [{ id: 'f1', text: 'Lucian works at the gym.', classification: 'PERMANENT', theme: 'employment', entities: [{ id: 'chr_lucian', name: 'Lucian' }], sources: ['m_old'], contradicts: [] }],
        relationships: [{ from: { id: 'chr_lucian', name: 'Lucian' }, to: { id: null, name: 'Mira' }, type: 'trains', text: 'Lucian trains Mira.', sources: ['m_old'] }],
        included: ['m_old'],
        compiledAt: '2026-10-11T10:00:00.000Z',
    };
    const batch = [rec('m_a', { text: 'Lucian picks up extra shifts.', entity_ids: ['chr_lucian'], at: 12 }), rec('m_b', { text: 'It is raining.', subtype: 'event', scope: 'scene', at: 13 })];

    it('gives the batch local refs and lists current knowledge and new memories', () => {
        expect([...refsFor(batch)]).toEqual([['m1', 'm_a'], ['m2', 'm_b']]);
        const text = compileContext(previous, batch, (id) => (id === 'chr_lucian' ? 'Lucian' : null));
        expect(text).toContain('[f1] PERMANENT · employment · about Lucian: Lucian works at the gym.');
        expect(text).toContain('- Lucian trains Mira: Lucian trains Mira.');
        expect(text).toContain('[m1] (fact, session, medium, message #12) about Lucian: Lucian picks up extra shifts.');
        expect(text).toContain('[m2] (event, scene, medium, message #13): It is raining.');
        expect(compileContext(EMPTY_COMPILED, [], () => null)).toContain('Facts:\n(none yet)\nRelationships:\n(none yet)');
    });

    it('turns the answer into the next state, keeping a continued fact\'s id and earlier sources', () => {
        const next = parseCompileOutput([
            { id: 'f1', text: 'Lucian works at the gym and picks up extra shifts.', entities: ['Lucian'], classification: 'PERMANENT', theme: 'Employment', sources: ['m1'], contradicts: [] },
            { id: 'f9', text: 'It is raining.', entities: [], classification: 'SCENE', theme: 'weather', sources: ['[m2]'] },
            { text: 'no id given', sources: [] },
            { id: 'f1', text: 'a repeated id gets a new one' },
            { classification: 'SCENE' },
        ], [
            { from: 'Lucian', to: 'Mira', type: 'Trains', text: 'Lucian trains Mira.', sources: ['m1'] },
            { from: 'Lucian', to: 'Mira', type: 'trains' },
            { from: 'Lucian', type: 'missing to' },
        ], { previous, refs: refsFor(batch), recordsById: new Map(batch.map((r) => [r.id, r])), resolve });

        expect(next.facts.map((f) => f.id)).toEqual(['f1', 'f9', 'f10', 'f11']);
        expect(next.facts[0]).toMatchObject({ theme: 'employment', sources: ['m_old', 'm_a'], entities: [{ id: 'chr_lucian', name: 'Lucian' }] });
        expect(next.facts[1]).toMatchObject({ classification: 'SCENE', sources: ['m_b'] });
        expect(next.relationships).toHaveLength(1);
        expect(next.relationships[0]).toMatchObject({ type: 'trains', sources: ['m_old', 'm_a'] });
    });

    it('falls back to the sources\' scope for a missing classification', () => {
        const next = parseCompileOutput([{ text: 'Raining', sources: ['m2'] }], [], { previous: EMPTY_COMPILED, refs: refsFor(batch), recordsById: new Map(batch.map((r) => [r.id, r])), resolve });
        expect(next.facts[0].classification).toBe('SCENE');
    });

    it('keeps contradictions only between facts of the answer', () => {
        const next = parseCompileOutput([
            { id: 'f1', text: 'a', contradicts: ['f2', 'f1', 'f7'] },
            { id: 'f2', text: 'b', contradicts: [] },
        ], [], { previous: EMPTY_COMPILED, refs: new Map(), recordsById: new Map(), resolve });
        expect(next.facts[0].contradicts).toEqual(['f2']);
    });

    it('refuses an answer that would drop every fact', () => {
        expect(parseCompileOutput([], [], { previous, refs: new Map(), recordsById: new Map(), resolve })).toBeNull();
        expect(parseCompileOutput([], [], { previous: EMPTY_COMPILED, refs: new Map(), recordsById: new Map(), resolve })).toEqual({ facts: [], relationships: [] });
    });

    it('knows what was added and removed since the last compile', () => {
        expect(changesSince(previous, [rec('m_a')])).toEqual({ added: [rec('m_a')], removed: 1 });
    });
});

describe('the compiled view', () => {
    const records = [
        rec('m1', { at: 3, chat_id: 'Chat A', source_message_id: 'Chat A#3@d3', subtype: 'event', text: 'Lucian arrived' }),
        rec('m2', { at: 8, chat_id: 'Chat A', source_message_id: 'Chat A#8@d8' }),
        rec('m3', { at: 5, chat_id: 'Chat A', source_message_id: 'Chat A#5@d5', subtype: 'event', text: 'It rained' }),
    ];
    const compiled = {
        compiledAt: 'now',
        included: ['m1', 'm2', 'm3', 'gone'],
        facts: [
            { id: 'f1', text: 'Lucian works at the gym', classification: 'PERMANENT', theme: 'employment', entities: [{ id: 'chr_lucian', name: 'Lucian' }], sources: ['m2', 'm1'], contradicts: [] },
            { id: 'f2', text: 'Lucian is unemployed', classification: 'PERMANENT', theme: 'employment', entities: [{ id: 'chr_lucian', name: 'Lucian' }], sources: ['m2'], contradicts: ['f1'] },
            { id: 'f3', text: 'It is raining', classification: 'SCENE', theme: 'weather', entities: [], sources: ['m3'], contradicts: [] },
            { id: 'f4', text: 'On a break', classification: 'SESSION', theme: 'activity', entities: [], sources: ['gone'], contradicts: [] },
            { id: 'f5', text: 'General note', classification: 'PERMANENT', theme: 'general', entities: [], sources: [], contradicts: [] },
        ],
        relationships: [{ from: { id: 'chr_lucian', name: 'Lucian' }, to: { id: null, name: 'Mira' }, type: 'trains', text: 'Lucian trains Mira.', sources: ['m1'] }],
    };
    const view = buildCompiledView(compiled, records);

    it('groups permanent facts into profiles by entity, others by classification', () => {
        expect(view.character_profiles.map((p) => [p.name, p.entity_id, p.facts.map((f) => f.id)])).toEqual([['General', null, ['f5']], ['Lucian', 'chr_lucian', ['f1', 'f2']]]);
        expect(view.scene_state.map((f) => f.id)).toEqual(['f3']);
        expect(view.session_details).toEqual([]); // f4 rests only on a memory that is gone
    });

    it('colours facts, contradictions in red on both sides, relationships in purple', () => {
        const [f1, f2] = view.character_profiles[1].facts;
        expect([f1.color_tag, f2.color_tag]).toEqual(['Red', 'Red']);
        expect(view.scene_state[0].color_tag).toBe('Green');
        expect(view.character_profiles[0].facts[0].color_tag).toBe('Blue');
        expect(view.relationships[0].color_tag).toBe('Purple');
    });

    it('links each fact and relationship back to its chat messages', () => {
        const f1 = view.character_profiles[1].facts[0];
        expect(f1).toMatchObject({
            chat_id: 'Chat A',
            source_memory_ids: ['m2', 'm1'],
            source_messages: [
                { memory_id: 'm1', message_index: 3, source_message_id: 'Chat A#3@d3' },
                { memory_id: 'm2', message_index: 8, source_message_id: 'Chat A#8@d8' },
            ],
            message_range: { from: 3, to: 8 },
        });
        expect(view.relationships[0].message_range).toEqual({ from: 3, to: 3 });
        expect(view.character_profiles[0].facts[0].message_range).toBeNull();
    });

    it('builds the timeline from event memories in story order', () => {
        expect(view.timeline.map((t) => [t.text, t.message_index, t.source_message_id])).toEqual([['Lucian arrived', 3, 'Chat A#3@d3'], ['It rained', 5, 'Chat A#5@d5']]);
    });

    it('counts memories not compiled in yet', () => {
        expect(buildCompiledView(compiled, [...records, rec('new')]).pending).toBe(1);
    });
});

describe('scheduling', () => {
    const settings = { compileThreshold: 15, compileIntervalMinutes: 30, compileMinGapMinutes: 5 };
    const minutes = (m) => m * 60000;
    const now = Date.parse('2026-10-11T12:00:00.000Z');
    const ago = (m) => new Date(now - minutes(m)).toISOString();

    it('compares texts by word overlap', () => {
        expect(similarity('Lucian rides the bus home', 'Lucian rides the bus home')).toBe(1);
        expect(similarity('Lucian rides the bus home', 'Mira bakes bread')).toBe(0);
    });

    it('does not count near-repeats as new', () => {
        const existing = [{ text: 'Lucian rides the city bus home in the rain' }];
        const added = [{ text: 'Lucian rides the city bus home in the rain.' }, { text: 'Mira opens the bakery' }, { text: 'Mira opens the bakery!' }];
        expect(meaningfulCount(added, existing)).toBe(1);
    });

    it('runs on a manual request, never with nothing new', () => {
        expect(shouldCompile({ meaningful: 0, manual: true, settings }).compile).toBe(true);
        expect(shouldCompile({ meaningful: 0, settings, now }).reason).toBe('nothing new');
    });

    it('runs at the threshold, but not right after a run', () => {
        expect(shouldCompile({ meaningful: 15, settings, now }).reason).toBe('threshold');
        expect(shouldCompile({ meaningful: 14, settings, now }).compile).toBe(false);
        expect(shouldCompile({ meaningful: 40, lastCompiledAt: ago(2), settings, now }).reason).toBe('compiled recently');
    });

    it('runs after the interval with at least one new memory', () => {
        expect(shouldCompile({ meaningful: 1, lastCompiledAt: ago(31), settings, now }).reason).toBe('interval');
        expect(shouldCompile({ meaningful: 1, lastCompiledAt: ago(10), settings, now }).compile).toBe(false);
        expect(shouldCompile({ meaningful: 1, lastCompiledAt: null, settings, now }).compile).toBe(false);
    });
});

describe('compiling through the independent preset', () => {
    let fake;
    const store = (items) => addMemoryRecords(getCurrentChatRef(), items);
    const factsAnswer = (context) => {
        const refs = [...context.matchAll(/\[(m\d+)\]/g)].map((m) => m[1]);
        const known = [...context.matchAll(/\[(f\d+)\] \w+ · [^·:]+(?: · about [^:]+)?: (.+)/g)].map((m) => ({ id: m[1], text: m[2] }));
        return {
            archivist__compiled_facts: [
                ...known.map((f) => ({ ...f, classification: 'PERMANENT', theme: 'employment', entities: ['Lucian'], sources: [] })),
                ...refs.map((ref, i) => ({ id: `f${known.length + i + 1}`, text: `compiled ${ref}`, classification: 'SESSION', theme: 'activity', entities: ['Lucian'], sources: [ref] })),
            ],
            archivist__compiled_relationships: [{ from: 'Lucian', to: 'Mira', type: 'trains', text: 'Lucian trains Mira.', sources: refs.slice(0, 1) }],
        };
    };

    beforeEach(async () => {
        fake = resetFakeStateEngine();
        fake.addObject('chr_lucian', 'character', 'Lucian');
        fake.respond = async (context) => factsAnswer(context);
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, { name: 'Lucian', mes: 'Lucian works.', send_date: 'd1' }];
        Object.assign(getSettings(), { enabled: true, compileAuto: true, compileThreshold: 3, compileMinGapMinutes: 5, compilerConnectionProfileId: 'big', compilerMaxTokens: 4000 });
        await loadCurrentChat();
    });

    it('creates its own independent preset with two record lists, and runs on its own connection', async () => {
        await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const preset = fake.presets.get(`archivist.${COMPILER_PRESET}`);
        expect(preset.independentPreset).toBe(true);
        expect(preset.independentConfig.promptedHeader).toBe(COMPILER_HEADER);
        expect([...preset.variables.keys()]).toEqual(['archivist__compiled_facts', 'archivist__compiled_relationships']);
        expect(preset.variables.get('archivist__compiled_facts').prompted.newEachTurn).toBe(true);
        expect(fake.calls.filter((c) => c.name === 'configureIndependentPreset').at(-1).args[2]).toMatchObject({ connectionProfileId: 'big', maxTokens: 4000 });
    });

    it('stores the compiled memory, clears the variables, and serves the view with message links', async () => {
        const [m] = await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1', subtype: 'event' }]);
        eventSource.emit.mockClear();
        await compileOpenChat();

        expect(getCompilerStatus()).toMatchObject({ running: false, outcome: 'compiled' });
        expect(fake.readValue('Chat A', 'archivist__compiled_facts')).toEqual([]);
        expect(JSON.parse(files.get(compiledFileFor(getChatEntry(ALICE))))).toMatchObject({ included: [m.id] });
        expect(eventSource.emit).toHaveBeenCalledWith(COMPILED_CHANGED_EVENT, { chatId: 'Chat A', chatKey: ALICE });

        const view = await getCompiledMemory();
        expect(view.session_details[0]).toMatchObject({ text: 'compiled m1', color_tag: 'Yellow', entities: [{ id: 'chr_lucian', name: 'Lucian' }], message_range: { from: 1, to: 1 } });
        expect(view.relationships[0]).toMatchObject({ type: 'trains', color_tag: 'Purple', from: { id: 'chr_lucian' } });
        expect(view.timeline).toHaveLength(1);
        expect(await getCompiledMemory('Chat A')).toEqual(view);
    });

    it('is incremental: a later run sends only the new memories, with the current facts', async () => {
        await store([{ text: 'first', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        await store([{ text: 'second', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const context = fake.calls.filter((c) => c.name === 'runIndependentPreset').at(-1).args[2];
        expect(context).toContain('[f1] SESSION · activity · about Lucian: compiled m1');
        expect(context).toContain('[m1] (fact, session, medium, message #1): second');
        expect(context).not.toContain(': first');
    });

    it('does nothing when there is nothing new, unless rebuilding', async () => {
        await store([{ text: 'one', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const runs = () => fake.calls.filter((c) => c.name === 'runIndependentPreset').length;
        await compileOpenChat();
        expect(getCompilerStatus().outcome).toBe('nothing');
        expect(runs()).toBe(1);
        await compileOpenChat({ rebuild: true });
        expect(runs()).toBe(2);
        expect(fake.calls.filter((c) => c.name === 'runIndependentPreset').at(-1).args[2]).toContain(': one');
    });

    it('feeds a large backlog in batches', async () => {
        await store(Array.from({ length: COMPILE_BATCH + 5 }, (_, i) => ({ text: `memory ${i}`, source_message_id: 'Chat A#1@d1' })));
        await compileOpenChat();
        expect(fake.calls.filter((c) => c.name === 'runIndependentPreset')).toHaveLength(2);
        expect((await getCompiledMemory()).pending).toBe(0);
    });

    it('keeps the previous compiled memory when a run fails or drops every fact', async () => {
        await store([{ text: 'one', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        await store([{ text: 'two', source_message_id: 'Chat A#1@d1' }]);

        fake.respond = async () => ({ archivist__compiled_facts: [], archivist__compiled_relationships: [] });
        await compileOpenChat();
        expect(getCompilerStatus()).toMatchObject({ outcome: 'failed', error: expect.stringContaining('dropped every fact') });

        fake.respond = async () => { throw new Error('model down'); };
        await compileOpenChat();
        expect(getCompilerStatus()).toMatchObject({ outcome: 'failed', error: 'model down' });
        expect((await getCompiledMemory()).session_details.map((f) => f.text)).toEqual(['compiled m1']);
        expect((await getCompiledMemory()).pending).toBe(1);
    });

    it('returns null for a chat never compiled, and loses the file with the chat\'s memories', async () => {
        expect(await getCompiledMemory()).toBeNull();
        await store([{ text: 'one', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const fileName = compiledFileFor(getChatEntry(ALICE));
        await deleteChatMemories(ALICE);
        expect(files.has(fileName)).toBe(false);
        expect(await getCompiledMemory()).toBeNull();
    });

    it('compiles on its own at the threshold, while enabled and automatic', async () => {
        await store(['Mira bakes bread at dawn', 'Lucian lifts weights at the gym'].map((text) => ({ text, source_message_id: 'Chat A#1@d1' })));
        expect((await checkSchedule()).compile).toBe(false);
        await store([{ text: 'something else entirely happened', source_message_id: 'Chat A#1@d1' }]);
        expect(await checkSchedule()).toMatchObject({ compile: true, reason: 'threshold', added: 3 });

        const runs = () => fake.calls.filter((c) => c.name === 'runIndependentPreset').length;
        getSettings().compileAuto = false;
        await maybeCompile();
        expect(runs()).toBe(0);

        getSettings().enabled = false;
        getSettings().compileAuto = true;
        await maybeCompile();
        expect(runs()).toBe(0);

        getSettings().enabled = true;
        await maybeCompile();
        expect(runs()).toBe(1);
        expect(getCompilerStatus()).toMatchObject({ outcome: 'compiled', reason: 'threshold' });

        // Right after a run, more memories wait for the minimum gap.
        await store(['A wholly unrelated harbour storm', 'Kael sharpens a sword', 'The bakery burns down'].map((text) => ({ text, source_message_id: 'Chat A#1@d1' })));
        expect(await checkSchedule()).toMatchObject({ compile: false, reason: 'compiled recently' });
    });
});
