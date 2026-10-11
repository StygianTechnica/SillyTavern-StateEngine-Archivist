// What the Archivist drawer says, as plain functions of Archivist's state -
// kept apart from the DOM wiring (src/ui/settings-drawer.js) so it can be
// tested on its own.

// How many of the open chat's newest memories the drawer lists.
export const RECENT_COUNT = 5;

// The status line under "Enable Archivist", from getLiveHealth()
// (src/extraction/live.js) and the enabled switch: { text, error }.
export function statusLine(health, enabled) {
    if (!enabled) return { text: 'Off - no new memories are stored. Memories already stored stay available.', error: false };
    if (health?.state === 'error') {
        return { text: `Not working: ${health.error || 'State Engine refused the setup'}. Repair to try again.`, error: true };
    }
    return { text: 'On - memories are stored from each AI reply.', error: false };
}

// The line under "This chat": the open chat and how many memories it has.
export function chatSummary(chatOpen, count) {
    if (!chatOpen) return 'No chat open.';
    if (count === 0) return 'No memories stored for this chat yet.';
    const newest = Math.min(count, RECENT_COUNT);
    return `${count} ${count === 1 ? 'memory' : 'memories'} stored for this chat${count > newest ? ` - the newest ${newest}:` : ':'}`;
}

// The newest `n` records, newest first.
export function recentMemories(records, n = RECENT_COUNT) {
    return records.slice(-n).reverse();
}

// "long_term" -> "long term".
const words = (token) => String(token ?? '').replace(/_/g, ' ');

// One memory as the drawer shows it: { meta: ['secret', 'long term',
// 'high'], text, importance, title }.
export function memoryView(record) {
    const entities = record.entity_ids.length ? `\nAbout: ${record.entity_ids.join(', ')}` : '';
    return {
        meta: [words(record.subtype), words(record.scope), record.importance],
        text: record.text,
        importance: record.importance,
        title: `${record.text}\n\nType: ${words(record.subtype)} · Scope: ${words(record.scope)} · Importance: ${record.importance}${entities}\nFrom message: ${record.source_message_id}\nStored: ${record.created_at}`,
    };
}
