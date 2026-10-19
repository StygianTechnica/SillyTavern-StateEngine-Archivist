// What can be saved from a compile answer the model did not finish - the
// connection stopped it at its token limit (finish_reason 'length'), mid-way
// through a fact. State Engine can't read such an answer and writes nothing,
// but keeps its raw text (getIndependentPresetStatus().lastResponse); this
// reads every COMPLETE value out of it: each list's finished items, each
// finished string. What was cut off is left out, never guessed at.
//
// The answers it saves are changes (new or revised items, ids to remove -
// see FACTS_INSTRUCTIONS in compiler.js), so a list cut short only means
// fewer changes: nothing it leaves out is taken as deleted.

const WHITESPACE = /\s/;

// The index just past the string starting at text[i] (a quote), or -1 when
// it never closes.
function stringEnd(text, i) {
    for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '"') return j + 1;
    }
    return -1;
}

// The index just past the JSON value starting at text[i], or -1 when the
// text ends before it does. A bare value (a number, true, a model's unquoted
// word) runs to the next comma, closing bracket or line break - one the text
// ends in may be cut short, so it is not complete either.
function valueEnd(text, i) {
    const ch = text[i];
    if (ch === '"') return stringEnd(text, i);
    if (ch === '{' || ch === '[') {
        let depth = 0;
        for (let j = i; j < text.length; j++) {
            const c = text[j];
            if (c === '"') {
                j = stringEnd(text, j) - 1;
                if (j < 0) return -1;
            } else if (c === '{' || c === '[') {
                depth++;
            } else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0) return j + 1;
            }
        }
        return -1;
    }
    for (let j = i; j < text.length; j++) if (/[,}\]\n]/.test(text[j])) return j;
    return -1;
}

const skipSpace = (text, i) => {
    while (i < text.length && WHITESPACE.test(text[i])) i++;
    return i;
};

// A complete value's text parsed, with the slips small models make in it
// (a comma before a closing bracket) put right; undefined when it can't be.
function parseValue(source) {
    for (const candidate of [source, source.replace(/,(\s*[}\]])/g, '$1')]) {
        try {
            return JSON.parse(candidate);
        } catch {
            // the next candidate
        }
    }
    return undefined;
}

// The top-level object of `raw`, read as far as it goes:
// { values: Map key -> value, complete } - complete when the object closed.
// A list cut off keeps its complete items; any other value cut off is left
// out. Null when there is no object at all.
export function salvageJsonObject(raw) {
    const text = String(raw ?? '');
    const start = text.indexOf('{');
    if (start === -1) return null;
    const values = new Map();
    let i = start + 1;
    for (;;) {
        i = skipSpace(text, i);
        while (text[i] === ',') i = skipSpace(text, i + 1);
        if (i >= text.length) return { values, complete: false };
        if (text[i] === '}') return { values, complete: true };
        if (text[i] !== '"') return { values, complete: false };
        const keyEnd = stringEnd(text, i);
        if (keyEnd === -1) return { values, complete: false };
        const key = parseValue(text.slice(i, keyEnd));
        i = skipSpace(text, keyEnd);
        if (text[i] !== ':') return { values, complete: false };
        i = skipSpace(text, i + 1);
        if (i >= text.length) return { values, complete: false };
        if (text[i] === '[') {
            const items = [];
            values.set(key, items);
            i++;
            for (;;) {
                i = skipSpace(text, i);
                while (text[i] === ',') i = skipSpace(text, i + 1);
                if (i >= text.length) return { values, complete: false };
                if (text[i] === ']') {
                    i++;
                    break;
                }
                const end = valueEnd(text, i);
                if (end === -1) return { values, complete: false };
                const item = parseValue(text.slice(i, end));
                if (item !== undefined) items.push(item);
                i = end;
            }
            continue;
        }
        const end = valueEnd(text, i);
        if (end === -1) return { values, complete: false };
        const value = parseValue(text.slice(i, end).trim());
        if (value !== undefined) values.set(key, value);
        i = end;
    }
}

// "ar__compiled_facts", "compiled_facts", "Compiled_Facts" -> "compiled_facts":
// the answer's keys as the variable names they stand for (State Engine
// writes them with Archivist's namespace in front).
export const answerKey = (key) => String(key ?? '').trim().toLowerCase().replace(/^[a-z0-9]+__/, '');

// The compile answers `raw` holds for variables `names`:
// { answers: { name: value }, complete } with only the names it has a value
// for, or null when it has none.
export function salvageAnswer(raw, names) {
    const read = salvageJsonObject(raw);
    if (!read) return null;
    const byKey = new Map([...read.values].map(([key, value]) => [answerKey(key), value]));
    const answers = {};
    for (const name of names) {
        const value = byKey.get(answerKey(name));
        if (value !== undefined) answers[name] = value;
    }
    return Object.keys(answers).length ? { answers, complete: read.complete } : null;
}
