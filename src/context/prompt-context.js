// Archivist's knowledge as prompt-ready text - plain functions, so they can
// be tested on their own. The runner is src/context/prompt-sync.js, which
// writes these texts into State Engine variables that Curator offers for
// injection into the prompt (its "State Engine Variables" bank; Archivist
// declares a curator.inject:<variable> capability for each).
//
// Each block is about the open chat, built from its compiled view
// (getCompiledMemory()) and its memories, and focused on what is in play
// NOW: the characters present in the scene (State Engine's presence flags)
// and the user's persona. A block with nothing to say is '' - Curator then
// sends nothing for it.

import { nameKey } from '../compiler/entity-link.js';
import { SCENE_WINDOW } from '../compiler/compile-plan.js';

// The blocks, in the order a user would usually want them: [local variable
// name, label, what it holds].
export const CONTEXT_BLOCKS = Object.freeze([
    ['ctx_story_summary', 'Story so far', 'A summary of the story so far, from the compiled memory.'],
    ['ctx_scene', 'Current scene', 'The current scene: who is here, its summary, what holds in it now, and what just happened.'],
    ['ctx_scene_characters', 'Characters in the scene', 'Who the characters present are now, their traits, motivations, stressors and feelings.'],
    ['ctx_scene_relationships', 'Relationships in the scene', 'How the characters present (and your persona) relate to each other.'],
    ['ctx_threads', 'Open threads and quests', 'Plot hooks, unresolved threads and quests still open or active.'],
    ['ctx_recent_events', 'Recent events', 'The latest events of the story, in order.'],
    ['ctx_secrets', 'Secrets (narrator only)', 'Secrets still kept, and who knows them - knowledge for the narrator, not the characters.'],
]);

export const MAX_ITEMS = 8;

// A block's State Engine variable (without namespace/presetName/name):
// plain text, never asked of the model.
export function contextVariableDef(label, description) {
    return {
        label,
        description: `${description} Written by Archivist for Curator to inject - not asked of the model.`,
        type: 'string',
        defaultValue: '',
        scope: 'chat',
        showInTracker: false,
        behaviors: { prompted: false, increment: false },
    };
}

const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
const names = (entities) => (entities ?? []).map((e) => e?.name).filter(Boolean).join(', ');

// `who` ([{ id?, name, aliases? }]) as a matcher for compiled entities: by
// id when both have one, else by name words (entity-link.js nameKey).
function matcher(who) {
    const ids = new Set(who.map((w) => w.id).filter(Boolean));
    const keys = new Set(who.flatMap((w) => [w.name, ...(w.aliases ?? [])]).map(nameKey).filter(Boolean));
    return (entity) => !!entity && ((entity.id && ids.has(entity.id)) || keys.has(nameKey(entity.name)));
}

// Every block's first line: the model reads the block as reference, not as
// text to continue or imitate.
export const REFERENCE_MARKER = 'REFERENCE ONLY — DO NOT CONTINUE';

function block(title, lines) {
    return lines.length ? [REFERENCE_MARKER, title, ...lines].join('\n') : '';
}

// How many of the current scene's memories "Just happened" lists. The scene
// reaches SCENE_WINDOW messages back from the newest memory.
export const JUST_HAPPENED = 6;

// The current scene, NOW first: who is here, the compiler's summary of the
// scene (only while it was written from the newest messages - an old one
// describes a scene long over), what holds in it (SCENE facts from the
// newest messages only: the compiler keeps old ones around), and the last
// few things that happened in it.
function sceneLines(view, present) {
    const newest = view.newest_message_index ?? null;
    const recentFrom = newest === null ? null : newest - SCENE_WINDOW;
    const isRecent = (index) => recentFrom === null || (index !== null && index !== undefined && index > recentFrom);
    const lines = [];
    const here = present.map((p) => p?.name).filter(Boolean);
    if (here.length) lines.push(`Present: ${here.join(', ')}.`);
    // A summary from before its message was recorded (sceneAt null) is used.
    if (view.scene_summary && (view.scene_summary_at === null || view.scene_summary_at === undefined || isRecent(view.scene_summary_at))) {
        lines.push(view.scene_summary);
    }
    const holds = (view.scene_state ?? []).filter((f) => isRecent(f.message_range?.to)).slice(-MAX_ITEMS);
    for (const fact of holds) lines.push(`- ${fact.text}`);
    const recent = (view.scene_recent ?? []).slice(-JUST_HAPPENED);
    if (recent.length) lines.push('Just happened (oldest first):', ...recent.map((m) => `- ${m.text}`));
    // "Present: ..." alone says nothing about the scene.
    return lines.length > (here.length ? 1 : 0) ? lines : [];
}

