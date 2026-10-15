// Phrase tics: stock wording the model leans on - "a wry smile tugged at his
// lips", "we're in this together", "cupped his cheek" - flagged while in use
// so the prompt can ask the model to vary it. Plain functions, so they can
// be tested on their own; the runner is phrase-tic-tracker.js.
//
// A tic (per chat): { phrase, key, count, last_used, seen_at, decay_from }
//   phrase      as the story wrote it (shown to the model and the user)
//   key         its words for matching (phraseKey())
//   count       how strongly it is in use, 0..MAX_COUNT: found or used
//               again -> at least WARN_AT, +1 for each later use; -1 each
//               time `fadeAfter` AI replies pass without it, down to 0 -
//               DORMANT, never dropped: used once more, it is flagged again
//               at once
//   last_used   ISO time it was last found or used
//   seen_at, decay_from   the chat's AI-reply counter when it was last
//               used, and when it last lost a count
//
// The WATCH LIST (shared by every chat, phrase-tic-tracker.js) holds the
// phrases known to be overused - a few the model is known for, the ones the
// user adds, and every tic a compile finds: one use of a watched phrase in
// a reply flags it in that chat.
//
// FINDING them is code, at each compile: findCandidates() picks the word
// sequences repeated across different replies of the latest TIC_WINDOW -
// narration and dialogue alike - leaving out names, the story's own words
// (its places, groups, characters) and wording the user writes too.
// Nothing is ever banned or rewritten - the prompt block only asks for
// variety while a tic is in use (count >= WARN_AT).

// AI replies scanned at a compile, and phrase lengths, in words. A
// three-word phrase must recur in SHORT_MIN_REPLIES replies - at three
// words, chance repeats are common; longer ones in two.
export const TIC_WINDOW = 20;
export const MIN_WORDS = 3;
export const MAX_WORDS = 8;
export const SHORT_MIN_REPLIES = 3;
// New tics one compile may add: the most repeated.
export const MAX_FOUND = 8;
export const MAX_COUNT = 5;
export const WARN_AT = 2;
export const MAX_SHOWN = 8;
// Tics kept per chat; past it, the dormant ones longest unused go.
export const MAX_TRACKED = 200;

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
    'do', 'did', 'does', 'would', 'could', 'should', 'will', 'can', 'all', 'some', 'more', 'like', 'said', 'says', 'say',
]);
const MIN_CONTENT = 2;

// A phrase never starts on a joining word: "and a wry smile" is "a wry
// smile" - and never ends on a FILLER word ("the depth of their").
const BAD_START = new Set(['and', 'but', 'or', 'as', 'then', 'of', 'to', 'at', 'with', 'that', 'which', 'while', 'so', 'for', 'from', 'by', 'in', 'on', 'into', 'than', 'if', 'when']);

// A word's stem, so "cupped", "cupping" and "cups" are one word: a crude
// cut of -ing, -ed, -es, -s and a final -e, the same on every side of a
// match - it only has to agree with itself.
function stem(word) {
    if (word.length <= 3 || FILLER.has(word) || /(ss|us|is)$/.test(word)) return word;
    let w = word;
    if (w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.endsWith('ed')) w = w.slice(0, -2);
    else if (/(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2);
    else if (w.endsWith('s')) w = w.slice(0, -1);
    if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss)$/.test(w)) w = w.slice(0, -1);
    if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
    return w.length >= 3 ? w : word;
}

