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

// The first of `words` that `token` has as a whole word, or undefined.
const wordIn = (token, words) => words.find((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(token));

// 2, "+2", "2.4", "close", "close (+2)", "wary (-1)" -> the number, else
// the word; unknown -> 0. Clamped to -3..3. Small models write the label
// and the number together, copied from the context's relationship lines.
export function normalizePolarity(value) {
    let n = typeof value === 'number' ? value : NaN;
    if (Number.isNaN(n)) {
        // A typographic minus or dash ("−1") is a minus.
        const token = String(value ?? '').trim().toLowerCase().replace(/[−–—]/g, '-');
        const number = token.match(/[-+]?\d+(\.\d+)?/);
        n = number ? Number.parseFloat(number[0]) : (POLARITY_WORDS[wordIn(token, Object.keys(POLARITY_WORDS))] ?? 0);
    }
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
    const word = wordIn(token, INTENSITIES);
    if (word) return word;
    if (/^(strong|intense|very|deep)/.test(token)) return 'high';
    if (/^(weak|slight|mild|faint|minor)/.test(token)) return 'low';
    return 'medium';
}

// Which way a relationship is moving ('' when not said).
export const TRENDS = Object.freeze(['warming', 'cooling', 'stable', 'volatile']);

export function normalizeTrend(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (TRENDS.includes(token)) return token;
    const word = wordIn(token, TRENDS);
    if (word) return word;
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

// A plan's step (a thread's `steps`, in order): pending (not reached yet),
// active (being done now), done, skipped (the plan changed around it) or
// failed. Anything unknown is pending.
export const STEP_STATUSES = Object.freeze(['pending', 'active', 'done', 'skipped', 'failed']);

export function normalizeStepStatus(value) {
    const token = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (STEP_STATUSES.includes(token)) return token;
    if (/^(in progress|ongoing|current|underway|started)/.test(token)) return 'active';
    if (/^(complete|finished|resolved|achieved|succeeded)/.test(token)) return 'done';
    if (/^(dropped|abandoned|cancel|bypass|unneeded|not needed)/.test(token)) return 'skipped';
    if (/^(fail|botched|lost)/.test(token)) return 'failed';
    return 'pending';
}

// A plan's steps as the user edits them: a line per step,
// "[status] what is to be done | note" (status and note optional).
export function stepsToText(steps) {
    return (steps ?? []).map((s) => `[${s.status}] ${s.text}${s.note ? ` | ${s.note}` : ''}`).join('\n');
}

// stepsToText() read back: [{ text, status, note }] in order, blank lines
// left out; a line without a [status] is pending.
export function stepsFromText(value) {
    return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const [, status = '', rest] = line.match(/^(?:\[([^\]]*)\]\s*)?(.*)$/);
        const bar = rest.indexOf('|');
        return {
            text: (bar === -1 ? rest : rest.slice(0, bar)).trim(),
            status: normalizeStepStatus(status),
            note: bar === -1 ? '' : rest.slice(bar + 1).trim(),
        };
    }).filter((s) => s.text);
}

// The step a plan is on: the first not done or skipped (null when none is
// left, or there are no steps).
export function currentStep(steps) {
    return (steps ?? []).find((s) => s.status !== 'done' && s.status !== 'skipped') ?? null;
}

// ---- story tension

// How tense the story is at a point, on three axes, each 0 (none) to
// TENSION_MAX: threat (danger, conflict, stakes), uncertainty (unknowns,
// suspense, open questions) and emotional (strain, grief, longing,
// confrontation). The overall tension is their average.
export const TENSION_AXES = Object.freeze(['threat', 'uncertainty', 'emotional']);
export const TENSION_MAX = 5;

// A level 0..TENSION_MAX ("4", 4.4, "4/5" -> 4), or null when it is not a
// number.
export function normalizeTensionLevel(value) {
    const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
    if (!Number.isFinite(n)) return null;
    return Math.min(TENSION_MAX, Math.max(0, Math.round(n)));
}

