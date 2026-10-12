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

// The blocks, in the order a user would usually want them: [local variable
// name, label, what it holds].
export const CONTEXT_BLOCKS = Object.freeze([
    ['ctx_story_summary', 'Story so far', 'A summary of the story so far, from the compiled memory.'],
    ['ctx_scene', 'Current scene', 'The current scene: its summary, what holds in it, and what just happened.'],
    ['ctx_scene_characters', 'Characters in the scene', 'Traits, motivations, stressors and feelings of the characters present.'],
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

function block(title, lines) {
    return lines.length ? [title, ...lines].join('\n') : '';
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

    if (view.story_summary) out.ctx_story_summary = `Story so far:\n${view.story_summary}`;

    const sceneLines = [];
    if (view.scene_summary) sceneLines.push(view.scene_summary);
    for (const fact of (view.scene_state ?? []).slice(-MAX_ITEMS)) sceneLines.push(`- ${fact.text}`);
    const recent = (view.scene_recent ?? []).slice(-MAX_ITEMS);
    if (recent.length) sceneLines.push('Just happened:', ...recent.map((m) => `- ${m.text}`));
    out.ctx_scene = block('Current scene:', sceneLines);

    const characterLines = (view.character_profiles ?? [])
        .filter((p) => isPresent({ id: p.entity_id, name: p.name }))
        .map((p) => {
            const parts = [];
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