// Plain text of a message: no markup, no emphasis marks.
function plain(text) {
    return String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/[*_~`]+/g, ' ');
}

// A message in clauses - narration and dialogue alike, since a stock line
// of dialogue ("we're in this together") is as much a tic as a stock
// gesture - cut at punctuation and quotes, so no phrase runs from one
// clause into the next ("Varyn said, his voice low" is not "said his
// voice") or from narration into what is said.
function clauses(text) {
    return plain(text)
        .split(/[.,;:!?…()[\]|"“”]+|\s[-–—]+\s|[–—]+/)
        .map((c) => c.trim())
        .filter(Boolean);
}

// [{ word (normalized), raw (as written), name (a capitalized word not
// opening its clause) }] of a text. A name's possessive is "their"
// ("cupped Remus's cheek" is "cupped his cheek").
function tokens(text) {
    const out = [];
    for (const match of plain(text).matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)) {
        const raw = match[0];
        const lower = raw.toLowerCase().replace(/’/g, '\'');
        const capital = /^\p{Lu}/u.test(raw) && !/^I($|')/.test(raw);
        let word;
        if (PRONOUNS[lower]) word = PRONOUNS[lower];
        else if (capital && /'s$/.test(lower)) word = 'their';
        else word = stem(lower);
        out.push({ word, raw, capital: capital && !PRONOUNS[lower] && !/'s$/.test(lower) });
    }
    return out;
}

// A phrase's words for matching: "Cupping HER cheeks." -> "cup their
// cheek".
export function phraseKey(text) {
    return tokens(text).map((t) => t.word).join(' ');
}

// Whether `text` uses the phrase with key `key`.
export function usesPhrase(text, key) {
    return !!key && clauses(text).some((clause) => ` ${phraseKey(clause)} `.includes(` ${key} `));
}

const contentWords = (words) => words.filter((w) => !FILLER.has(w)).length;

// Whether words (normalized) can be a phrase on their own: enough content,
// no joining word in front, no dangling word at the end.
export function wellFormed(words) {
    return words.length >= MIN_WORDS && contentWords(words) >= MIN_CONTENT && !BAD_START.has(words[0]) && !FILLER.has(words[words.length - 1]);
}

// The sentence of `text` around position `at` (a character index), trimmed.
function sentenceAround(text, at) {
    const source = plain(text).replace(/\s+/g, ' ');
    const start = Math.max(...['. ', '! ', '? ', '" ', '\n'].map((s) => source.lastIndexOf(s, at))) + 1;
    const ends = ['. ', '! ', '? '].map((s) => source.indexOf(s, at)).filter((i) => i >= 0);
    const end = ends.length ? Math.min(...ends) + 1 : source.length;
    const sentence = source.slice(start, end).trim();
    return sentence.length > 220 ? `${sentence.slice(0, 219).trim()}…` : sentence;
}

// The words of `texts` that are names: capitalized where they don't open
// a clause - "Remus", "Liston" - lowercased and stemmed.
function namesIn(texts) {
    const names = new Set();
    for (const text of texts) {
        for (const clause of clauses(text)) {
            for (const token of tokens(clause).slice(1)) if (token.capital) names.add(token.word);
        }
    }
    return names;
}

// The story's own words, from names ("The Liston Library", "Varyn Vance"):
// a phrase with one of them is about the story, not wording. Stemmed, 4
// letters or more.
export function storyWordsOf(names) {
    const words = new Set();
    for (const name of names ?? []) {
        for (const token of tokens(name)) if (token.word.length >= 4 && !FILLER.has(token.word)) words.add(token.word);
    }
    return words;
}

// The word sequences (MIN_WORDS..MAX_WORDS) that recur across different
// `replies` ([{ index, text }] - the latest AI replies), most repeated
// first, then longest: [{ key, text, replies: [index], example }], at most
// `max`. Left out: a sequence with a name in it, or a word of `storyWords`
// (storyWordsOf()); one the user also wrote (`userTexts`); one in
// `ignored` (keys). One phrase is one candidate: a sequence whose every
// occurrence overlaps one already chosen - the same words shifted, or a
// part of it - is left out.
export function findCandidates(replies, { userTexts = [], storyWords = new Set(), ignored = new Set(), max = MAX_FOUND } = {}) {
    const names = namesIn((replies ?? []).map((r) => r.text));
    const skip = (word) => names.has(word) || storyWords.has(word);
    // key -> { key, text, spans: Map(reply index -> [start, end)), example }
    const found = new Map();
    for (const reply of replies ?? []) {
        // Positions run on across the clauses (offset), for overlap.
        let offset = 0;
        for (const clause of clauses(reply.text)) {
            const toks = tokens(clause);
            for (let n = MIN_WORDS; n <= MAX_WORDS; n++) {
                for (let i = 0; i + n <= toks.length; i++) {
                    const slice = toks.slice(i, i + n);
                    const words = slice.map((t) => t.word);
                    if (!wellFormed(words) || words.some(skip) || slice.slice(1).some((t) => t.capital)) continue;
                    const key = words.join(' ');
                    if (!found.has(key)) {
                        const text = slice.map((t) => t.raw).join(' ');
                        const source = plain(reply.text).replace(/\s+/g, ' ');
                        const at = source.indexOf(text) >= 0 ? source.indexOf(text) : source.indexOf(text.split(' ')[0]);
                        found.set(key, { key, text, spans: new Map(), example: sentenceAround(reply.text, Math.max(0, at)) });
                    }
                    const spans = found.get(key).spans;
                    if (!spans.has(reply.index)) spans.set(reply.index, [offset + i, offset + i + n]);
                }
            }
            offset += toks.length + 1;
        }
    }
    const length = (c) => c.key.split(' ').length;
    const repeated = [...found.values()]
        .filter((c) => c.spans.size >= (length(c) < 4 ? SHORT_MIN_REPLIES : 2))
        .filter((c) => ![...ignored].some((key) => sameTic(key, c.key)) && !userTexts.some((text) => usesPhrase(text, c.key)))
        .sort((a, b) => b.spans.size - a.spans.size || length(b) - length(a));
    const kept = [];
    const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
    for (const candidate of repeated) {
        const covered = [...candidate.spans].every(([reply, span]) => kept.some((k) => k.spans.has(reply) && overlaps(k.spans.get(reply), span)));
        if (!covered) kept.push(candidate);
        if (kept.length >= max) break;
    }
    return kept.map((c) => ({ key: c.key, text: c.text, replies: [...c.spans.keys()].sort((x, y) => x - y), example: c.example }));
}

const sameTic = (a, b) => a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);

// `tics` with the ones a compile found (findCandidates()) flagged: a new
// one added in use (at least WARN_AT, more the more replies had it), a
// known one - dormant or not - flagged again.
export function addFound(tics, found, { now, counter }) {
    const next = [...(tics ?? [])];
    for (const tic of found ?? []) {
        const count = Math.min(MAX_COUNT, Math.max(WARN_AT, tic.replies?.length ?? WARN_AT));
        const at = next.findIndex((t) => sameTic(t.key, tic.key));
        if (at === -1) next.push({ phrase: tic.text ?? tic.phrase, key: tic.key, count, last_used: now, seen_at: counter, decay_from: counter });
        else next[at] = { ...next[at], count: Math.max(next[at].count, count), last_used: now, seen_at: counter, decay_from: counter };
    }
    return next;
}

// `tics` after one more AI reply (`text`; `counter` is the chat's reply
// count including it). A tic it uses gains a count - and is flagged at
// once if it had faded; a watched phrase (`watch`: [{ phrase, key }]) it
// uses that the chat doesn't track yet is added, flagged. One unused for
// `fadeAfter` replies loses a count, down to 0 - dormant, kept.
export function updateForReply(tics, text, { now, counter, fadeAfter, watch = [] }) {
    const next = [];
    for (const tic of tics ?? []) {
        if (usesPhrase(text, tic.key)) {
            next.push({ ...tic, count: Math.min(MAX_COUNT, Math.max(WARN_AT, tic.count + 1)), last_used: now, seen_at: counter, decay_from: counter });
        } else if (tic.count > 0 && counter - (tic.decay_from ?? counter) >= fadeAfter) {
            next.push({ ...tic, count: tic.count - 1, decay_from: counter });
        } else {
            next.push(tic);
        }
    }
    for (const watched of watch) {
        if (next.some((t) => sameTic(t.key, watched.key)) || !usesPhrase(text, watched.key)) continue;
        next.push({ phrase: watched.phrase, key: watched.key, count: WARN_AT, last_used: now, seen_at: counter, decay_from: counter });
    }
    return prune(next);
}

// At most `max` tics: past it, the dormant ones longest unused go.
export function prune(tics, max = MAX_TRACKED) {
    if (tics.length <= max) return tics;
    const dormant = tics.filter((t) => t.count === 0).sort((a, b) => String(a.last_used).localeCompare(String(b.last_used)));
    const drop = new Set(dormant.slice(0, tics.length - max));
    return tics.filter((t) => !drop.has(t));
}

// The tics to warn about: in use (count >= WARN_AT), most recent first.
export function activeTics(tics) {
    return (tics ?? []).filter((t) => t.count >= WARN_AT)
        .sort((a, b) => String(b.last_used).localeCompare(String(a.last_used)) || b.count - a.count)
        .slice(0, MAX_SHOWN);
}

// A watch-list line as an entry ({ phrase, key }), or null when it is too
// short to match safely (under two words).
export function watchEntry(phrase) {
    const text = String(phrase ?? '').trim().replace(/^["“'‘]|["”'’.]+$/g, '').trim();
    const key = phraseKey(text);
    return key.split(' ').filter(Boolean).length >= 2 ? { phrase: text, key } : null;
}

// The phrases the model is known to overuse, on every watch list to start
// with - the user can remove any.
export const DEFAULT_WATCH = Object.freeze([
    'cupped his cheek',
    'in this together',
    'do this together',
    'a shiver down his spine',
    'voice barely above a whisper',
    'a smile playing on his lips',
    'eyes sparkling with mischief',
    'let out a breath he didn\'t know he was holding',
]);
