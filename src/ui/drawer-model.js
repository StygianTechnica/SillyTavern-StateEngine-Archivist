// What the Archivist drawer says, as plain functions of Archivist's state -
// kept apart from the DOM wiring (src/ui/settings-drawer.js) so it can be
// tested on its own.

// How many of the open chat's newest memories the drawer lists.
export const RECENT_COUNT = 5;

// The status line under "Enable Archivist", from getLiveHealth()
// (src/extraction/live.js) and the enabled switch: { text, error }.
export function statusLine(health, enabled) {
    if (!enabled) return { text: 'Off - memories are not stored from new replies. Stored memories stay available, and catch-up still works.', error: false };
    if (health?.state === 'error') {
        return { text: `Not working: ${health.error || 'State Engine refused the setup'}. Repair to try again.`, error: true };
    }
    return { text: 'On - memories are stored from each AI reply.', error: false };
}

// The "Last update" line, from getLastHarvest() (src/extraction/live.js):
// { text, error }.
export function lastHarvestLine(last, enabled) {
    if (!enabled) return { text: '', error: false };
    if (!last) return { text: 'Last update: no new memories from State Engine yet this session.', error: false };
    const time = new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const many = (n) => `${n} ${n === 1 ? 'memory' : 'memories'}`;
    if (last.outcome === 'stored') return { text: `Last update (${time}): stored ${many(last.stored)}.`, error: false };
    if (last.outcome === 'rejected') return { text: `Last update (${time}): received ${many(last.received)} but stored none - ${last.error}.`, error: true };
    return { text: `Last update (${time}): could not store ${many(last.received)} - ${last.error}.`, error: true };
}

// The catch-up status line, from getCatchUpProgress()
// (src/extraction/catch-up.js), as seen from the open chat: { text, error }.
export function catchUpLine(progress, openChatKey) {
    if (!progress) return { text: '', error: false };
    const many = (n) => `${n} ${n === 1 ? 'memory' : 'memories'}`;
    const where = progress.chatKey !== openChatKey ? ` for "${progress.chatId}"` : '';
    if (progress.running) {
        if (progress.cancelling) return { text: `Stopping after the chunk in progress${where}...`, error: false };
        if (!progress.total) return { text: `Getting ready${where}...`, error: false };
        const current = Math.min(progress.done + 1, progress.total);
        return { text: `Chunk ${current} of ${progress.total}${where} - ${many(progress.stored)} stored so far. You can keep chatting.`, error: false };
    }
    switch (progress.outcome) {
        case 'nothing':
            return { text: `Nothing to catch up${where} - every message already has its memories.`, error: false };
        case 'cancelled':
            return { text: `Cancelled${where}: ${many(progress.stored)} stored from ${progress.done} of ${progress.total} chunks. Run it again to continue.`, error: false };
        case 'failed':
            return { text: `Catch-up failed${where}: ${progress.lastError || 'see the browser console'}.`, error: true };
        default: {
            const failed = progress.failedChunks
                ? ` ${progress.failedChunks} of ${progress.total} chunks failed (${progress.lastError}) - run it again to retry them.`
                : '';
            return { text: `Done${where}: ${many(progress.stored)} stored from ${progress.messages} messages.${failed}`, error: progress.failedChunks > 0 };
        }
    }
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
