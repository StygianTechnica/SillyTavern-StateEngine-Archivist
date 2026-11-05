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
        return { id: c.id ?? null, name: clean(c.name), aliases: (c.aliases ?? []).map(clean).filter(Boolean), role, factions: of, allFactions: allFactionNames };
    }).filter((c) => c.role || c.factions.length);
}

// The canon line of one character: "Doctor Adrigo Tole: Lead Cybernetics
// Researcher at Omicron Innovations; of Omicron Innovations".
export function canonLine(c) {
    const bits = [];
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
        'Fixed facts from the world library - who these people are and whose side they are on. They hold whatever a reply said: never write a summary, motivation or relationship that ties someone to a faction they are not of, or gives them another employer or role. A reply that seemed to (someone speaking of "our" dealings with another faction) is a slip or a pretence, not who they are:',
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
export function scrubProfile(profile, c) {
    if (!profile || !c) return profile;
    const keep = (text) => !strayFaction(text, c);
    const out = { ...profile };
    if (profile.summary) {
        out.summary = clean(String(profile.summary).split(/(?<=[.!?])\s+/).filter(keep).join(' '));
    }
    for (const field of ['traits', 'habits', 'stressors', 'motivations']) {
        if (Array.isArray(profile[field])) out[field] = profile[field].filter(keep);
    }
    if (profile.arc && !keep(profile.arc)) out.arc = '';
    return out;
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
