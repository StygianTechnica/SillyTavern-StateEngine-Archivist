// What the world library says about a character - their role and the
// factions they belong to - held as fixed. One reply had Dr. Adrigo Tole,
// Lead Cybernetics Researcher at Omicron Innovations, speak of "our recent
// dealings" with White Cerberus; the compiler wrote him down as "a
// consultant for White Cerberus" who "wants: maximizing profit for White
// Cerberus", and every later prompt read that back as fact. White Cerberus
// distrusts Omicron. The compiler now reads these facts before the new
// memories, and the prompt blocks drop any line that ties someone to a
// faction they are not of. Plain functions, no State Engine calls.

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const lower = (text) => clean(text).toLowerCase();
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// characters, factions: State Engine objects ({ id, name, aliases, role,
// members: [character id] }). -> [{ id, name, aliases, role, factions:
// [name], factionNames: every faction's names }], only those with a role
// or a faction.
export function canonFacts(characters = [], factions = []) {
    const factionList = (factions ?? []).filter((f) => clean(f?.name));
    const allFactionNames = factionList.map((f) => ({ name: clean(f.name), aliases: (f.aliases ?? []).map(clean).filter(Boolean) }));
    return (characters ?? []).filter((c) => clean(c?.name)).map((c) => {
        const base = c.base ?? c;
        const role = clean(typeof base.role === 'string' ? base.role : c.role);
        const of = factionList.filter((f) => (f.members ?? []).includes(c.id)).map((f) => clean(f.name));
        return { id: c.id ?? null, name: clean(c.name), aliases: (c.aliases ?? []).map(clean).filter(Boolean), role, factions: of, gender: genderOf(c), allFactions: allFactionNames };
    }).filter((c) => c.role || c.factions.length || c.gender);
}

// A person's he or she, from their own sheet: a gender field, else the
// pronouns their description and personality use, with a clear lead.
// Assassins Inc: Inji Miyama, "he" all through his sheet, was compiled as
// "leveraging her underworld connections". -> 'm' | 'f' | ''.
export function genderOf(c) {
    const base = c?.base ?? {};
    const said = lower(c?.gender ?? base.gender ?? c?.pronouns ?? base.pronouns);
    if (/^(?:m|male|man|he|he\/him)$/.test(said)) return 'm';
    if (/^(?:f|female|woman|she|she\/her)$/.test(said)) return 'f';
    const text = [c?.description, base.description, c?.personality, base.personality].filter((t) => typeof t === 'string').join(' ');
    const m = (text.match(/\b(?:he|him|his|himself)\b/gi) ?? []).length;
    const f = (text.match(/\b(?:she|her|hers|herself)\b/gi) ?? []).length;
    if (m >= 3 && f * 3 <= m) return 'm';
    if (f >= 3 && m * 3 <= f) return 'f';
    return '';
}

const PRONOUNS = { m: 'he/him', f: 'she/her' };

// The canon line of one character: "Doctor Adrigo Tole: Lead Cybernetics
// Researcher at Omicron Innovations; of Omicron Innovations".
export function canonLine(c) {
    const bits = [];
    if (c.gender) bits.push(PRONOUNS[c.gender]);
    if (c.role) bits.push(c.role);
    if (c.factions.length) bits.push(`of ${c.factions.join(' and ')}`);
    return bits.length ? `- ${c.name}: ${bits.join('; ')}` : '';
}

// What the compiler's model reads before the new memories: the canon of
// the characters `ids` (or `names`) the batch speaks of.
export function canonPromptLines(canon = [], { ids = [], names = [] } = {}) {
    const wantIds = new Set(ids.filter(Boolean));
    const wantNames = new Set(names.map(lower).filter(Boolean));
    const lines = canon
        .filter((c) => (c.id && wantIds.has(c.id)) || [c.name, ...c.aliases].some((n) => wantNames.has(lower(n))))
        .map(canonLine).filter(Boolean);
    if (!lines.length) return [];
    return [
        'Fixed facts from the world library - who these people are, their pronouns and whose side they are on. They hold whatever a reply said: write each person with the pronouns given, and never write a summary, motivation or relationship that ties someone to a faction they are not of, or gives them another employer or role. A reply that seemed to (someone speaking of "our" dealings with another faction) is a slip or a pretence, not who they are:',
        ...lines,
    ];
}

// Ways of saying someone works for, belongs to or serves a faction.
const TIE = String.raw`(?:(?:consultant|agent|operative|member|employee|man|woman|researcher|scientist|officer|leader|head|ally|associate|representative|envoy|liaison|contact|asset|spy|advisor|adviser|partner|lieutenant|enforcer|servant|soldier|fixer|broker)s?\s+(?:for|of|with|to|at|from)|(?:works?|working|worked|serves?|serving|served|fights?|fighting|fought)\s+(?:for|with)|employed\s+by|loyal\s+to|(?:profits?|benefit|interests?|good|sake|gain)\s+(?:for|of)|on\s+behalf\s+of|(?:joined|joins|part\s+of|one\s+of))\s+(?:the\s+)?`;
const NEGATED = /\b(?:not|never|no longer|isn['’]?t|wasn['’]?t|nor|against|rival|rivals|enemy|enemies|distrust\w*|away from)\b/i;

