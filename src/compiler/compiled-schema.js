// The compiled memory's vocabulary: classifications, colour tags, and the
// scales relationships, story threads and world entries are given in.
//
// Every compiled fact is PERMANENT (stable biography, long-term condition),
// SESSION (true for this part of the story) or SCENE (the immediate scene).
// A raw memory's scope maps onto them: long_term -> PERMANENT, session ->
// SESSION, scene -> SCENE.
//
// Colour tags are deterministic. By classification - Permanent (blue),
// Session (yellow), Scene (green) - overridden by Relationship (purple) for
// a relationship between two entities, and by Contradiction (red) for a
// fact incompatible with another, which wins over everything. The hex
// values are Archivist's, so every UI shows the same colours.

export const CLASSIFICATIONS = Object.freeze(['PERMANENT', 'SESSION', 'SCENE']);

export const SCOPE_CLASSIFICATION = Object.freeze({ long_term: 'PERMANENT', session: 'SESSION', scene: 'SCENE' });

export const COLOR_TAGS = Object.freeze({
    PERMANENT: Object.freeze({ name: 'Permanent', color: 'Blue', hex: '#4a90d9' }),
    SESSION: Object.freeze({ name: 'Session', color: 'Yellow', hex: '#d4b03c' }),
    SCENE: Object.freeze({ name: 'Scene', color: 'Green', hex: '#4caf50' }),
    RELATIONSHIP: Object.freeze({ name: 'Relationship', color: 'Purple', hex: '#a070e0' }),
    CONTRADICTION: Object.freeze({ name: 'Contradiction', color: 'Red', hex: '#e05555' }),
});

// "permanent", "Long term", "long_term" -> "PERMANENT"; anything unknown -> fallback.
export function normalizeClassification(value, fallback = 'SESSION') {
    const token = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (CLASSIFICATIONS.includes(token)) return token;
    const fromScope = SCOPE_CLASSIFICATION[token.toLowerCase()];
    return fromScope ?? fallback;
}

// The colour tag for a fact - { name, color, hex } - by the rules above.
export function colorTagFor({ classification, relationship = false, contradiction = false }) {
    if (contradiction) return { ...COLOR_TAGS.CONTRADICTION };
    if (relationship) return { ...COLOR_TAGS.RELATIONSHIP };
    return { ...(COLOR_TAGS[classification] ?? COLOR_TAGS.SESSION) };
}

// `item` with its colour tag attached, in both shapes the spec names: the
// tag object, and color_tag / color_name / color_hex.
export function withColorTag(item, flags) {
    const tag = colorTagFor(flags);
    return { ...item, tag, color_tag: tag.color, color_name: tag.name, color_hex: tag.hex };
}

// ---- relationships

// Polarity: how one character feels toward another, -3..3. A small whole
// number scale with a word for each step - models keep to named steps
// better than to a fine-grained number.
export const POLARITY_LABELS = Object.freeze({
    '-3': 'hostile', '-2': 'antagonistic', '-1': 'wary', 0: 'neutral', 1: 'friendly', 2: 'close', 3: 'devoted',
});
const POLARITY_WORDS = Object.freeze({
    ...Object.fromEntries(Object.entries(POLARITY_LABELS).map(([n, word]) => [word, Number(n)])),
    positive: 1, negative: -1, warm: 1, cold: -1, loving: 3, hateful: -3, enemy: -3, ally: 2, trusting: 2, distrustful: -1, mixed: 0,
});

// 2, "+2", "2.4", "close" -> 2; unknown -> 0. Clamped to -3..3.
export function normalizePolarity(value) {
    let n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
    if (Number.isNaN(n)) n = POLARITY_WORDS[String(value ?? '').trim().toLowerCase()] ?? 0;
    return Math.max(-3, Math.min(3, Math.round(n)));
}

export function polarityLabel(polarity) {
    return POLARITY_LABELS[normalizePolarity(polarity)];
}

// Intensity: how strong or central a relationship is. Words, not numbers -
// a model is steadier choosing between three words.
export const INTENSITIES = Object.freeze(['low', 'medium', 'high']);

export function normalizeIntensity(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (INTENSITIES.includes(token)) return token;
    if (/^(strong|intense|very|deep)/.test(token)) return 'high';
    if (/^(weak|slight|mild|faint|minor)/.test(token)) return 'low';
    return 'medium';
}

// Which way a relationship is moving ('' when not said).
export const TRENDS = Object.freeze(['warming', 'cooling', 'stable', 'volatile']);

export function normalizeTrend(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (TRENDS.includes(token)) return token;
    if (/^(improv|grow|better|closer)/.test(token)) return 'warming';
    if (/^(worse|declin|strain|distant)/.test(token)) return 'cooling';
    if (/^(unstable|chang|turbul|mixed)/.test(token)) return 'volatile';
    return '';
}

// ---- story threads

// open: set up, not taken up yet; active: being pursued; resolved;
// abandoned. Anything unknown is open.
export const THREAD_STATUSES = Object.freeze(['open', 'active', 'resolved', 'abandoned']);

export function normalizeThreadStatus(value) {
    const token = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (THREAD_STATUSES.includes(token)) return token;
    if (/^(in progress|ongoing|pursued|underway|started)/.test(token)) return 'active';
    if (/^(done|complete|closed|finished|solved)/.test(token)) return 'resolved';
    if (/^(dropped|failed|dead|forgotten)/.test(token)) return 'abandoned';
    return 'open';
}

// ---- the world

// A secret is kept (still hidden), revealed (those it was hidden from know
// it now) or disproven (it turned out not to be true). Never dropped - its
// status says it no longer holds. Anything unknown is kept.
export const SECRET_STATUSES = Object.freeze(['kept', 'revealed', 'disproven']);

export function normalizeSecretStatus(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (SECRET_STATUSES.includes(token)) return token;
    if (/^(reveal|exposed|known|out|discovered|public)/.test(token)) return 'revealed';
    if (/^(disprov|false|wrong|untrue|debunk|refuted|mistaken)/.test(token)) return 'disproven';
    return 'kept';
}

// What a world entry is. A closed list, so a UI can group by it; near
// words are mapped onto it, anything else is lore.
export const WORLD_KINDS = Object.freeze(['secret', 'location', 'faction', 'item', 'event', 'lore']);
const WORLD_KIND_WORDS = Object.freeze({
    secrets: 'secret', place: 'location', places: 'location', locations: 'location', area: 'location', building: 'location',
    group: 'faction', groups: 'faction', factions: 'faction', organization: 'faction', organisation: 'faction', business: 'faction', team: 'faction', gang: 'faction',
    object: 'item', objects: 'item', items: 'item', thing: 'item',
    'world event': 'event', events: 'event', condition: 'event', situation: 'event',
    rule: 'lore', rules: 'lore', custom: 'lore', norm: 'lore', setting: 'lore',
});

export function normalizeWorldKind(value) {
    const token = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (WORLD_KINDS.includes(token)) return token;
    return WORLD_KIND_WORDS[token] ?? 'lore';
}
