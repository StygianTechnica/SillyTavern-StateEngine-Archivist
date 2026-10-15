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
import {
    refsFor, compileContext, worldContext, parseCompileOutput, parseCharacters, parseThreads, parseWorld, changesSince, buildCompiledView, EMPTY_COMPILED,
    editCompiledItem, removeCompiledItem, editCompiledSummary, compiledItemKey, dismissKey, parseTension, relationshipType, keepAuthored, addCompiledThread, isPlaceholder,
} from '../src/compiler/compile-plan.js';
import { memoryVariableDef } from '../src/extraction/memory-variable.js';
import {
    normalizePolarity, polarityLabel, normalizeIntensity, normalizeTrend, normalizeThreadStatus, normalizeWorldKind, normalizeSecretStatus,
    normalizeStepStatus, stepsToText, stepsFromText, currentStep, normalizeTensionLevel, tensionOverall,
} from '../src/compiler/compiled-schema.js';
import { tensionChart } from '../src/ui/memory-browser-model.js';
import { editValues } from '../src/ui/compiled-edit.js';
import { buildDossier, getEntityDossier, getRelationship } from '../src/compiler/dossier.js';
import { similarity, meaningfulCount, shouldCompile } from '../src/compiler/schedule.js';
import {
    compileOpenChat, getCompiledMemory, getCompilerStatus, checkSchedule, maybeCompile, COMPILER_PRESET, COMPILER_HEADER, COMPILED_CHANGED_EVENT, COMPILE_BATCH,
    WORLD_COMPILER_PRESET, WORLD_COMPILER_HEADER, onCompilerStatus,
} from '../src/compiler/compiler.js';
import { onCompileStatus, retryCompile } from '../src/ui/compile-retry.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const ALICE = 'char:alice.png:Chat A';
const rec = (id, extra = {}) => ({ id, subtype: 'fact', scope: 'session', importance: 'medium', text: id, entity_ids: [], source_message_id: `C#${extra.at ?? 0}@d`, chat_id: 'C', created_at: 't', ...extra });
const resolve = (name) => (name === 'Lucian' ? { id: 'chr_lucian', name, type: 'character' } : { id: null, name, type: null });

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

    it('relationship, thread and world scales normalize', () => {
        expect([normalizePolarity('+2'), normalizePolarity('close'), normalizePolarity(-9), normalizePolarity('??')]).toEqual([2, 2, -3, 0]);
        expect([polarityLabel(-3), polarityLabel(0), polarityLabel(3)]).toEqual(['hostile', 'neutral', 'devoted']);
        expect([normalizeIntensity('HIGH'), normalizeIntensity('strong'), normalizeIntensity('slight'), normalizeIntensity('')]).toEqual(['high', 'high', 'low', 'medium']);
        expect([normalizeTrend('improving'), normalizeTrend('stable'), normalizeTrend('x')]).toEqual(['warming', 'stable', '']);
        // A label and number together, as copied from the context's relationship lines.
        expect(['close (+2)', 'wary (-1)', '−2 antagonistic', 'friendly', 'Devoted.', '2 (close)'].map(normalizePolarity)).toEqual([2, -1, -2, 1, 3, 2]);
        expect([normalizeIntensity('high intensity'), normalizeIntensity('Low-key')]).toEqual(['high', 'low']);
        expect([normalizeTrend('cooling: drifting apart'), normalizeTrend('Warming.')]).toEqual(['cooling', 'warming']);
        expect([normalizeThreadStatus('in progress'), normalizeThreadStatus('Completed'), normalizeThreadStatus('')]).toEqual(['active', 'resolved', 'open']);
        expect([normalizeWorldKind('Place'), normalizeWorldKind('organization'), normalizeWorldKind('world_event'), normalizeWorldKind('custom')]).toEqual(['location', 'faction', 'event', 'lore']);
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
        relationships: [{ from: { id: 'chr_lucian', name: 'Lucian' }, to: { id: null, name: 'Mira' }, type: 'trains', polarity: 1, intensity: 'high', trend: 'warming', text: 'Lucian trains Mira.', sources: ['m_old'] }],
        characters: [{ entity: { id: 'chr_lucian', name: 'Lucian' }, traits: ['diligent'], habits: [], stressors: ['money'], motivations: [], arc: '', emotional_state: 'tired', sources: ['m_old'] }],
        threads: [{ id: 't1', kind: 'quest seed', title: 'The gym job', text: 'Lucian could manage the gym.', status: 'open', progress: '', entity: null, involved: [{ id: 'chr_lucian', name: 'Lucian' }], sources: ['m_old'] }],
        world: [{ id: 'w1', kind: 'secret', name: 'The debt', text: 'Lucian owes money.', entity: null, known_by: [{ id: 'chr_lucian', name: 'Lucian' }], involved: [], status: '', sources: ['m_old'] }],
        included: ['m_old'],
        compiledAt: '2026-10-11T10:00:00.000Z',
        schema: 2,
    };
    const batch = [
        rec('m_a', { text: 'Lucian picks up extra shifts.', entity_ids: ['chr_lucian'], at: 12 }),
        rec('m_b', { text: 'It is raining.', subtype: 'event', scope: 'scene', at: 13, tags: ['contextual'], tone: 'gloomy', witness_ids: ['chr_lucian'] }),
    ];
    const options = { previous, refs: refsFor(batch), recordsById: new Map(batch.map((r) => [r.id, r])), resolve };

    it('gives the batch local refs and lists current knowledge and new memories', () => {
        expect([...refsFor(batch)]).toEqual([['m1', 'm_a'], ['m2', 'm_b']]);
        const text = compileContext(previous, batch, (id) => (id === 'chr_lucian' ? 'Lucian' : null));
        expect(text).toContain('[f1] PERMANENT · employment · about Lucian: Lucian works at the gym.');
        expect(text).toContain('- Lucian -> Mira: trains · friendly (+1) · high intensity · warming: Lucian trains Mira.');
        expect(text).toContain('- Lucian: traits: diligent; stressors: money; feeling: tired');
        expect(text).toContain('[m1] (fact, session, medium, message #12) about Lucian: Lucian picks up extra shifts.');
        expect(text).toContain('[m2] (event, scene, medium, message #13; tags: contextual; tone: gloomy; present: Lucian): It is raining.');
        expect(text).not.toContain('Story threads');
        expect(compileContext(EMPTY_COMPILED, [], () => null)).toContain('Facts:\n(none yet)\nRelationships:\n(none yet)\nCharacters:\n(none yet)');
    });

    it('gives the world part the threads and world entries instead', () => {
        const text = worldContext(previous, batch, (id) => (id === 'chr_lucian' ? 'Lucian' : null));
        expect(text).toContain('[t1] quest seed · open · involves Lucian: The gym job - Lucian could manage the gym.');
        expect(text).toContain('[w1] secret · The debt · known by Lucian: Lucian owes money.');
        expect(text).toContain('[m2] (event, scene, medium, message #13; tags: contextual; tone: gloomy; present: Lucian): It is raining.');
        expect(text).not.toContain('[f1]');
    });

    it('parses relationships with type, polarity, intensity and trend - one per direction of a pair', () => {
        const next = parseCompileOutput([{ id: 'f1', text: 'kept' }], [
            { from: 'Lucian', to: 'Mira', type: 'Mentor', polarity: '+2', intensity: 'strong', trend: 'improving', sources: ['m1'] },
            { from: 'Mira', to: 'Lucian', type: 'student', polarity: 'wary' },
            { from: 'Lucian', to: 'Mira', type: 'boss' },
        ], options);
        expect(next.relationships).toHaveLength(2);
        expect(next.relationships[0]).toMatchObject({ type: 'mentor', polarity: 2, intensity: 'high', trend: 'warming', sources: ['m_old', 'm_a'] });
        expect(next.relationships[1]).toMatchObject({ from: { name: 'Mira' }, polarity: -1, intensity: 'medium', trend: '' });
    });

    it('keeps the previous list when an answer leaves a list out', () => {
        expect(parseCompileOutput([{ id: 'f1', text: 'kept' }], [], options).relationships).toEqual(previous.relationships);
        expect(parseCharacters([], options)).toEqual(previous.characters);
        expect(parseThreads(undefined, options)).toEqual(previous.threads);
        expect(parseWorld([], options)).toEqual(previous.world);
        expect(parseThreads([], { ...options, previous: EMPTY_COMPILED })).toEqual([]);
    });

    it('parses character insights, one per character, keeping earlier sources', () => {
        const characters = parseCharacters([
            { name: 'Lucian', summary: 'A trainer holding the gym together.', traits: 'stubborn, kind', habits: ['runs at dawn.'], stressors: ['rent'], motivations: ['keep the gym open'], arc: 'From aimless to driven.', emotional_state: 'anxious', sources: ['m1'] },
            { name: 'Lucian', traits: ['a repeat is ignored'] },
            { traits: ['no name'] },
        ], options);
        expect(characters).toEqual([{
            entity: { id: 'chr_lucian', name: 'Lucian', type: 'character' }, summary: 'A trainer holding the gym together.', traits: ['stubborn', 'kind'], habits: ['runs at dawn'], stressors: ['rent'],
            motivations: ['keep the gym open'], arc: 'From aimless to driven.', emotional_state: 'anxious', sources: ['m_old', 'm_a'],
        }]);
    });

    it('reads character lists written as plain text, without filler for an empty one', () => {
        const [lucian] = parseCharacters([{ name: 'Lucian', traits: 'curious, introspective', habits: 'none mentioned', stressors: ['N/A'], motivations: 'Not known.' }], options);
        expect(lucian).toMatchObject({ traits: ['curious', 'introspective'], habits: [], stressors: [], motivations: [] });
    });

    it('parses threads with status and progress, keeping ids, and links a quest object by its title', () => {
        const questResolve = (name) => (name === 'The gym job' ? { id: 'qst_gym', name, type: 'quest' } : resolve(name));
        const threads = parseThreads([
            { id: 't1', kind: 'Quest', title: 'The gym job', text: 'Lucian could manage the gym.', status: 'in progress', progress: 'He asked the owner.', involved: ['Lucian'], sources: ['m1'] },
            { id: 't1', title: 'Repeated id', text: 'gets a new one' },
            { text: 'Who broke the window? Nobody knows.' },
        ], { ...options, resolve: questResolve });
        expect(threads.map((t) => [t.id, t.status, t.title])).toEqual([['t1', 'active', 'The gym job'], ['t2', 'open', 'Repeated id'], ['t3', 'open', 'Who broke the window']]);
        expect(threads[0]).toMatchObject({ kind: 'quest', progress: 'He asked the owner.', entity: { id: 'qst_gym', type: 'quest' }, sources: ['m_old', 'm_a'] });
        expect(threads[2]).toMatchObject({ kind: 'unresolved thread', entity: null });
    });

    it('parses a plan - its goal and steps in order - and keeps its steps when an answer leaves them out', () => {
        const threads = parseThreads([{
            kind: 'quest seed', title: 'Supplies from Redhaven', text: 'Varyn\'s plan to equip the expedition.', status: 'open',
            goal: 'Secure supplies for the wasteland expedition',
            steps: [
                { text: 'Salvage old books from the ruined library', status: 'in progress', involved: ['ruined library'], note: 'creatures, Morvath\'s agents' },
                { text: 'Win over Niamh', involved: 'Niamh, Lucian' },
                'Barter with Graxx for supplies',
                { status: 'done' },
            ],
        }], options);
        const plan = threads.find((t) => t.title === 'Supplies from Redhaven');
        expect(plan.goal).toBe('Secure supplies for the wasteland expedition');
        expect(plan.steps).toEqual([
            { text: 'Salvage old books from the ruined library', status: 'active', involved: [{ id: null, name: 'ruined library', type: null }], note: 'creatures, Morvath\'s agents' },
            { text: 'Win over Niamh', status: 'pending', involved: [{ id: null, name: 'Niamh', type: null }, { id: 'chr_lucian', name: 'Lucian', type: 'character' }], note: '' },
            { text: 'Barter with Graxx for supplies', status: 'pending', involved: [], note: '' },
        ]);
        // t1, compiled before plans, is carried forward as it was; the view gives it none.
        expect(buildCompiledView({ ...EMPTY_COMPILED, threads: [{ ...previous.threads[0], sources: [] }] }, []).threads[0]).toMatchObject({ goal: '', steps: [] });

        const later = parseThreads([{ id: plan.id, title: 'Supplies from Redhaven', text: 'x', status: 'active' }], { ...options, previous: { ...previous, threads } });
        expect(later.find((t) => t.id === plan.id)).toMatchObject({ goal: plan.goal, steps: plan.steps, status: 'active' });
        expect(worldContext({ ...previous, threads }, [], () => null)).toContain([
            '    goal: Secure supplies for the wasteland expedition',
            '    1. [active] Salvage old books from the ruined library (creatures, Morvath\'s agents)',
            '    2. [pending] Win over Niamh',
        ].join('\n'));
    });

    it('reads step statuses, finds the current step, and edits steps as lines', () => {
        expect(['done', 'Completed', 'current', 'abandoned', 'failed', '?'].map(normalizeStepStatus)).toEqual(['done', 'done', 'active', 'skipped', 'failed', 'pending']);
        const steps = [{ text: 'a', status: 'done' }, { text: 'b', status: 'skipped' }, { text: 'c', status: 'pending' }];
        expect(currentStep(steps).text).toBe('c');
        expect(currentStep(steps.slice(0, 2))).toBeNull();
        expect(currentStep(undefined)).toBeNull();
        const lines = stepsToText([{ text: 'Get books', status: 'done', note: '' }, { text: 'Win over Niamh', status: 'pending', note: 'she wants a price' }]);
        expect(lines).toBe('[done] Get books\n[pending] Win over Niamh | she wants a price');
        expect(stepsFromText(`${lines}\n\n  Trade with Graxx  \n[finished]`)).toEqual([
            { text: 'Get books', status: 'done', note: '' },
            { text: 'Win over Niamh', status: 'pending', note: 'she wants a price' },
            { text: 'Trade with Graxx', status: 'pending', note: '' },
        ]);

        const niamh = { id: 'chr_niamh', name: 'Niamh', type: 'character' };
        const withPlan = { ...previous, threads: [{ ...previous.threads[0], goal: 'g', steps: [{ text: 'Get books', status: 'active', involved: [], note: '' }, { text: 'Win over Niamh', status: 'pending', involved: [niamh], note: '' }] }] };
        expect(editValues('thread', withPlan.threads[0])).toMatchObject({ goal: 'g', steps: '[active] Get books\n[pending] Win over Niamh' });
        const edited = editCompiledItem(withPlan, 'thread', 't1', { goal: 'Supplies', steps: '[done] Get books\n[active] Win over Niamh | bring wine' });
        expect(edited.threads[0].goal).toBe('Supplies');
        expect(edited.threads[0].steps).toEqual([
            { text: 'Get books', status: 'done', involved: [], note: '' },
            { text: 'Win over Niamh', status: 'active', involved: [niamh], note: 'bring wine' },
        ]);
    });

    it('keeps the facts a shortened answer left out ("f1, f2, ..., f40"), but lets a few go', () => {
        const many = { ...previous, facts: Array.from({ length: 8 }, (_, i) => ({ ...previous.facts[0], id: `f${i + 1}`, text: `Fact ${i + 1}.` })) };
        const elided = parseCompileOutput([{ id: 'f1', text: 'Fact 1.' }, { id: 'f2', text: 'Fact 2.' }, { id: 'f9', text: 'New.' }], [], { ...options, previous: many });
        expect(elided.facts.map((f) => f.id)).toEqual(['f1', 'f2', 'f9', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8']);
        const fewGone = parseCompileOutput(many.facts.slice(0, 5).map((f) => ({ id: f.id, text: f.text })), [], { ...options, previous: many });
        expect(fewGone.facts.map((f) => f.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
        // A short list is the model's to change.
        expect(parseCompileOutput([{ id: 'f9', text: 'New.' }], [], options).facts.map((f) => f.id)).toEqual(['f9']);
    });

    it('takes a relationship type without the context line the model copied into it', () => {
        expect(relationshipType('mentor · wary (-1) · high intensity · cooling: Disputes her visions')).toBe('mentor');
        expect(relationshipType(' Traveling Companion · friendly (2)')).toBe('traveling companion');
        expect(relationshipType('rival: old grudge')).toBe('rival');
        expect(relationshipType('friend')).toBe('friend');
        expect(relationshipType('· odd')).toBe('· odd');
    });

    it('asks extraction for a plan as one memory with its steps in order', () => {
        for (const mode of ['live', 'catch-up']) {
            const instructions = memoryVariableDef(mode).prompted.instructions;
            expect(instructions).toContain('record it as ONE memory of subtype "plan"');
            expect(instructions).toMatch(/subtype": one of [^;]*plan/);
        }
    });

    it('keeps a thread the user wrote as written, taking only how far it got from an answer', () => {
        const added = addCompiledThread(previous, { title: 'Supplies', steps: '[pending] Salvage old books from the library\nWin over Niamh\nTrade with Graxx', goal: 'Get supplies' });
        const [mine] = added.threads;
        expect(mine).toMatchObject({ id: 't2', added_by: 'user', kind: 'quest', status: 'active', goal: 'Get supplies' });
        expect(addCompiledThread(previous, { title: '  ' })).toBeNull();
        const moved = keepAuthored(mine, { ...mine, title: 'Other', goal: 'x', status: 'resolved', progress: 'Done.', steps: [{ text: 'Niamh agreed', status: 'done' }, { text: 'books found', status: 'done' }], sources: ['m_a'] });
        expect(moved).toMatchObject({ title: 'Supplies', goal: 'Get supplies', status: 'resolved', progress: 'Done.', sources: ['m_a'] });
        expect(moved.steps.map((st) => [st.text, st.status])).toEqual([['Salvage old books from the library', 'done'], ['Win over Niamh', 'done'], ['Trade with Graxx', 'pending']]);
    });

    it('skips placeholders a model writes for items it keeps as they are', () => {
        expect(['... (remains the same)', '(unchanged)', 'Unchanged.', '…', 'Same as before'].every(isPlaceholder)).toBe(true);
        expect(['Remus remains the same man.', 'The gate is unchanged since the war.', 'Lucian works at the gym.'].some(isPlaceholder)).toBe(false);
        const next = parseCompileOutput([{ id: 'f1', text: 'Lucian works at the gym.' }, { id: 'f1', text: '... (remains the same)' }], [], options);
        expect(next.facts.map((f) => f.text)).toEqual(['Lucian works at the gym.']);
        expect(parseThreads([{ id: 't1', title: '(unchanged)', text: '...' }], options)).toEqual(previous.threads);
    });

    it('reads tension levels 0..5 and averages them', () => {
        expect([3, '4', '4/5', 4.6, 9, -2, 'high', null].map(normalizeTensionLevel)).toEqual([3, 4, 4, 5, 5, 0, null, null]);
        expect(tensionOverall({ threat: 4, uncertainty: 2, emotional: 3 })).toBe(3);
        expect(tensionOverall({ threat: 5, uncertainty: 1, emotional: 1 })).toBe(2.3);
    });

    it('adds a tension reading per batch, at its newest message, replacing one at the same message', () => {
        const first = parseTension([{ threat: '4', uncertainty: 2, emotional: 3, reason: ' Graxx is ruthless. ' }], [], batch);
        expect(first).toEqual([{ at: 13, memory_id: 'm_b', threat: 4, uncertainty: 2, emotional: 3, overall: 3, reason: 'Graxx is ruthless.' }]);
        const again = parseTension([{ threat: 1, uncertainty: 1, emotional: 1 }], first, batch);
        expect(again).toEqual([{ at: 13, memory_id: 'm_b', threat: 1, uncertainty: 1, emotional: 1, overall: 1, reason: '' }]);
        const later = parseTension([{ threat: 5, uncertainty: 5, emotional: 2 }], first, [rec('m_c', { at: 20 })]);
        expect(later.map((t) => [t.at, t.overall])).toEqual([[13, 3], [20, 4]]);
        // An answer missing a level, or none at all, adds nothing.
        expect(parseTension([{ threat: 3, uncertainty: 2 }], first, batch)).toBe(first);
        expect(parseTension([], first, batch)).toBe(first);
        expect(parseTension(undefined, undefined, batch)).toEqual([]);

        expect(compileContext({ ...previous, tension: [] }, batch)).toContain('Story tension so far: (none yet)');
        expect(compileContext({ ...previous, tension: later }, batch)).toContain([
            'Story tension so far (latest readings, oldest first):',
            '- at message #13: threat 4, uncertainty 2, emotional 3 (overall 3) - Graxx is ruthless.',
            '- at message #20: threat 5, uncertainty 5, emotional 2 (overall 4)',
        ].join('\n'));
    });

    it('lays the tension readings out as a graph', () => {
        expect(tensionChart([])).toBeNull();
        const chart = tensionChart([
            { message_index: 30, threat: 5, uncertainty: 5, emotional: 5, overall: 5 },
            { message_index: 10, threat: 0, uncertainty: 0, emotional: 0, overall: 0 },
            { message_index: 20, threat: 3, uncertainty: 0, emotional: 0, overall: 1 },
        ], { width: 100, height: 50, max: 5 });
        expect(chart.lines.overall).toBe('0,50 50,40 100,0');
        expect(chart.lines.threat).toBe('0,50 50,20 100,0');
        expect([chart.from, chart.to]).toEqual([10, 30]);
        expect(tensionChart([{ overall: 2 }, { message_index: 4, overall: 4 }], { width: 100, height: 50 })).toMatchObject({ lines: { overall: '0,30 100,10' }, from: null, to: null });
        expect(tensionChart([{ message_index: 4, overall: 4 }], { width: 100, height: 50 }).lines.overall).toBe('50,10');
    });

    it('parses world entries by kind, with who knows a secret', () => {
        const worldResolve = (name) => (name === 'Maple Heights Gym' ? { id: 'loc_gym', name, type: 'location' } : resolve(name));
        const world = parseWorld([
            { id: 'w1', kind: 'secret', name: 'The debt', text: 'Lucian owes money to a loan shark.', known_by: ['Lucian', 'Gavin'], sources: ['m1'] },
            { kind: 'Place', name: 'Maple Heights Gym', text: 'Where Lucian works.', involved: 'Lucian' },
            { kind: 'world event', name: 'Understaffing', text: 'The gym is short of staff.', status: 'Ongoing' },
        ], { ...options, resolve: worldResolve });
        expect(world.map((w) => [w.id, w.kind])).toEqual([['w1', 'secret'], ['w2', 'location'], ['w3', 'event']]);
        expect(world[0]).toMatchObject({ entity: null, known_by: [{ id: 'chr_lucian' }, { id: null, name: 'Gavin' }], sources: ['m_old', 'm_a'] });
        expect(world[1]).toMatchObject({ entity: { id: 'loc_gym', type: 'location' }, involved: [{ id: 'chr_lucian' }] });
        expect(world[2].status).toBe('ongoing');
        expect(world[0].status).toBe('kept');
    });

    it('keeps what an answer leaves out of a list - a relationship, a character, a thread, a secret', () => {
        const mira = { from: 'Mira', to: 'Lucian', type: 'student' };
        const relationships = parseCompileOutput([{ id: 'f1', text: 'kept' }], [mira], options).relationships;
        expect(relationships.map((r) => `${r.from.name}>${r.to.name}`)).toEqual(['Mira>Lucian', 'Lucian>Mira']);
        expect(parseCharacters([{ name: 'Mira', traits: ['bold'] }], options).map((c) => c.entity.name)).toEqual(['Mira', 'Lucian']);
        expect(parseThreads([{ title: 'New lead', text: 'x' }], options).map((t) => t.id)).toEqual(['t2', 't1']);
        expect(parseWorld([{ kind: 'location', name: 'The gym', text: 'x' }], options).map((w) => [w.id, w.name])).toEqual([['w2', 'The gym'], ['w1', 'The debt']]);
    });

    it('continues a thread or world entry the answer gave a new id, by its words', () => {
        const threads = parseThreads([{ id: 't7', title: 'the gym job', text: 'Lucian took the job.', status: 'resolved' }], options);
        expect(threads.map((t) => [t.id, t.status])).toEqual([['t1', 'resolved']]);
        const world = parseWorld([{ kind: 'secret', name: 'Debt, the', text: 'Lucian owes more.' }], options);
        expect(world.map((w) => [w.id, w.text])).toEqual([['w1', 'Lucian owes more.']]);
    });

    it('takes an item that reuses an id for something else as new, keeping the current one', () => {
        const threads = parseThreads([
            { id: 't1', kind: 'quest', title: 'Navigating Elyon\'s Return', text: 'x' },
            { id: 't2', title: 'Another', text: 'y' },
        ], options);
        expect(threads.map((t) => [t.id, t.title])).toEqual([['t2', 'Navigating Elyon\'s Return'], ['t3', 'Another'], ['t1', 'The gym job']]);
        // Same subject, other words: continued.
        expect(parseThreads([{ id: 't1', title: 'Running the gym', text: 'z', status: 'active' }], options).map((t) => [t.id, t.title, t.status]))
            .toEqual([['t1', 'Running the gym', 'active']]);
        const world = parseWorld([{ id: 'w1', kind: 'location', name: 'The Liston Library', text: 'Decrepit.' }], options);
        expect(world.map((w) => [w.id, w.name])).toEqual([['w2', 'The Liston Library'], ['w1', 'The debt']]);
    });

    it('merges copies of a thread into the oldest one, with the newest status, progress and steps', () => {
        const plan = (id, title, sources, extra = {}) => ({
            id, kind: 'quest', title, text: 'x', status: 'open', progress: '', entity: null, involved: [], sources,
            goal: 'Maintain balance in the Enclave',
            steps: [{ text: 'Discuss concerns with High Seer Maren', status: 'pending', involved: [], note: '' }, { text: 'Consider ways to adapt to new dynamic', status: 'pending', involved: [], note: '' }],
            ...extra,
        });
        const copies = {
            ...previous,
            threads: [
                previous.threads[0],
                plan('t2', 'Balancing the Enclave after Remus\' Departure', ['m_2']),
                plan('t3', 'Balancing the Enclave after Remus\' Departure', ['m_3']),
                plan('t4', 'Understanding Remus\' Departure Implications', ['m_4']),
                plan('t5', 'Remus\' Departure Ceremony', ['m_5'], { goal: 'Hold the farewell rite', steps: [{ text: 'Gather the seers at dawn', status: 'pending', involved: [], note: '' }] }),
                plan('t7', 'Understand Remus\' Departure', ['m_7']),
            ],
        };
        const threads = parseThreads([{
            id: 't7', kind: 'quest', title: 'Understand Remus\' Departure', text: 'y', status: 'active', progress: 'Spoke with Maren.', sources: ['m1'],
            steps: [{ text: 'Discuss concerns with High Seer Maren', status: 'done' }, 'Consider ways to adapt to new dynamic'],
        }], { ...options, previous: copies });
        expect(threads.map((t) => [t.id, t.title])).toEqual([['t2', 'Understand Remus\' Departure'], ['t1', 'The gym job'], ['t5', 'Remus\' Departure Ceremony']]);
        expect(threads[0]).toMatchObject({ status: 'active', progress: 'Spoke with Maren.', goal: 'Maintain balance in the Enclave', sources: ['m_2', 'm_3', 'm_4', 'm_7', 'm_a'] });
        expect(threads[0].steps.map((s) => s.status)).toEqual(['done', 'pending']);
        // Copies the answer leaves out collapse too; distinct threads stay.
        expect(parseThreads([], { ...options, previous: copies }).map((t) => t.id)).toEqual(['t1', 't2', 't5']);
        expect(parseThreads([{ title: 'The gym job', text: 'a' }, { title: 'Gym job dues', text: 'b' }], options).map((t) => t.id)).toEqual(['t1', 't2']);
    });

    it('reads "known only to" as a secret still kept', () => {
        expect(['known only to Varyn', 'hidden', 'not yet revealed', 'known', 'revealed'].map(normalizeSecretStatus)).toEqual(['kept', 'kept', 'kept', 'revealed', 'revealed']);
    });

    it('lets the user edit and delete what the compiler wrote; a deleted item stays out', () => {
        const edited = editCompiledItem(previous, 'thread', 't1', { title: 'The manager job', status: 'Done', ignored: 'x' });
        expect(edited.threads[0]).toMatchObject({ title: 'The manager job', status: 'resolved', text: 'Lucian could manage the gym.' });
        expect(edited.threads[0].edited_at).toBeTruthy();
        expect(edited.threads[0].ignored).toBeUndefined();
        const relKeyOf = compiledItemKey('relationship', previous.relationships[0]);
        expect(editCompiledItem(previous, 'relationship', relKeyOf, { polarity: '-2', text: 'Cold now.' }).relationships[0]).toMatchObject({ polarity: -2, text: 'Cold now.' });
        expect(editCompiledItem(previous, 'character', 'chr_lucian', { traits: 'calm, kind', summary: 'Settled.' }).characters[0]).toMatchObject({ traits: ['calm', 'kind'], summary: 'Settled.' });
        expect(editCompiledItem(previous, 'world', 'w1', { known_by: 'Lucian, Gavin', status: 'known only to them' }).world[0]).toMatchObject({
            known_by: [{ id: 'chr_lucian', name: 'Lucian' }, { id: null, name: 'Gavin' }], status: 'kept',
        });
        expect(editCompiledItem(previous, 'thread', 't9', { title: 'x' })).toBeNull();
        expect(editCompiledSummary(previous, 'scene', ' At the gym. ').summary.scene).toBe('At the gym.');

        const removed = removeCompiledItem(previous, 'thread', 't1');
        expect(removed.threads).toEqual([]);
        expect(removed.dismissed).toEqual([{ kind: 'thread', key: dismissKey('thread', previous.threads[0]), label: 'quest seed: The gym job' }]);
        // The model brings it back (new id, other spelling): left out.
        expect(parseThreads([{ id: 't5', title: 'The Gym Job', text: 'again' }, { title: 'Other', text: 'y' }], { ...options, previous: removed }).map((t) => t.title)).toEqual(['Other']);
        expect(worldContext(removed, [], () => null)).toContain('Removed by the user - do not add these again:\n- quest seed: The gym job');
        const noFact = removeCompiledItem(previous, 'fact', 'f1');
        expect(parseCompileOutput([{ text: 'Lucian works at the gym.' }, { text: 'new' }], [], { ...options, previous: noFact }).facts.map((f) => f.text)).toEqual(['new']);
    });

    it('keeps a secret that no longer holds, with its status', () => {
        const world = parseWorld([
            { id: 'w1', kind: 'secret', name: 'The debt', text: 'Turned out Lucian never owed anything.', status: 'Disproven' },
            { kind: 'secret', name: 'The affair', text: 'Everyone knows now.', status: 'exposed' },
            { kind: 'secret', name: 'The key', text: 'Hidden under the floor.', status: 'whatever' },
        ], options);
        expect(world.map((w) => [w.name, w.status])).toEqual([['The debt', 'disproven'], ['The affair', 'revealed'], ['The key', 'kept']]);
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
        expect(next.facts[0]).toMatchObject({ theme: 'employment', sources: ['m_old', 'm_a'], entities: [{ id: 'chr_lucian', name: 'Lucian', type: 'character' }] });
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
        rec('m3', {
            at: 5, chat_id: 'Chat A', source_message_id: 'Chat A#5@2026-10-11T09:30:00.000Z', subtype: 'event', text: 'It rained',
            importance: 'high', tags: ['contextual'], tone: 'gloomy', witness_ids: ['chr_lucian'],
        }),
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
    const view = buildCompiledView(compiled, records, (id) => (id === 'chr_lucian' ? 'Lucian' : null));

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
        expect(view.timeline.map((t) => [t.text, t.message_index])).toEqual([['Lucian arrived', 3], ['It rained', 5]]);
    });

    it('marks major events, who witnessed them, their tone and when the message was written', () => {
        expect(view.timeline[0]).toMatchObject({ major: false, witnesses: [], message_date: 'd3' });
        expect(view.timeline[1]).toMatchObject({
            major: true, witnesses: [{ id: 'chr_lucian', name: 'Lucian' }], tone: 'gloomy', tags: ['contextual'], message_date: '2026-10-11T09:30:00.000Z',
        });
        expect(view.recent_tone).toEqual([{ tone: 'gloomy', count: 1 }]);
    });

    it('flags a state compiled before the world compiler as outdated', () => {
        expect(view.outdated).toBe(true);
        expect(buildCompiledView({ ...compiled, schema: 2 }, records).outdated).toBe(false);
    });

    it('counts memories not compiled in yet', () => {
        expect(buildCompiledView(compiled, [...records, rec('new')]).pending).toBe(1);
    });
});

describe('the compiled view: insights, relationship map, threads, world', () => {
    const records = [rec('m1', { at: 1 }), rec('m2', { at: 2 })];
    const lucian = { id: 'chr_lucian', name: 'Lucian', type: 'character' };
    const mira = { id: null, name: 'Mira', type: null };
    const compiled = {
        ...EMPTY_COMPILED,
        compiledAt: 'now',
        included: ['m1', 'm2'],
        relationships: [
            { from: lucian, to: mira, type: 'mentor', polarity: 2, intensity: 'high', trend: 'warming', text: 't', sources: ['m1'] },
            { from: mira, to: lucian, type: 'student', polarity: -1, intensity: 'low', trend: '', text: 't', sources: ['m2'] },
        ],
        characters: [{ entity: lucian, traits: ['kind'], habits: [], stressors: [], motivations: ['save the gym'], arc: 'growing', emotional_state: 'hopeful', sources: ['m1'] }],
        threads: [
            { id: 't1', kind: 'plot hook', title: 'Window', text: 'x', status: 'resolved', progress: '', entity: null, involved: [], sources: ['m1'] },
            { id: 't2', kind: 'quest', title: 'Gym job', text: 'x', status: 'active', progress: 'asked', entity: { id: 'qst_gym', name: 'Gym job', type: 'quest' }, involved: [lucian], sources: ['m2'] },
        ],
        world: [
            { id: 'w1', kind: 'secret', name: 'Debt', text: 'x', entity: null, known_by: [lucian], involved: [], status: '', sources: ['m1'] },
            { id: 'w2', kind: 'location', name: 'Gym', text: 'x', entity: { id: 'loc_gym', name: 'Gym', type: 'location' }, known_by: [], involved: [lucian], status: '', sources: ['m2'] },
        ],
    };
    const view = buildCompiledView(compiled, records);

    it('puts character insights and relationships into the profile', () => {
        const profile = view.character_profiles.find((p) => p.name === 'Lucian');
        expect(profile).toMatchObject({ entity_id: 'chr_lucian', entity_type: 'character', traits: ['kind'], motivations: ['save the gym'], arc: 'growing', emotional_state: 'hopeful' });
        expect(profile.relationships.map((r) => [r.direction, r.other.name, r.type, r.polarity_label])).toEqual([['out', 'Mira', 'mentor', 'close'], ['in', 'Mira', 'student', 'wary']]);
    });

    it('maps relationship polarity between every pair', () => {
        expect(view.relationship_map.entities.map((e) => e.name)).toEqual(['Lucian', 'Mira']);
        expect(view.relationship_map.cells.map((c) => [c.from.name, c.to.name, c.polarity, c.intensity])).toEqual([['Lucian', 'Mira', 2, 'high'], ['Mira', 'Lucian', -1, 'low']]);
    });

    it('lists threads by status, quests apart, and the world by kind', () => {
        expect(view.threads.map((t) => t.id)).toEqual(['t2', 't1']);
        expect(view.quests.map((t) => t.id)).toEqual(['t2']);
        expect(view.world.secret.map((w) => w.id)).toEqual(['w1']);
        expect(view.world.location[0]).toMatchObject({ id: 'w2', message_range: { from: 2, to: 2 } });
        expect(view.world.faction).toEqual([]);
    });

    it('builds a dossier linking an object to all of it', () => {
        const dossier = buildDossier(view, [rec('m1', { entity_ids: ['chr_lucian'] }), rec('m2', { witness_ids: ['chr_lucian'] })], lucian);
        expect(dossier.profile.name).toBe('Lucian');
        expect(dossier.relationships.map((r) => r.direction)).toEqual(['out', 'in']);
        expect(dossier.threads.map((t) => t.id)).toEqual(['t2']);
        expect(dossier.quests.map((t) => t.id)).toEqual(['t2']);
        expect(dossier.secrets_known.map((w) => w.id)).toEqual(['w1']);
        expect(dossier.world.map((w) => w.id)).toEqual(['w1', 'w2']);
        expect(dossier.memories.map((r) => r.id)).toEqual(['m1']);
        expect(dossier.witnessed.map((r) => r.id)).toEqual(['m2']);

        const quest = buildDossier(view, records, { id: 'qst_gym', name: 'Gym job', type: 'quest' });
        expect(quest.threads[0]).toMatchObject({ status: 'active', progress: 'asked' });
        expect(buildDossier(null, [], mira)).toMatchObject({ profile: null, relationships: [], memories: [] });
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
    const memoryRuns = () => fake.calls.filter((c) => c.name === 'runIndependentPreset' && c.args[1].name === COMPILER_PRESET);
    const factsAnswer = (context) => {
        const refs = [...context.matchAll(/\[(m\d+)\]/g)].map((m) => m[1]);
        const known = [...context.matchAll(/\[(f\d+)\] \w+ · [^·:]+(?: · about [^:]+)?: (.+)/g)].map((m) => ({ id: m[1], text: m[2] }));
        return {
            archivist__compiled_facts: [
                ...known.map((f) => ({ ...f, classification: 'PERMANENT', theme: 'employment', entities: ['Lucian'], sources: [] })),
                ...refs.map((ref, i) => ({ id: `f${known.length + i + 1}`, text: `compiled ${ref}`, classification: 'SESSION', theme: 'activity', entities: ['Lucian'], sources: [ref] })),
            ],
            archivist__compiled_relationships: [{ from: 'Lucian', to: 'Mira', type: 'trains', polarity: 1, text: 'Lucian trains Mira.', sources: refs.slice(0, 1) }],
            archivist__compiled_characters: [{ name: 'Lucian', traits: ['steady'], sources: refs.slice(0, 1) }],
            archivist__compiled_threads: [{ id: 't1', kind: 'quest seed', title: 'Promotion', text: 'Lucian might be promoted.', status: 'open', involved: ['Lucian'], sources: refs.slice(0, 1) }],
            archivist__compiled_world: [{ id: 'w1', kind: 'location', name: 'The gym', text: 'Where Lucian works.', sources: refs.slice(0, 1) }],
            archivist__compiled_story_summary: refs.length ? `Lucian worked through ${refs.length} memories.` : '',
            archivist__compiled_scene_summary: '',
            archivist__compiled_tension: refs.length ? [{ threat: 2, uncertainty: 3, emotional: 4, reason: 'Lucian is stretched thin.' }] : [],
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

    it('creates its two independent presets with their record lists, and runs them on its own connection', async () => {
        await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const preset = fake.presets.get(`archivist.${COMPILER_PRESET}`);
        expect(preset.independentPreset).toBe(true);
        expect(preset.independentConfig.promptedHeader).toBe(COMPILER_HEADER);
        expect([...preset.variables.keys()]).toEqual([
            'archivist__compiled_facts', 'archivist__compiled_relationships', 'archivist__compiled_characters', 'archivist__compiled_story_summary', 'archivist__compiled_scene_summary',
            'archivist__compiled_tension',
        ]);
        expect(preset.variables.get('archivist__compiled_story_summary')).toMatchObject({ type: 'string', prompted: { newEachTurn: true } });
        expect(preset.variables.get('archivist__compiled_facts').prompted.newEachTurn).toBe(true);
        const world = fake.presets.get(`archivist.${WORLD_COMPILER_PRESET}`);
        expect(world.independentConfig.promptedHeader).toBe(WORLD_COMPILER_HEADER);
        expect([...world.variables.keys()]).toEqual(['archivist__compiled_threads', 'archivist__compiled_world']);
        for (const name of [COMPILER_PRESET, WORLD_COMPILER_PRESET]) {
            expect(fake.calls.filter((c) => c.name === 'configureIndependentPreset' && c.args[1] === name).at(-1).args[2]).toMatchObject({ connectionProfileId: 'big', maxTokens: 4000, temperature: 0.3, enabled: true });
        }
    });

    it('skips the world part when it is switched off', async () => {
        getSettings().compileWorld = false;
        await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        expect(fake.calls.filter((c) => c.name === 'runIndependentPreset').map((c) => c.args[1].name)).toEqual([COMPILER_PRESET]);
        expect((await getCompiledMemory()).threads).toEqual([]);
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
        expect(view.relationships[0]).toMatchObject({ type: 'trains', polarity: 1, polarity_label: 'friendly', color_tag: 'Purple', from: { id: 'chr_lucian', type: 'character' } });
        expect(view.character_profiles.find((p) => p.name === 'Lucian')).toMatchObject({ traits: ['steady'] });
        expect(view.threads[0]).toMatchObject({ title: 'Promotion', status: 'open', involved: [{ id: 'chr_lucian' }] });
        expect(view.world.location[0]).toMatchObject({ name: 'The gym' });
        expect(view.outdated).toBe(false);
        expect(view.story_summary).toBe('Lucian worked through 1 memories.');
        expect(view.scene_summary).toBe('');
        expect(fake.readValue('Chat A', 'archivist__compiled_story_summary')).toBe('');
        expect(fake.readValue('Chat A', 'archivist__compiled_world')).toEqual([]);
        expect(view.timeline).toHaveLength(1);
        expect(view.tension).toEqual([{ message_index: 1, threat: 2, uncertainty: 3, emotional: 4, overall: 3, reason: 'Lucian is stretched thin.' }]);
        expect(view.tension_now).toEqual(view.tension[0]);
        expect(fake.readValue('Chat A', 'archivist__compiled_tension')).toEqual([]);
        expect(await getCompiledMemory('Chat A')).toEqual(view);
    });

    it('answers dossier and relationship lookups by object id or name', async () => {
        await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1', entity_ids: ['chr_lucian'] }]);
        await compileOpenChat();
        const dossier = await getEntityDossier('chr_lucian');
        expect(dossier.entity).toMatchObject({ id: 'chr_lucian', name: 'Lucian' });
        expect(dossier.memories).toHaveLength(1);
        expect(dossier.relationships[0]).toMatchObject({ direction: 'out', type: 'trains', other: { name: 'Mira' } });
        expect((await getEntityDossier('Lucian')).profile.traits).toEqual(['steady']);
        expect(await getRelationship('Lucian', 'Mira')).toMatchObject({ forward: { type: 'trains' }, backward: null });
    });

    it('is incremental: a later run sends only the new memories, with the current facts', async () => {
        await store([{ text: 'first', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        await store([{ text: 'second', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const context = memoryRuns().at(-1).args[2];
        expect(context).toContain('[f1] SESSION · activity · about Lucian: compiled m1');
        expect(context).toContain('[m1] (fact, session, medium, message #1): second');
        expect(context).not.toContain(': first');
    });

    it('does nothing when there is nothing new, unless rebuilding', async () => {
        await store([{ text: 'one', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        const runs = () => memoryRuns().length;
        await compileOpenChat();
        expect(getCompilerStatus().outcome).toBe('nothing');
        expect(runs()).toBe(1);
        await compileOpenChat({ rebuild: true });
        expect(runs()).toBe(2);
        expect(memoryRuns().at(-1).args[2]).toContain(': one');
    });

    it('feeds a large backlog in batches', async () => {
        await store(Array.from({ length: COMPILE_BATCH + 5 }, (_, i) => ({ text: `memory ${i}`, source_message_id: 'Chat A#1@d1' })));
        await compileOpenChat();
        expect(memoryRuns()).toHaveLength(2);
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
        const before = memoryRuns().length;
        await compileOpenChat();
        expect(getCompilerStatus()).toMatchObject({ outcome: 'failed', error: 'model down' });
        // Never retried on its own.
        expect(memoryRuns().length - before).toBe(1);
        expect((await getCompiledMemory()).session_details.map((f) => f.text)).toEqual(['compiled m1']);
        expect((await getCompiledMemory()).pending).toBe(1);
    });

    it('offers a retry when a compile stops, once, and resumes on a click', async () => {
        const toastr = { warning: vi.fn(() => ({ id: 'toast' })), info: vi.fn(), clear: vi.fn() };
        globalThis.toastr = toastr;
        const stop = onCompilerStatus(onCompileStatus);
        try {
            await store(Array.from({ length: COMPILE_BATCH + 1 }, (_, i) => ({ text: `memory ${i}`, source_message_id: 'Chat A#1@d1' })));
            let calls = 0;
            fake.respond = async (context) => {
                calls++;
                // The second batch's memory part (each batch runs memory, then world).
                if (calls === 3) throw new Error('the answer was not valid JSON');
                return factsAnswer(context);
            };
            await compileOpenChat({ rebuild: true });
            expect(getCompilerStatus()).toMatchObject({ outcome: 'failed', error: 'the answer was not valid JSON' });
            expect(toastr.warning).toHaveBeenCalledTimes(1);
            const [message, title, options] = toastr.warning.mock.calls[0];
            expect(message).toBe('The compiler stopped: the answer was not valid JSON. What it finished is saved. Click here to try again.');
            expect(title).toBe('Archivist');
            expect(options).toMatchObject({ timeOut: 0, closeButton: true, escapeHtml: true });
            expect((await getCompiledMemory()).pending).toBe(1);

            // The click: a plain compile of what is left, not a rebuild.
            await options.onclick();
            expect(toastr.clear).toHaveBeenCalled();
            expect(getCompilerStatus()).toMatchObject({ outcome: 'compiled', reason: 'retry', rebuild: false });
            expect((await getCompiledMemory()).pending).toBe(0);
            expect(toastr.warning).toHaveBeenCalledTimes(1);
        } finally {
            stop();
        }
    });

    it('sends a retry for another chat back to that chat', async () => {
        globalThis.toastr = { info: vi.fn(), clear: vi.fn() };
        expect(await retryCompile({ chatKey: 'elsewhere', chatId: 'Chat B' })).toBe(false);
        expect(toastr.info).toHaveBeenCalledWith('Open "Chat B" and compile it from the Archivist drawer to try again.', 'Archivist');
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

        const runs = () => memoryRuns().length;
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