// { [local variable name]: text } for the open chat.
//   view      getCompiledMemory() (null: never compiled)
//   present   [{ id?, name, aliases? }] - the characters in the scene
//   persona   { id?, name, aliases? } | null - the user's persona
export function buildPromptContext(view, { present = [], persona = null } = {}) {
    const out = Object.fromEntries(CONTEXT_BLOCKS.map(([name]) => [name, '']));
    if (!view) return out;
    const isPresent = matcher(present);
    const inPlay = matcher(persona ? [...present, persona] : present);

    if (view.story_summary) out.ctx_story_summary = block('Story so far:', [view.story_summary]);

    out.ctx_scene = block('Current scene:', sceneLines(view, present));

    const characterLines = (view.character_profiles ?? [])
        .filter((p) => isPresent({ id: p.entity_id, name: p.name }))
        .map((p) => {
            const parts = [];
            if (p.summary) parts.push(p.summary);
            if (p.traits?.length) parts.push(`traits: ${p.traits.join(', ')}`);
            if (p.motivations?.length) parts.push(`wants: ${p.motivations.join(', ')}`);
            if (p.stressors?.length) parts.push(`under strain from: ${p.stressors.join(', ')}`);
            if (p.emotional_state) parts.push(`feeling: ${p.emotional_state}`);
            return parts.length ? `- ${p.name}: ${parts.join('; ')}` : null;
        })
        .filter(Boolean);
    out.ctx_scene_characters = block('Characters in this scene:', characterLines);

    const relationshipLines = (view.relationships ?? [])
        .filter((r) => inPlay(r.from) && inPlay(r.to) && (isPresent(r.from) || isPresent(r.to)))
        .slice(0, MAX_ITEMS * 2)
        .map((r) => {
            const how = [r.type, `${r.polarity_label} (${signed(r.polarity)})`, `${r.intensity} intensity`, r.trend].filter(Boolean).join(', ');
            return `- ${r.from.name} -> ${r.to.name}: ${how}.${r.text ? ` ${r.text}` : ''}`;
        });
    out.ctx_scene_relationships = block('Relationships in this scene:', relationshipLines);

    const threadLines = (view.threads ?? [])
        .filter((t) => t.status === 'open' || t.status === 'active')
        .slice(0, MAX_ITEMS)
        .map((t) => `- [${t.status}] ${t.title} (${t.kind}): ${t.text}${t.progress ? ` Progress: ${t.progress}` : ''}`);
    out.ctx_threads = block('Open story threads and quests:', threadLines);

    const eventLines = (view.timeline ?? []).slice(-MAX_ITEMS).map((e) => {
        const witnesses = (e.witnesses ?? []).map((w) => w.name).filter(Boolean).join(', ');
        return `- ${e.text}${witnesses ? ` (witnessed by ${witnesses})` : ''}`;
    });
    out.ctx_recent_events = block('Recent events:', eventLines);

    const secretLines = (view.world?.secret ?? [])
        .filter((w) => !w.status || w.status === 'kept')
        .slice(0, MAX_ITEMS)
        .map((w) => `- ${w.name}: ${w.text}${w.known_by?.length ? ` Known only by: ${names(w.known_by)}.` : ''}`);
    out.ctx_secrets = block('Secrets (narrator knowledge; characters know only what they know):', secretLines);

    return out;
}
