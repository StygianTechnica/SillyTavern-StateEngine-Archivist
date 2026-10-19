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

// State Engine's answer size below this leaves too little room for the
// memories next to the other variables of the per-message update.
export const MIN_RESPONSE_TOKENS = 1000;

// The token limit State Engine's per-message update runs with, from its
// settings (extensionSettings.state_engine): its connection profile's Max
// tokens when it uses one and that is set, else Max response length
// (default 300) - the same order State Engine's background-llm.js uses.
export function updateTokenLimit(seSettings) {
    if (seSettings?.stateEngineProfileId && Number(seSettings.stateEngineMaxTokens) > 0) return Number(seSettings.stateEngineMaxTokens);
    return Number(seSettings?.responseLength) || 300;
}

// A warning while Archivist is on and that limit is too small: { text,
// error } ('' when fine).
export function tokenLimitLine(seSettings, enabled) {
    const limit = updateTokenLimit(seSettings);
    if (!enabled || limit >= MIN_RESPONSE_TOKENS) return { text: '', error: false };
    const where = seSettings?.stateEngineProfileId && Number(seSettings.stateEngineMaxTokens) > 0 ? 'its connection profile\'s Max tokens' : 'Max response length';
    return {
        text: `State Engine's answers are limited to ${limit} tokens (${where}, in State Engine's settings). Memories need room next to your other variables - an answer cut off at the limit loses whatever it was still writing. Around ${MIN_RESPONSE_TOKENS}-1200 is safer.`,
        error: true,
    };
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
// The failed chunks of a pass as message ranges: "#40-#49, #120-#129".
export function failedRanges(progress) {
    return (progress?.failures ?? []).map((f) => (f.from === f.to ? `#${f.from}` : `#${f.from}-#${f.to}`)).join(', ');
}

// The failed chunks of a pass as text to copy and send on: each one's
// messages, why it failed, and what the model wrote when it could not be
// read.
export function failuresReport(progress) {
    return (progress?.failures ?? []).map((f) => [
        `Messages ${f.from === f.to ? `#${f.from}` : `#${f.from}-#${f.to}`}: ${f.error}`,
        f.response ?? '(the response was not kept)',
    ].join('\n')).join('\n\n-----\n\n');
}

// A memory rebuild's line (catch-up.js startCatchUp({ rebuild: true })).
export function rebuildLine(progress, openChatKey) {
    if (!progress) return { text: '', error: false };
    const many = (n) => `${n} ${n === 1 ? 'memory' : 'memories'}`;
    const where = progress.chatKey !== openChatKey ? ` for "${progress.chatId}"` : '';
    if (progress.running) {
        if (progress.cancelling) return { text: `Stopping the memory rebuild after the chunk in progress${where}...`, error: false };
        if (!progress.total) return { text: `Getting ready to rebuild the memories${where}...`, error: false };
        const current = Math.min(progress.done + 1, progress.total);
        return { text: `Rebuilding memories${where}: chunk ${current} of ${progress.total} - ${many(progress.stored)} so far. You can keep chatting.`, error: false };
    }
    switch (progress.outcome) {
        case 'nothing':
            return { text: `Nothing to rebuild${where} - the chat has no messages to read.`, error: false };
        case 'cancelled':
            return { text: `Memory rebuild stopped${where} after ${progress.done} of ${progress.total} chunks - the rest keep their old memories. Continue reads only those.`, error: false };
        case 'failed':
            return { text: `The memory rebuild failed${where}: ${progress.lastError || 'see the browser console'}. The old memories are kept.`, error: true };
        default: {
            const failed = progress.failedChunks
                ? ` ${progress.failedChunks} of ${progress.total} chunks failed (messages ${failedRanges(progress)}: ${progress.lastError}) and kept their old memories - Continue retries only those, then recompiles.`
                : '';
            const compile = progress.compileStarted ? ' The compiled memory is being rebuilt from them - see the Compiled view.' : '';
            return { text: `Memories rebuilt${where}: ${many(progress.stored)} from ${progress.messages} messages.${failed}${compile}`, error: progress.failedChunks > 0 };
        }
    }
}

export function catchUpLine(progress, openChatKey) {
    if (!progress) return { text: '', error: false };
    if (progress.rebuild) return rebuildLine(progress, openChatKey);
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
                ? ` ${progress.failedChunks} of ${progress.total} chunks failed (messages ${failedRanges(progress)}: ${progress.lastError}) - run it again to retry them.`
                : '';
            return { text: `Done${where}: ${many(progress.stored)} stored from ${progress.messages} messages.${failed}`, error: progress.failedChunks > 0 };
        }
    }
}

// The compiler status line: { text, error }. `status`: getCompilerStatus()
// (src/compiler/compiler.js); `compiled`: { at, pending } for the open chat,
// or null when it was never compiled.
export function compilerLine(status, compiled) {
    const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (status?.running) {
        const part = status.batches > 1 ? ` - part ${status.batch} of ${status.batches}` : '';
        const world = status.part === 'world' ? ' (threads and world)' : '';
        return { text: `${status.rebuild ? 'Rebuilding' : 'Compiling'}${part}${world}...`, error: false };
    }
    if (status?.outcome === 'failed') return { text: `The last compile failed: ${status.error || 'see the browser console'}.`, error: true };
    if (!compiled) return { text: 'Not compiled yet.', error: false };
    const pending = compiled.pending ? ` · ${compiled.pending} new ${compiled.pending === 1 ? 'memory' : 'memories'} since` : ' · up to date';
    const cutOff = status?.outcome === 'compiled' && status.cutOff
        ? ` ${status.cutOff === 1 ? 'One answer was' : `${status.cutOff} answers were`} cut off by the model's token limit - the complete items were saved.`
        : '';
    return { text: `Compiled ${time(compiled.at)}${pending}.${cutOff}`, error: false };
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