// Whether `text`, said of character `c` (a canon entry), ties them to a
// faction they are not of. -> the faction's name, or ''.
export function strayFaction(text, c) {
    const t = clean(text);
    if (!t || !c) return '';
    const mine = new Set(c.factions.map(lower));
    for (const f of c.allFactions ?? []) {
        if (mine.has(lower(f.name))) continue;
        const names = [f.name, ...f.aliases].filter((n) => n.length >= 3);
        for (const n of names) {
            const re = new RegExp(String.raw`([^.;!?]{0,40})\b${TIE}${escape(n)}\b`, 'i');
            const m = t.match(re);
            if (m && !NEGATED.test(m[1]) && !NEGATED.test(m[0].slice(m[1].length))) return f.name;
            // "a White Cerberus consultant", "White Cerberus's own agent"
            const before = new RegExp(String.raw`([^.;!?]{0,40})\b${escape(n)}(?:['’]s)?\s+(?:own\s+)?(?:consultant|agent|operative|member|employee|researcher|scientist|officer|leader|ally|associate|representative|envoy|liaison|asset|spy|advisor|adviser|lieutenant|enforcer|fixer|broker)\b`, 'i');
            const b = t.match(before);
            if (b && !NEGATED.test(b[1])) return f.name;
        }
    }
    return '';
}

// A character profile with every part that ties them to a faction they
// are not of left out: the summary sentence by sentence, the lists item
// by item. `c`: their canon entry (or null - the profile as it is).
// Their pronouns are put right as well (fixPronouns; `canon`: every entry,
// for the others' genders).
export function scrubProfile(profile, c, canon = []) {
    if (!profile || !c) return profile;
    const keep = (text) => !strayFaction(text, c);
    const out = fixPronouns(profile, c, canon);
    if (out.summary) {
        out.summary = clean(String(out.summary).split(/(?<=[.!?])\s+/).filter(keep).join(' '));
    }
    for (const field of ['traits', 'habits', 'stressors', 'motivations']) {
        if (Array.isArray(out[field])) out[field] = out[field].filter(keep);
    }
    if (out.arc && !keep(out.arc)) out.arc = '';
    return out;
}

// A profile with the wrong pronouns for its person put right, sentence by
// sentence - only where no one else the sentence names could be the one
// meant: a sentence naming someone of the other gender, or someone whose
// gender the library does not say, is left as it is.
export function fixPronouns(profile, c, canon = []) {
    if (!profile) return profile;
    if (!c?.gender) return { ...profile };
    const own = new Set([c.name, ...c.aliases].map(lower));
    const others = (canon ?? []).filter((o) => o && lower(o.name) !== lower(c.name) && (!c.id || o.id !== c.id));
    const names = (o) => [o.name, ...(o.aliases ?? [])].filter((n) => n.length >= 3 && !own.has(lower(n)));
    const named = (sentence, o) => names(o).some((n) => new RegExp(String.raw`\b${escape(n)}\b`, 'i').test(sentence));
    // A sentence that names no one goes on from the one before ("Inji
    // trusts Vex. She annoys him." - "she" is Vex).
    const fix = (text) => {
        let other = false;
        return String(text).split(/(?<=[.!?])\s+/).map((sentence) => {
            const anyone = own.size && [...own].some((n) => new RegExp(String.raw`\b${escape(n)}\b`, 'i').test(sentence));
            const them = others.some((o) => o.gender !== c.gender && named(sentence, o));
            if (them) other = true;
            else if (anyone || others.some((o) => named(sentence, o))) other = false;
            return other ? sentence : swapPronouns(sentence, c.gender);
        }).join(' ');
    };
    const out = { ...profile };
    for (const field of ['summary', 'arc', 'emotional_state']) if (typeof out[field] === 'string' && out[field]) out[field] = fix(out[field]);
    for (const field of ['traits', 'habits', 'stressors', 'motivations']) if (Array.isArray(out[field])) out[field] = out[field].map((t) => (typeof t === 'string' ? fix(t) : t));
    return out;
}

// After "her", these mean it stood for "him" (an object), not "his".
const OBJECT_NEXT = /^(?:|that|to|and|or|but|in|on|with|for|as|at|from|by|into|onto|again|back|off|up|down|out|away|over|a|an|the|this|these|those|some|any|about|alone|too|well|now|then|here|there|before|after|if|when|while)$/i;
const keepCase = (from, to) => (from[0] === from[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to);

// Every she/her/hers/herself made he/him/his/himself (gender 'm'), or the
// other way round (gender 'f').
export function swapPronouns(text, gender) {
    const t = String(text ?? '');
    const re = gender === 'm' ? /\b(she|hers|herself|her)\b(\s*)([\p{L}'’-]*)/giu : gender === 'f' ? /\b(he|him|himself|his)\b(\s*)([\p{L}'’-]*)/giu : null;
    if (!re) return t;
    return t.replace(re, (all, w, sp, next) => {
        const lw = w.toLowerCase();
        const asObject = OBJECT_NEXT.test(next);
        const to = gender === 'm'
            ? { she: 'he', hers: 'his', herself: 'himself', her: asObject ? 'him' : 'his' }[lw]
            : { he: 'she', him: 'her', himself: 'herself', his: asObject ? 'hers' : 'her' }[lw];
        return keepCase(w, to) + sp + next;
    });
}

// The canon entry for a compiled entity ({ id?, name }), by id, else by
// name or alias.
export function canonFor(canon = [], entity) {
    if (!entity) return null;
    if (entity.id) {
        const byId = canon.find((c) => c.id === entity.id);
        if (byId) return byId;
    }
    const key = lower(entity.name);
    return key ? canon.find((c) => [c.name, ...c.aliases].some((n) => lower(n) === key)) ?? null : null;
}
