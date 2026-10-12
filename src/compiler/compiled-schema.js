// The compiled memory's vocabulary: classifications and colour tags.
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
