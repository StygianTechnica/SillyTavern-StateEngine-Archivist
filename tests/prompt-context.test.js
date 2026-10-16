// Archivist's knowledge as prompt text for Curator (src/context/): the
// blocks (prompt-context.js), the scene from the memories and the compiled
// summaries (compile-plan.js), and the runner writing them into State
// Engine variables (prompt-sync.js).

import { getContext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { buildPromptContext, threadLine, CONTEXT_BLOCKS, REFERENCE_MARKER } from '../src/context/prompt-context.js';
import { syncPromptContext, CONTEXT_CAPABILITIES } from '../src/context/prompt-sync.js';
import { recentSceneMemories, parseSummary } from '../src/compiler/compile-plan.js';
import { ensureLivePreset } from '../src/extraction/live.js';
import { compileOpenChat } from '../src/compiler/compiler.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const rec = (id, at, extra = {}) => ({ id, subtype: 'event', scope: 'scene', importance: 'medium', text: id, entity_ids: [], witness_ids: [], source_message_id: `C#${at}@d`, chat_id: 'C', created_at: 't', ...extra });

describe('the scene from the memories', () => {
    it('is the scene-scope memories of the newest messages, in order', () => {
        const records = [rec('old scene', 1), rec('session thing', 30, { scope: 'session' }), rec('arrived', 25), rec('door opened', 31), rec('long ago', 10)];
        expect(recentSceneMemories(records, 12).map((m) => m.text)).toEqual(['arrived', 'door opened']);
        expect(recentSceneMemories([])).toEqual([]);
    });
});

describe('the compiled summaries', () => {
    it('take a new answer, and keep the previous one for an empty answer', () => {
        expect(parseSummary(' Lucian left. ', '', { story: 'old', scene: 'At the gym.', sceneAt: 4 }, 9)).toEqual({ story: 'Lucian left.', scene: 'At the gym.', sceneAt: 4 });
        expect(parseSummary('', 'On the bus.', { story: 'old', scene: 'At the gym.', sceneAt: 4 }, 9)).toEqual({ story: 'old', scene: 'On the bus.', sceneAt: 9 });
        expect(parseSummary(undefined, undefined, undefined)).toEqual({ story: '', scene: '', sceneAt: null });
    });
});

describe('buildPromptContext', () => {
    const syr = { id: 'chr_s', name: 'Syrvanus Voxaris' };
    const gremlin = { id: 'chr_g', name: 'A lead gremlin' };
    const view = {
        story_summary: 'Syrvanus searched for Alvaryx.',
        scene_summary: 'Syrvanus talks with gremlins in the Chronicle Room.',
        scene_summary_at: 40,
        newest_message_index: 42,
        scene_state: [{ text: 'It is night.', message_range: { from: 39, to: 41 } }, { text: 'The first rain.', message_range: { from: 2, to: 3 } }],
        scene_recent: [{ text: 'The gremlins revealed themselves.' }],
        character_profiles: [
            { entity_id: 'chr_g', name: 'A lead gremlin', summary: 'An eager servant.', traits: ['cautious'], motivations: ['serve the Mnemos'], stressors: [], emotional_state: 'eager' },
            { entity_id: 'chr_z', name: 'Zeno', traits: ['cruel'], motivations: [], stressors: [], emotional_state: '' },
        ],
        relationships: [
            { from: syr, to: { id: null, name: 'gremlin (lead)' }, type: 'ally', polarity: 2, polarity_label: 'close', intensity: 'medium', trend: 'warming', text: 'He accepts their help.' },
            { from: { id: null, name: 'Zeno' }, to: syr, type: 'oppressor', polarity: -2, polarity_label: 'antagonistic', intensity: 'high', trend: '', text: '' },
        ],
        threads: [
            { title: 'Find Alvaryx', kind: 'quest', status: 'active', text: 'Alvaryx is missing.', progress: 'The gremlins offered to help.' },
            { title: 'Old feud', kind: 'plot hook', status: 'resolved', text: 'x', progress: '' },
        ],
        timeline: [{ text: 'Zeno collared Syrvanus.', witnesses: [{ name: 'Rydia' }] }],
        world: { secret: [
            { name: 'The collar', text: 'It is venomous.', status: 'kept', known_by: [{ name: 'Zeno' }] },
            { name: 'The gremlin plot', text: 'x', status: 'disproven', known_by: [] },
        ] },
    };
    const out = buildPromptContext(view, { present: [gremlin, syr], persona: syr });
    // Every block starts with the marker line; the rest is compared below.
    const body = (text) => text.replace(`${REFERENCE_MARKER}\n`, '');

    it('writes every block, focused on who is present', () => {
        expect(Object.keys(out)).toEqual(CONTEXT_BLOCKS.map(([name]) => name));
        expect(body(out.ctx_story_summary)).toBe('Story so far:\nSyrvanus searched for Alvaryx.');
        expect(body(out.ctx_scene)).toBe([
            'Current scene:', 'Present: A lead gremlin, Syrvanus Voxaris.', 'Syrvanus talks with gremlins in the Chronicle Room.', '- It is night.',
            'Just happened (oldest first):', '- The gremlins revealed themselves.',
        ].join('\n'));
        expect(body(out.ctx_scene_characters)).toBe('Characters in this scene:\n- A lead gremlin: An eager servant.; traits: cautious; wants: serve the Mnemos; feeling: eager');
        // Zeno is not here: his relationship stays out; the gremlin's name matches loosely.
        expect(body(out.ctx_scene_relationships)).toBe('Relationships in this scene:\n- Syrvanus Voxaris -> gremlin (lead): ally, close (+2), medium intensity, warming. He accepts their help.');
        expect(body(out.ctx_threads)).toBe('Open story threads and quests:\n- [active] Find Alvaryx (quest): Alvaryx is missing. Progress: The gremlins offered to help.');
        expect(body(out.ctx_recent_events)).toBe('Recent events:\n- Zeno collared Syrvanus. (witnessed by Rydia)');
        expect(body(out.ctx_secrets)).toContain('- The collar: It is venomous. Known only by: Zeno.');
        expect(out.ctx_secrets).not.toContain('gremlin plot');
        expect(out.ctx_phrase_tics).toBe('');
        for (const text of Object.values(out).filter(Boolean)) expect(text.startsWith(`${REFERENCE_MARKER}\n`)).toBe(true);
    });

    it('lists standing promises, then broken ones - not those kept or released', () => {
        const promise = (name, status, extra = {}) => ({ kind: 'promise', name, text: `${name}.`, status, made_by: [], made_to: [], ...extra });
        const withPromises = buildPromptContext({ ...view, world: { ...view.world, promise: [
            promise('Old oath', 'broken', { made_by: [{ name: 'Zeno' }] }),
            promise('Serve the Mnemos', 'pending', { made_by: [{ name: 'gremlin (lead)' }], made_to: [{ name: 'Syrvanus Voxaris' }] }),
            promise('Done deal', 'kept'),
            promise('Let go', 'released'),
        ] } }, { present: [syr] });
        expect(body(withPromises.ctx_promises)).toBe([
            'Promises, oaths and vows:',
            '- Serve the Mnemos: Serve the Mnemos. Made by gremlin (lead) to Syrvanus Voxaris.',
            '- (BROKEN) Old oath: Old oath. Made by Zeno.',
        ].join('\n'));
        expect(out.ctx_promises).toBe('');
    });

    it('leaves an old scene summary out of the current scene', () => {
        const old = buildPromptContext({ ...view, scene_summary_at: 5 }, { present: [syr] });
        expect(body(old.ctx_scene)).toBe(['Current scene:', 'Present: Syrvanus Voxaris.', '- It is night.', 'Just happened (oldest first):', '- The gremlins revealed themselves.'].join('\n'));
        expect(buildPromptContext({ ...view, scene_summary: '', scene_state: [], scene_recent: [] }, { present: [syr] }).ctx_scene).toBe('');
    });

    it('gives active threads always, and open ones only when someone in the scene (not the persona) is involved', () => {
        const remus = { id: 'chr_r', name: 'Remus Watt' };
        const varyn = { id: 'chr_v', name: 'Varyn' };
        const threads = [
            { title: 'Escape Morvath', kind: 'quest', status: 'active', text: 'a', involved: [remus] },
            { title: 'Maren past', kind: 'quest seed', status: 'open', text: 'b', involved: [{ id: 'chr_m', name: 'Maren' }, remus] },
            { title: 'Supplies', kind: 'quest seed', status: 'open', text: 'c', involved: [remus], steps: [{ text: 'Win over Niamh', status: 'pending', involved: [{ id: null, name: 'Niamh' }] }] },
            { title: 'Varyn debt', kind: 'plot hook', status: 'open', text: 'd', involved: [varyn] },
            { title: 'Done', kind: 'quest', status: 'resolved', text: 'e', involved: [varyn] },
        ];
        const titles = (present) => body(buildPromptContext({ threads }, { present, persona: remus }).ctx_threads).split('\n')
            .filter((l) => l.startsWith('- ')).map((l) => l.match(/\] (.*) \(/)[1]);
        expect(titles([remus, varyn])).toEqual(['Escape Morvath', 'Varyn debt']);
        expect(titles([remus, { id: 'chr_n', name: 'Niamh' }])).toEqual(['Escape Morvath', 'Supplies']);
        // No one but the persona marked present: every open one.
        expect(titles([remus])).toEqual(['Escape Morvath', 'Maren past', 'Supplies', 'Varyn debt']);
    });

    it('shows a plan\'s goal, the step it is on and the next', () => {
        const plan = {
            title: 'Supplies', kind: 'quest seed', status: 'active', text: 'Equip the expedition.', progress: '', goal: 'Secure supplies',
            steps: [
                { text: 'Get books from the library', status: 'done' },
                { text: 'Win over Niamh', status: 'active', note: 'for a price' },
                { text: 'Barter with Graxx', status: 'pending' },
            ],
        };
        expect(threadLine(plan)).toBe('- [active] Supplies (quest seed): Equip the expedition.\n  Plan: Goal: Secure supplies. Step 2 of 3, now: Win over Niamh (for a price). Then: Barter with Graxx.');
        expect(threadLine({ ...plan, goal: '', steps: plan.steps.map((s) => ({ ...s, status: 'done' })) })).toBe('- [active] Supplies (quest seed): Equip the expedition.\n  Plan: All steps done.');
        expect(threadLine({ ...plan, goal: '', steps: [] })).toBe('- [active] Supplies (quest seed): Equip the expedition.');
    });

    it('is empty without a compiled view', () => {
        expect(Object.values(buildPromptContext(null)).every((text) => text === '')).toBe(true);
    });
});

describe('the prompt context in State Engine, for Curator', () => {
    it('offers each block to Curator', () => {
        expect(CONTEXT_CAPABILITIES).toContain('curator.inject:ar__ctx_scene_relationships');
        expect(CONTEXT_CAPABILITIES).toContain('curator.inject.role:user:ar__ctx_scene_relationships');
        expect(CONTEXT_CAPABILITIES).toHaveLength(CONTEXT_BLOCKS.length * 2);
    });

    it('writes the open chat\'s blocks into the live preset, and only what changed', async () => {
        const fake = resetFakeStateEngine();
        fake.addObject('chr_l', 'character', 'Lucian');
        fake.respond = async () => ({
            ar__compiled_facts: [{ text: 'Lucian works at the gym.', classification: 'PERMANENT', entities: ['Lucian'], sources: ['m1'] }],
            ar__compiled_story_summary: 'Lucian started at the gym.',
        });
        getContext().chat = [{ name: 'User', is_user: true, mes: 'hi', send_date: 'd0' }, { name: 'Lucian', mes: 'Lucian works.', send_date: 'd1' }];
        Object.assign(getSettings(), { enabled: true, compileWorld: false });
        await loadCurrentChat();
        await ensureLivePreset();
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'Lucian works at the gym', source_message_id: 'Chat A#1@d1' }]);
        await compileOpenChat();

        await syncPromptContext();
        expect(fake.readValue('Chat A', 'ar__ctx_story_summary')).toBe(`${REFERENCE_MARKER}\nStory so far:\nLucian started at the gym.`);
        const writes = () => fake.calls.filter((c) => c.name === 'setVariableValue' && String(c.args[1]?.variableName ?? '').startsWith('ctx_')).length;
        const before = writes();
        await syncPromptContext();
        expect(writes()).toBe(before);
    });
});
