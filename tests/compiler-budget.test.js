// The compiler with small-context models: an answer cut off by the token
// limit keeps its complete items (salvage.js), facts come back as changes
// (compile-plan.js applyFactsDelta), and each prompt is fitted into the
// model's context (budget.js) - and a compile run through all three against
// the State Engine stand-in.

import { getContext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { salvageJsonObject, salvageAnswer, answerKey } from '../src/compiler/salvage.js';
import { applyFactsDelta, parseCompileOutput, compileContext, refsFor, EMPTY_COMPILED } from '../src/compiler/compile-plan.js';
import {
    contextTokens, answerTokens, contextBudgetChars, presetOverheadChars, estimateTokens, batchFocus, bearsOn, fitPart, planBatch, MEMORY_LISTS,
    DEFAULT_CONTEXT_TOKENS, CHARS_PER_TOKEN, STATE_ENGINE_RULES_CHARS,
} from '../src/compiler/budget.js';
import { compileOpenChat, getCompiledMemory, getCompilerStatus, COMPILER_PRESET, COMPILE_BATCH } from '../src/compiler/compiler.js';
import { compilerLine } from '../src/ui/drawer-model.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const resolve = (name) => (name === 'Lucian' ? { id: 'chr_lucian', name, type: 'character' } : { id: null, name, type: null });
const fact = (id, text, extra = {}) => ({ id, text, classification: 'SESSION', theme: 'general', entities: [], sources: [`m_${id}`], contradicts: [], ...extra });

describe('saving a cut-off answer', () => {
    const complete = { id: 'new', text: 'Lucian is saving for a car.', entities: ['Lucian'], sources: ['m1'] };

    it('keeps the complete items of a list cut off mid-item', () => {
        const raw = `{"ar__compiled_facts": [${JSON.stringify(complete)}, {"id": "f1", "remove": true}, {"id": "f2", "text": "Lucian quit the gy`;
        const read = salvageJsonObject(raw);
        expect(read.complete).toBe(false);
        expect(read.values.get('ar__compiled_facts')).toEqual([complete, { id: 'f1', remove: true }]);
    });

    it('keeps the lists and strings before the cut, and leaves out a string cut short', () => {
        const raw = `\`\`\`json\n{"ar__compiled_facts": [${JSON.stringify(complete)}], "ar__compiled_relationships": [], "ar__compiled_story_summary": "Lucian worked", "ar__compiled_scene_summary": "Lucian is at the gy`;
        const salvaged = salvageAnswer(raw, ['compiled_facts', 'compiled_relationships', 'compiled_story_summary', 'compiled_scene_summary', 'compiled_tension']);
        expect(salvaged.complete).toBe(false);
        expect(salvaged.answers).toEqual({ compiled_facts: [complete], compiled_relationships: [], compiled_story_summary: 'Lucian worked' });
    });

    it('stops at a key or a number that may be cut short', () => {
        expect(salvageJsonObject('{"a": [1, 2], "b": 3').values).toEqual(new Map([['a', [1, 2]]]));
        expect(salvageJsonObject('{"a": [1, 2], "ar__compi').values).toEqual(new Map([['a', [1, 2]]]));
        expect(salvageJsonObject('{"a": [{"x": 1}, {"x": 2}, {"x"').values.get('a')).toEqual([{ x: 1 }, { x: 2 }]);
    });

    it('reads a finished answer whole, with a stray comma put right, and nothing from no object', () => {
        const read = salvageJsonObject('Here: {"a": [{"x": 1,}, "b\\"c"], "n": 2, "t": true}');
        expect(read).toEqual({ values: new Map([['a', [{ x: 1 }, 'b"c']], ['n', 2], ['t', true]]), complete: true });
        expect(salvageJsonObject('no json here')).toBeNull();
        expect(salvageAnswer('{"other": []}', ['compiled_facts'])).toBeNull();
    });

    it('matches namespaced keys to variable names', () => {
        expect(['ar__compiled_facts', 'compiled_facts', ' Compiled_Facts '].map(answerKey)).toEqual(['compiled_facts', 'compiled_facts', 'compiled_facts']);
    });
});

describe('facts as changes', () => {
    const previous = {
        ...EMPTY_COMPILED,
        facts: [
            fact('f1', 'Lucian works at the gym.', { classification: 'PERMANENT', theme: 'employment', entities: [{ id: 'chr_lucian', name: 'Lucian' }] }),
            fact('f2', 'It is raining.', { classification: 'SCENE' }),
            fact('f4', 'Mira bakes bread.'),
        ],
    };
    const batch = [{ id: 'mem_a', text: 'Lucian is promoted.', scope: 'long_term' }, { id: 'mem_b', text: 'The rain stops.', scope: 'scene' }];
    const options = { previous, refs: refsFor(batch), recordsById: new Map(batch.map((r) => [r.id, r])), resolve };

    it('adds a new fact under the next free id, never reusing one', () => {
        const facts = applyFactsDelta([{ id: 'new', text: 'Lucian manages the gym.', entities: ['Lucian'], sources: ['m1'] }, { text: 'Mira sells bread.' }], options);
        expect(facts.map((f) => f.id)).toEqual(['f1', 'f2', 'f4', 'f5', 'f6']);
        expect(facts[3]).toMatchObject({ text: 'Lucian manages the gym.', classification: 'PERMANENT', theme: 'general', entities: [{ id: 'chr_lucian' }], sources: ['mem_a'] });
    });

    it('revises a fact by id, keeping its id, place and the fields the answer leaves out', () => {
        const facts = applyFactsDelta([{ id: '[f1]', text: 'Lucian manages the gym.', sources: ['m1'] }], options);
        expect(facts.map((f) => f.id)).toEqual(['f1', 'f2', 'f4']);
        expect(facts[0]).toMatchObject({ text: 'Lucian manages the gym.', classification: 'PERMANENT', theme: 'employment', entities: [{ id: 'chr_lucian' }], sources: ['m_f1', 'mem_a'] });
        expect(applyFactsDelta([{ id: 'f1', text: 'Lucian manages the gym.', classification: 'session', theme: 'Work', entities: [] }], options)[0])
            .toMatchObject({ classification: 'SESSION', theme: 'work', entities: [{ id: 'chr_lucian' }] });
    });

    it('takes a new fact with a current fact\'s words as a revision of it', () => {
        const facts = applyFactsDelta([{ id: 'new', text: 'it is raining', classification: 'SCENE', sources: ['m2'] }], options);
        expect(facts.map((f) => [f.id, f.text])).toEqual([['f1', 'Lucian works at the gym.'], ['f2', 'it is raining'], ['f4', 'Mira bakes bread.']]);
        expect(facts[1].sources).toEqual(['m_f2', 'mem_b']);
    });

    it('removes a fact by id, in each way a model says it', () => {
        expect(applyFactsDelta([{ id: 'f2', remove: true }], options).map((f) => f.id)).toEqual(['f1', 'f4']);
        expect(applyFactsDelta([{ remove: 'f2' }], options).map((f) => f.id)).toEqual(['f1', 'f4']);
        expect(applyFactsDelta([{ id: 'f2', op: 'Remove' }], options).map((f) => f.id)).toEqual(['f1', 'f4']);
        expect(applyFactsDelta([{ id: 'f2', removed: true, text: 'It stopped raining.' }], options).map((f) => f.id)).toEqual(['f1', 'f4']);
    });

    it('merges a fact into another: removed, its sources moved over', () => {
        const facts = applyFactsDelta([{ id: 'f4', merged_into: 'f1' }], options);
        expect(facts.map((f) => f.id)).toEqual(['f1', 'f2']);
        expect(facts[0].sources).toEqual(['m_f1', 'm_f4']);
        // Into an unknown fact: a plain removal.
        expect(applyFactsDelta([{ id: 'f4', merged_into: 'f99' }], options).map((f) => f.id)).toEqual(['f1', 'f2']);
    });

    it('ignores unknown ids: a removal of one does nothing, a revision of one is a new fact', () => {
        expect(applyFactsDelta([{ id: 'f99', remove: true }, { id: 'f3', remove: true }, { id: 'x', remove: true }], options)).toEqual(previous.facts);
        const facts = applyFactsDelta([{ id: 'f3', text: 'Kael arrives.' }], options);
        expect(facts.map((f) => [f.id, f.text]).at(-1)).toEqual(['f5', 'Kael arrives.']);
    });

    it('treats the ids the model was not shown as unknown', () => {
        const shownFactIds = new Set(['f1']);
        const facts = applyFactsDelta([{ id: 'f2', remove: true }, { id: 'f4', text: 'Something else.' }], { ...options, shownFactIds });
        expect(facts.map((f) => [f.id, f.text])).toEqual([['f1', 'Lucian works at the gym.'], ['f2', 'It is raining.'], ['f4', 'Mira bakes bread.'], ['f5', 'Something else.']]);
    });

    it('keeps contradictions between existing facts only', () => {
        const facts = applyFactsDelta([{ id: 'f1', text: 'Lucian left the gym.', contradicts: ['[f4]', 'f1', 'f9', 'f2'] }, { id: 'f2', remove: true }], options);
        expect(facts[0].contradicts).toEqual(['f4']);
    });

    it('is what parseCompileOutput applies, with the relationships beside it', () => {
        const next = parseCompileOutput([{ id: 'f2', remove: true }], [], options);
        expect(next).toEqual({ facts: [previous.facts[0], previous.facts[2]], relationships: [] });
    });
});

describe('fitting a compile into the model\'s context', () => {
    it('takes Archivist\'s context setting, else SillyTavern\'s, else 8192', () => {
        expect(contextTokens(4096, 16384)).toBe(4096);
        expect(contextTokens(0, 16384)).toBe(16384);
        expect(contextTokens('', undefined)).toBe(DEFAULT_CONTEXT_TOKENS);
        expect(contextTokens(-1, 'x')).toBe(8192);
    });

    it('keeps room for the answer, never more than half the context', () => {
        expect(answerTokens(3000, 8192)).toBe(3000);
        expect(answerTokens(6000, 8192)).toBe(4096);
        expect(answerTokens(undefined, 32768)).toBe(3000);
    });

    it('leaves the context what the answer, a margin and the preset\'s own text do not take', () => {
        expect(estimateTokens('x'.repeat(35))).toBe(10);
        const overhead = presetOverheadChars('header', ['abc', 'de']);
        expect(overhead).toBe(6 + STATE_ENGINE_RULES_CHARS + 3 + 2 + 2 * 160);
        // 8192 - 3000 for the answer - 410 (5%) margin.
        expect(contextBudgetChars({ context: 8192, answer: 3000, overheadChars: 1000 })).toBe(Math.floor(4782 * CHARS_PER_TOKEN) - 1000);
    });

    it('knows what a batch is about: its objects, their names, first names, words in its text', () => {
        const focus = batchFocus([{ text: 'Remus meets Mira at the Old Mill.', entity_ids: ['chr_kael'] }], (id) => (id === 'chr_kael' ? 'Kael' : null));
        expect(bearsOn({ id: 'chr_kael', name: 'Someone' }, focus)).toBe(true);
        expect(bearsOn({ id: null, name: 'Kael' }, focus)).toBe(true);
        expect(bearsOn({ id: 'chr_remus', name: 'Remus Watt' }, focus)).toBe(true);
        expect(bearsOn('the old mill', focus)).toBe(true);
        expect(bearsOn({ name: 'Mill' }, focus)).toBe(true);
        expect(bearsOn({ name: 'Mi' }, focus)).toBe(false);
        expect(bearsOn({ name: 'Elyon' }, focus)).toBe(false);
        // A whole word: "Ill" is not in "Mill".
        expect(bearsOn({ name: 'Ill' }, focus)).toBe(false);
    });

    const people = Array.from({ length: 30 }, (_, k) => ({ id: `chr_${k}`, name: `Person${k}` }));
    const big = {
        ...EMPTY_COMPILED,
        summary: { story: 'A long story.', scene: 'A tavern.', sceneAt: null },
        facts: Array.from({ length: 300 }, (_, i) => fact(`f${i + 1}`, `Person${i % 30} has a long and detailed fact number ${i + 1} about their life and doings.`, { entities: [people[i % 30]] })),
        relationships: people.slice(1).map((p) => ({ from: people[0], to: p, type: 'friend', polarity: 1, intensity: 'medium', trend: '', text: `${people[0].name} knows ${p.name}.`, sources: [] })),
        characters: people.map((p) => ({ entity: p, summary: `${p.name} is someone.`, traits: [], habits: [], stressors: [], motivations: [], arc: '', emotional_state: '', sources: [] })),
    };
    const memoryOf = (k, i) => ({ id: `mem_${i}`, text: `Person${k} does thing ${i}.`, entity_ids: [`chr_${k}`], subtype: 'event', scope: 'session', importance: 'medium' });
    const render = (view, batch, partial) => compileContext(view, batch, () => null, [], partial);
    const part = (budget) => ({ lists: MEMORY_LISTS, budget, render });

    it('shows everything when it fits', () => {
        const batch = [memoryOf(1, 1)];
        const fit = fitPart({ compiled: big, focus: batchFocus(batch), lists: MEMORY_LISTS, budget: 1e6, render: (view, partial) => render(view, batch, partial) });
        expect(fit.partial).toEqual({});
        expect(fit.context).toBe(render(big, batch, {}));
    });

    it('shows only what bears on the batch, saying so, when everything does not fit', () => {
        const batch = [memoryOf(1, 1)];
        const fit = fitPart({ compiled: big, focus: batchFocus(batch), lists: MEMORY_LISTS, budget: 6000, render: (view, partial) => render(view, batch, partial) });
        expect(fit.partial).toEqual({ facts: true, relationships: true, characters: true });
        expect([...fit.shown.facts]).toEqual(big.facts.filter((f) => f.entities[0].name === 'Person1').map((f) => f.id));
        expect(fit.context).toContain('Facts (only those bearing on the new memories are shown - the others are kept as they are):');
        expect(fit.context).toContain('Story so far: A long story.');
        expect(fit.context).toContain('- Person0 -> Person1: friend');
        expect(fit.context).not.toContain('Person2 has');
        expect(fit.context.length).toBeLessThanOrEqual(6000);
    });

    it('cuts to the nearest items that fit only when asked to, and never past the budget', () => {
        const batch = [memoryOf(1, 1)];
        const args = { compiled: big, focus: batchFocus(batch), lists: MEMORY_LISTS, budget: 1500, render: (view, partial) => render(view, batch, partial) };
        expect(fitPart(args)).toBeNull();
        const fit = fitPart({ ...args, cut: true });
        expect(fit.context.length).toBeLessThanOrEqual(1500);
        expect(fit.shown.facts.size).toBeGreaterThan(0);
        expect([...fit.shown.facts].every((id) => big.facts.find((f) => f.id === id).entities[0].name === 'Person1')).toBe(true);
        expect(fitPart({ ...args, budget: 50, cut: true })).toBeNull();
    });

    it('plans a full batch when it fits', () => {
        const pending = Array.from({ length: 30 }, (_, i) => memoryOf(i % 30, i));
        const plan = planBatch(pending, { compiled: EMPTY_COMPILED, parts: [part(1e6)], maxBatch: COMPILE_BATCH });
        expect(plan.batch).toHaveLength(COMPILE_BATCH);
        expect(plan.trimmed).toBe(false);
    });

    it('shrinks the batch, then what is shown, until it fits - and gives up only when one memory does not', () => {
        // Each memory touches another person, so a smaller batch bears on fewer facts.
        const pending = Array.from({ length: 30 }, (_, i) => memoryOf(i % 30, i));
        const budget = 9000;
        const plan = planBatch(pending, { compiled: big, parts: [part(budget)], maxBatch: COMPILE_BATCH });
        expect(plan.batch.length).toBeLessThan(COMPILE_BATCH);
        expect(plan.batch).toEqual(pending.slice(0, plan.batch.length));
        expect(plan.trimmed).toBe(true);
        expect(plan.parts[0].context.length).toBeLessThanOrEqual(budget);

        const tight = planBatch(pending, { compiled: big, parts: [part(900)], maxBatch: COMPILE_BATCH });
        expect(tight.batch.length).toBeLessThanOrEqual(5);
        expect(tight.parts[0].context.length).toBeLessThanOrEqual(900);

        expect(planBatch(pending, { compiled: big, parts: [part(100)], maxBatch: COMPILE_BATCH })).toBeNull();
    });

    it('needs every part to fit', () => {
        const pending = [memoryOf(1, 1)];
        expect(planBatch(pending, { compiled: big, parts: [part(1e6), part(100)], maxBatch: COMPILE_BATCH })).toBeNull();
    });

    it('plans the knowledge alone when nothing is pending', () => {
        expect(planBatch([], { compiled: EMPTY_COMPILED, parts: [part(1e6)], maxBatch: COMPILE_BATCH })).toMatchObject({ batch: [], trimmed: false });
    });
});

describe('compiling with a small-context model', () => {
    let fake;
    const store = (items) => addMemoryRecords(getCurrentChatRef(), items);
    const memoryRuns = () => fake.calls.filter((c) => c.name === 'runIndependentPreset' && c.args[1].name === COMPILER_PRESET);
    const isWorld = (context) => context.includes('Story threads');
    const worldAnswer = { ar__compiled_threads: [], ar__compiled_world: [] };

    beforeEach(async () => {
        fake = resetFakeStateEngine();
        fake.addObject('chr_lucian', 'character', 'Lucian');
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, { name: 'Lucian', mes: 'Lucian works.', send_date: 'd1' }];
        Object.assign(getSettings(), { enabled: true, compileAuto: false, compilerMaxTokens: 3000, compilerContextTokens: 8192 });
        await loadCurrentChat();
    });

    it('saves the complete facts of an answer cut off by the token limit, keeps the rest, and says so', async () => {
        fake.respond = async (context) => (isWorld(context) ? worldAnswer : { ar__compiled_facts: [{ id: 'new', text: 'Lucian works at the gym.', entities: ['Lucian'], sources: ['m1'] }] });
        await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();

        fake.respond = async (context) => {
            if (isWorld(context)) return worldAnswer;
            const error = new Error('response was not valid JSON');
            error.response = '{"ar__compiled_facts": [{"id": "new", "text": "Lucian is saving for a car.", "entities": ["Lucian"], "classification": "SESSION", "sources": ["m1"]}, {"id": "f1", "text": "Lucian quit the gy';
            throw error;
        };
        await store([{ text: 'Lucian saves money', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();

        const status = getCompilerStatus();
        expect(status).toMatchObject({ outcome: 'compiled', cutOff: 1 });
        const view = await getCompiledMemory();
        expect(view.session_details.map((f) => f.text)).toEqual(['Lucian works at the gym.', 'Lucian is saving for a car.']);
        expect(view.pending).toBe(0);
        expect(compilerLine(status, { at: view.compiled_at ?? new Date().toISOString(), pending: 0 }).text).toContain('One answer was cut off by the model\'s token limit - the complete items were saved.');
    });

    it('fails, saying why, when a cut-off answer has no complete item', async () => {
        fake.respond = async () => {
            const error = new Error('response was not valid JSON');
            error.response = '{"ar__compiled_facts": [{"id": "new", "text": "Lucian is sav';
            throw error;
        };
        await store([{ text: 'Lucian saves money', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        expect(getCompilerStatus()).toMatchObject({ outcome: 'failed', error: expect.stringContaining('cut off before its first complete item') });
    });

    it('keeps a large compiled store inside an 8k context, losing no fact', async () => {
        // A first compile leaves 300 facts about 30 people - far more than 8k tokens of them.
        fake.respond = async (context) => (isWorld(context) ? worldAnswer : {
            ar__compiled_facts: Array.from({ length: 300 }, (_, i) => ({ id: 'new', text: `Person${i % 30} has a long and detailed fact number ${i + 1} about their life and doings.`, entities: [`Person${i % 30}`] })),
        });
        await store([{ text: 'Everyone is introduced', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        expect((await getCompiledMemory()).session_details).toHaveLength(300);

        // Then 25 memories, about a few of them; each answer adds a fact per memory.
        fake.respond = async (context) => {
            if (isWorld(context)) return worldAnswer;
            const refs = [...context.matchAll(/^\[(m\d+)\]/gm)].map((m) => m[1]);
            return { ar__compiled_facts: refs.map((ref) => ({ id: 'new', text: `Compiled ${ref} of ${context.length}.`, sources: [ref] })) };
        };
        await store(Array.from({ length: 25 }, (_, i) => ({ text: `Person${i % 3} does thing ${i}.`, source_message_id: 'Chat A#1@d1' })));
        const before = memoryRuns().length;
        await compileOpenChat();

        expect(getCompilerStatus()).toMatchObject({ outcome: 'compiled', trimmed: true });
        const preset = fake.presets.get(`ar.${COMPILER_PRESET}`);
        const overhead = presetOverheadChars(preset.independentConfig.promptedHeader, [...preset.variables.values()].map((def) => def.prompted.instructions));
        for (const run of memoryRuns().slice(before)) {
            expect(estimateTokens('x'.repeat(overhead)) + estimateTokens(run.args[2]) + preset.independentConfig.maxTokens).toBeLessThanOrEqual(8192);
            expect(run.args[2]).toContain('only those bearing on the new memories are shown');
        }
        expect(preset.independentConfig.maxTokens).toBe(3000);
        const view = await getCompiledMemory();
        expect(view.session_details).toHaveLength(325);
        expect(view.pending).toBe(0);
    });

    it('stops with an error rather than overflow a context too small for one memory', async () => {
        getSettings().compilerContextTokens = 2000;
        fake.respond = async () => ({});
        await store([{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();
        expect(getCompilerStatus()).toMatchObject({ outcome: 'failed', error: expect.stringContaining('does not fit the compiler\'s context (2000 tokens') });
        expect(memoryRuns()).toHaveLength(0);
    });
});
