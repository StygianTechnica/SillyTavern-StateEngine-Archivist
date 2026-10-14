// Phrase tics: stock phrases the narration leans on - "a wry smile tugged at
// his lips", "his tone turned serious" - kept for a while so the prompt can
// ask the model to vary its wording, then let go. Plain functions, so they
// can be tested on their own; the runner is phrase-tic-tracker.js.
//
// A tic: { phrase, key, count, last_used, seen_at, decay_from }
//   phrase      as the narration wrote it (shown to the model and the user)
//   key         its words for matching (phraseKey())
//   count       how strongly it is in use: 1 when found, +1 each time a
//               later reply uses it again (at most MAX_COUNT), -1 each
//               time `fadeAfter` AI replies pass without it; gone at 0
//   last_used   ISO time it was last found
//   seen_at, decay_from   the chat's AI-reply counter when it was last
//               found, and when it last lost a count
//
// FINDING them is the compiler's: findCandidates() picks the word sequences
// that recur across the latest replies, and the compiler's model says which
// are tics (names, plot details and a character's own way of speaking are
// not). TRACKING them is code: each new reply is matched against the known
// tics (updateForReply()). Nothing is ever banned or rewritten - the prompt
// block only asks for variety while a tic is in use (count >= WARN_AT).

// AI replies scanned for candidates, and phrase lengths, in words.
export const TIC_WINDOW = 10;
export const MIN_WORDS = 4;
export const MAX_WORDS = 8;
export const MAX_CANDIDATES = 25;
export const MAX_COUNT = 5;
export const WARN_AT = 2;
export const MAX_SHOWN = 8;

// Pronouns as one word each, so "tugged at his lips" and "tugged at her
// lips" are the same phrase.
const PRONOUNS = Object.freeze({
    he: 'they', she: 'they', they: 'they',
    his: 'their', her: 'their', their: 'their', hers: 'theirs', theirs: 'theirs',
    him: 'them', them: 'them',
    himself: 'themselves', herself: 'themselves', themselves: 'themselves',
});

// Words that alone make no phrase: a candidate needs MIN_CONTENT others.
const FILLER = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'into', 'onto', 'over', 'up', 'down', 'out', 'off',
    'that', 'this', 'it', 'its', 'is', 'was', 'were', 'be', 'been', 'had', 'has', 'have', 'not', 'no', 'so', 'if', 'then', 'than', 'just', 'there',
    'they', 'their', 'them', 'theirs', 'themselves', 'i', 'me', 'my', 'you', 'your', 'we', 'us', 'our', 'what', 'who', 'which', 'when', 'where',
    'do', 'did', 'does', 'would', 'could', 'should', 'will', 'can', 'all', 'some', 'more', 'like',
]);
const MIN_CONTENT = 2;

