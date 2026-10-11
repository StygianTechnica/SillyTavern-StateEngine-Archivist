// The text each message had when Archivist last extracted memories from it
// - so an edit that changed nothing (SillyTavern reports every confirmed
// edit, changed or not) doesn't throw good memories away and re-extract
// them. Kept for this session only: after a reload an edited message with
// memories is re-extracted, to be safe.

const fingerprints = new Map(); // "<chatId>|<send_date>" -> hash of its text

// 32-bit FNV-1a of a message's text.
function hash(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

const keyOf = (chatId, message) => `${chatId}|${message?.send_date ?? ''}`;

// Records `message`'s text as extracted from.
export function rememberExtracted(chatId, message) {
    if (message?.send_date) fingerprints.set(keyOf(chatId, message), hash(message.mes));
}

// true: the text is the same as when it was extracted from; false: it
// changed; null: unknown (not extracted from this session).
export function isUnchangedSinceExtraction(chatId, message) {
    const known = fingerprints.get(keyOf(chatId, message));
    return known === undefined ? null : known === hash(message?.mes);
}

// Forgets every fingerprint (tests; a fresh session starts empty anyway).
export function forgetFingerprints() {
    fingerprints.clear();
}