// The average of a reading's axes, to one decimal.
export function tensionOverall(reading) {
    const sum = TENSION_AXES.reduce((total, axis) => total + (reading?.[axis] ?? 0), 0);
    return Math.round((sum / TENSION_AXES.length) * 10) / 10;
}

// ---- the world

// A secret is kept (still hidden), revealed (those it was hidden from know
// it now) or disproven (it turned out not to be true). Never dropped - its
// status says it no longer holds. Anything unknown is kept.
export const SECRET_STATUSES = Object.freeze(['kept', 'revealed', 'disproven']);

export function normalizeSecretStatus(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (SECRET_STATUSES.includes(token)) return token;
    // "known only to Varyn", "hidden", "still secret": kept - not the
    // "known" of a revealed secret.
    if (/\b(only|hidden|secret|concealed|unknown|unrevealed|not (yet )?(known|revealed))\b/.test(token)) return 'kept';
    if (/^(reveal|exposed|known|out|discovered|public)/.test(token)) return 'revealed';
    if (/^(disprov|false|wrong|untrue|debunk|refuted|mistaken)/.test(token)) return 'disproven';
    return 'kept';
}

// A promise (an oath, a vow, a pledge, a deal) is pending (standing, not
// yet fulfilled), kept, broken, or released (called off, or let go by the
// one it was made to). Never dropped, like a secret. Anything unknown is
// pending.
export const PROMISE_STATUSES = Object.freeze(['pending', 'kept', 'broken', 'released']);

export function normalizePromiseStatus(value) {
    const token = String(value ?? '').trim().toLowerCase();
    if (PROMISE_STATUSES.includes(token)) return token;
    // "unfulfilled", "not yet kept", "not broken": still standing.
    if (/^(un|not )/.test(token)) return 'pending';
    if (/^(broke|break|betray|violat|fail|forsw|reneg|abandon)/.test(token)) return 'broken';
    if (/^(fulfil|honou?r|complet|done|met|satisf|carried out|upheld)/.test(token)) return 'kept';
    if (/^(releas|withdr|cancel|forgiv|void|annul|dissol|lifted|rescind|absolv|called off)/.test(token)) return 'released';
    return 'pending';
}

// What a world entry is. A closed list, so a UI can group by it; near
// words are mapped onto it, anything else is lore.
export const WORLD_KINDS = Object.freeze(['secret', 'promise', 'location', 'faction', 'item', 'event', 'lore']);
const WORLD_KIND_WORDS = Object.freeze({
    secrets: 'secret', place: 'location', places: 'location', locations: 'location', area: 'location', building: 'location',
    group: 'faction', groups: 'faction', factions: 'faction', organization: 'faction', organisation: 'faction', business: 'faction', team: 'faction', gang: 'faction',
    object: 'item', objects: 'item', items: 'item', thing: 'item',
    'world event': 'event', events: 'event', condition: 'event', situation: 'event',
    rule: 'lore', rules: 'lore', custom: 'lore', norm: 'lore', setting: 'lore',
    promises: 'promise', oath: 'promise', oaths: 'promise', vow: 'promise', vows: 'promise', pledge: 'promise', pledges: 'promise',
    pact: 'promise', deal: 'promise', bargain: 'promise', 'sworn oath': 'promise', 'marriage vows': 'promise',
});

// World kinds named by what they say - a secret by what it hides, a
// promise by what it binds someone to - never linked to an object by name.
export const UNLINKED_WORLD_KINDS = new Set(['secret', 'promise']);

// The status of a world entry of `kind`, normalized where its kind has a
// fixed list (a secret, a promise); lower case otherwise.
export function normalizeWorldStatus(kind, value) {
    if (kind === 'secret') return normalizeSecretStatus(value);
    if (kind === 'promise') return normalizePromiseStatus(value);
    return String(value ?? '').trim().toLowerCase();
}

export function normalizeWorldKind(value) {
    const token = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (WORLD_KINDS.includes(token)) return token;
    return WORLD_KIND_WORDS[token] ?? 'lore';
}