// Plain text of a message: no markup, no emphasis marks.
function plain(text) {
    return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/[*_~`]+/g, ' ');
}

// [{ word (normalized), raw (as written) }] of a text.
function tokens(text) {
    const out = [];
    for (const match of plain(text).matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) {
        const raw = match[0];
        const lower = raw.toLowerCase().replace(/’/g, '\'');
        out.push({ word: PRONOUNS[lower] ?? lower, raw });
    }
    return out;
}

// A phrase's words for matching: "A wry smile tugged at HER lips." ->
// "a wry smile tugged at their lips".
export function phraseKey(text) {
    return tokens(text).map((t) => t.word).join(' ');
}

// Whether `text` uses the phrase with key `key`.
export function usesPhrase(text, key) {
    return !!key && ` ${phraseKey(text)} `.includes(` ${key} `);
}

const contentWords = (words) => words.filter((w) => !FILLER.has(w)).length;

// The sentence of `text` around position `at` (a character index), trimmed.
function sentenceAround(text, at) {
    const source = plain(text).replace(/\s+/g, ' ');
    const start = Math.max(...['. ', '! ', '? ', '" ', '\n'].map((s) => source.lastIndexOf(s, at))) + 1;
    const ends = ['. ', '! ', '? '].map((s) => source.indexOf(s, at)).filter((i) => i >= 0);
    const end = ends.length ? Math.min(...ends) + 1 : source.length;
    const sentence = source.slice(start, end).trim();
    return sentence.length > 220 ? `${sentence.slice(0, 219).trim()}…` : sentence;
}

// The word sequences (MIN_WORDS..MAX_WORDS) that recur across different
// `replies` ([{ index, text }] - the latest AI replies), longest and most
// repeated first, a shorter one left out when a longer one covers it:
// [{ ref: 'p1', key, text, replies: [index], example }], at most
// MAX_CANDIDATES.
export function findCandidates(replies) {
    const found = new Map(); // key -> { key, text, replies: Set, example }
    for (const reply of replies ?? []) {
        const toks = tokens(reply.text);
        const seen = new Set();
        for (let n = MIN_WORDS; n <= MAX_WORDS; n++) {
            for (let i = 0; i + n <= toks.length; i++) {
                const slice = toks.slice(i, i + n);
                const words = slice.map((t) => t.word);
                const key = words.join(' ');
                if (seen.has(key) || contentWords(words) < MIN_CONTENT) continue;
                seen.add(key);
                if (!found.has(key)) {
                    const text = slice.map((t) => t.raw).join(' ');
                    const at = plain(reply.text).replace(/\s+/g, ' ').indexOf(slice[0].raw);
                    found.set(key, { key, text, replies: new Set(), example: sentenceAround(reply.text, Math.max(0, at)) });
                }
                found.get(key).replies.add(reply.index);
            }
        }
    }
    const repeated = [...found.values()].filter((c) => c.replies.size >= 2)
        .sort((a, b) => b.key.split(' ').length - a.key.split(' ').length || b.replies.size - a.replies.size);
    const kept = [];
    for (const candidate of repeated) {
        // Covered by a longer phrase found in as many replies: the same tic.
        if (kept.some((k) => ` ${k.key} `.includes(` ${candidate.key} `) && k.replies.size >= candidate.replies.size)) continue;
        kept.push(candidate);
    }
    return kept
        .sort((a, b) => b.replies.size - a.replies.size || b.key.split(' ').length - a.key.split(' ').length)
        .slice(0, MAX_CANDIDATES)
        .map((c, i) => ({ ref: `p${i + 1}`, key: c.key, text: c.text, replies: [...c.replies].sort((x, y) => x - y), example: c.example }));
}

// What the compiler's model reads about them.
export function candidateLines(candidates) {
    if (!candidates?.length) return ['Repeated phrases in the latest replies:', '(none)'];
    return [
        'Repeated phrases in the latest replies (each found in several of them):',
        ...candidates.map((c) => `[${c.ref}] "${c.text}" - in ${c.replies.length} replies; e.g. ${c.example}`),
    ];
}

// The model's answer ([{ ref, phrase }]) as [{ key, phrase }]: only refs it
// was given; its phrase when it is the tic itself (part of the candidate, or
// the candidate with a little more), else the candidate's words.
export function parseTicAnswer(raw, candidates) {
    const byRef = new Map((candidates ?? []).map((c) => [c.ref, c]));
    const out = [];
    const keys = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
        const ref = String(item?.ref ?? item?.id ?? '').replace(/^\[|\]$/g, '').trim();
        const candidate = byRef.get(ref);
        if (!candidate) continue;
        const phrase = typeof item.phrase === 'string' ? item.phrase.trim().replace(/^["“]|["”.]+$/g, '') : '';
        const key = phraseKey(phrase);
        const own = key.split(' ').length >= 3 && (candidate.key.includes(key) || key.includes(candidate.key));
        const tic = own ? { key, phrase } : { key: candidate.key, phrase: candidate.text };
        if (keys.has(tic.key)) continue;
        keys.add(tic.key);
        out.push(tic);
    }
    return out;
}

// `tics` with newly found ones (from parseTicAnswer) added at count 1. One
// already known is left to the reply tracking, which counted it as it came.
export function addFound(tics, found, { now, counter }) {
    const next = [...(tics ?? [])];
    for (const tic of found ?? []) {
        if (next.some((t) => t.key === tic.key || ` ${t.key} `.includes(` ${tic.key} `) || ` ${tic.key} `.includes(` ${t.key} `))) continue;
        next.push({ phrase: tic.phrase, key: tic.key, count: 1, last_used: now, seen_at: counter, decay_from: counter });
    }
    return next;
}

// `tics` after one more AI reply (`text`; `counter` is the chat's reply
// count including it): a tic it uses gains a count; one unused for
// `fadeAfter` replies loses one, and goes at 0.
export function updateForReply(tics, text, { now, counter, fadeAfter }) {
    const next = [];
    for (const tic of tics ?? []) {
        if (usesPhrase(text, tic.key)) {
            next.push({ ...tic, count: Math.min(MAX_COUNT, tic.count + 1), last_used: now, seen_at: counter, decay_from: counter });
        } else if (counter - (tic.decay_from ?? counter) >= fadeAfter) {
            if (tic.count > 1) next.push({ ...tic, count: tic.count - 1, decay_from: counter });
        } else {
            next.push(tic);
        }
    }
    return next;
}

// The tics to warn about: in use (count >= WARN_AT), most recent first.
export function activeTics(tics) {
    return (tics ?? []).filter((t) => t.count >= WARN_AT)
        .sort((a, b) => String(b.last_used).localeCompare(String(a.last_used)) || b.count - a.count)
        .slice(0, MAX_SHOWN);
}
