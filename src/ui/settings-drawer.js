// The Archivist drawer in SillyTavern's Extensions settings: the Enable
// Archivist switch, live extraction's status (with a Repair button), and the
// open chat's newest memories. Rendered from settings.html and appended to
// #extensions_settings2, the same way State Engine's, Curator's and Pretty
// Panels' drawers are. What it says comes from src/ui/drawer-model.js; this
// file only wires it to the page.

import { LOG_PREFIX } from '../constants.js';
import { getSettings, saveSettings } from '../settings.js';
import { getAllMemories, MEMORIES_CHANGED_EVENT } from '../memory/archivist.js';
import { getCurrentChatRef, chatKeyFor } from '../memory/registry.js';
import { getLiveHealth, onLiveHealthChange, repairLiveExtraction, setArchivistEnabled, getLastHarvest, onHarvest } from '../extraction/live.js';
import { statusLine, chatSummary, recentMemories, memoryView, lastHarvestLine, catchUpLine } from './drawer-model.js';
import { startCatchUp, cancelCatchUp, getCatchUpProgress, onCatchUpProgress, isCatchUpRunning } from '../extraction/catch-up.js';
import { listConnectionProfiles } from './connection-profiles.js';
import { openMemoryBrowser } from './memory-browser.js';

// SillyTavern resolves extension templates relative to
// public/scripts/extensions/, i.e. "third-party/<folder name>". Derived
// from this file's own URL so a renamed install folder still works.
const EXTENSION_FOLDER = decodeURIComponent(new URL('../../', import.meta.url).pathname.split('/').filter(Boolean).pop());
const TEMPLATE_PATH = `third-party/${EXTENSION_FOLDER}`;

const byId = (id) => document.getElementById(id);

function renderStatus() {
    const enabled = getSettings().enabled === true;
    const health = getLiveHealth();
    const { text, error } = statusLine(health, enabled);
    const status = byId('ar_status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('ar-status-error', error);
    byId('ar_enabled').checked = enabled;
    // Repair is for a switched-on Archivist (off, there is nothing to fix).
    byId('ar_repair').hidden = !enabled;
    const last = lastHarvestLine(getLastHarvest(), enabled);
    const lastEl = byId('ar_last_harvest');
    lastEl.textContent = last.text;
    lastEl.hidden = !last.text;
    lastEl.classList.toggle('ar-status-error', last.error);
}

function memoryRow(record) {
    const view = memoryView(record);
    const row = document.createElement('div');
    row.className = `ar-memory ar-importance-${view.importance}`;
    row.title = view.title;
    const meta = document.createElement('div');
    meta.className = 'ar-memory-meta';
    for (const part of view.meta) {
        const span = document.createElement('span');
        span.textContent = part;
        meta.append(span);
    }
    const text = document.createElement('div');
    text.className = 'ar-memory-text';
    text.textContent = view.text;
    row.append(meta, text);
    return row;
}

// ---- catch-up

function fillConnections() {
    const select = byId('ar_connection');
    if (!select) return;
    const chosen = getSettings().connectionProfileId || '';
    const options = [{ id: '', name: 'Same as State Engine' }, ...listConnectionProfiles()];
    if (chosen && !options.some((o) => o.id === chosen)) options.push({ id: chosen, name: '(profile no longer exists)' });
    select.replaceChildren(...options.map((o) => {
        const option = document.createElement('option');
        option.value = o.id;
        option.textContent = o.name;
        return option;
    }));
    select.value = chosen;
}

function renderCatchUp() {
    const status = byId('ar_catchup_status');
    if (!status) return;
    const ref = getCurrentChatRef();
    const running = isCatchUpRunning();
    const line = catchUpLine(getCatchUpProgress(), ref ? chatKeyFor(ref) : null);
    status.textContent = line.text;
    status.hidden = !line.text;
    status.classList.toggle('ar-status-error', line.error);
    byId('ar_catchup_run').hidden = running;
    byId('ar_catchup_run').dataset.disabled = ref ? 'false' : 'true';
    byId('ar_catchup_run').title = ref ? 'Extract memories from this chat\'s earlier messages' : 'Open a chat first';
    byId('ar_catchup_cancel').hidden = !running;
}

// A number field bound to a setting, kept within [min, max].
function bindNumber(id, key, min, max) {
    const input = byId(id);
    input.value = String(getSettings()[key]);
    input.addEventListener('change', () => {
        const value = Math.min(max, Math.max(min, Math.round(Number(input.value)) || getSettings()[key]));
        getSettings()[key] = value;
        input.value = String(value);
        saveSettings();
    });
}

function wireCatchUp() {
    fillConnections();
    const select = byId('ar_connection');
    // Profiles can be added or renamed while the page is open.
    select.addEventListener('focus', fillConnections);
    select.addEventListener('change', () => {
        getSettings().connectionProfileId = select.value;
        saveSettings();
    });
    bindNumber('ar_chunk_size', 'chunkSize', 5, 200);
    bindNumber('ar_catchup_tokens', 'catchUpMaxTokens', 300, 16000);
    byId('ar_catchup_run').addEventListener('click', async () => {
        if (byId('ar_catchup_run').dataset.disabled === 'true') return;
        if (!await startCatchUp()) toastr.info('Catch-up is already running, or no chat is open.', 'Archivist');
    });
    byId('ar_catchup_cancel').addEventListener('click', () => cancelCatchUp());
    onCatchUpProgress(renderCatchUp);
    renderCatchUp();
}

let chatToken = 0;

async function renderChat() {
    const token = ++chatToken;
    const chatOpen = !!getCurrentChatRef();
    const records = chatOpen ? await getAllMemories() : [];
    // A newer render (another change, a chat switch) already started.
    if (token !== chatToken || !byId('ar_chat_info')) return;
    byId('ar_chat_info').textContent = chatSummary(chatOpen, records.length);
    byId('ar_recent').replaceChildren(...recentMemories(records).map(memoryRow));
}

// Re-renders the "This chat" section. Never throws.
function refreshChat() {
    void renderChat().catch((err) => console.warn(LOG_PREFIX, 'could not show this chat\'s memories', err));
}

// Adds the drawer once. Call after the memory core and live extraction
// have started.
export async function addSettingsDrawer() {
    if (byId('archivist_settings')) return;

    let html;
    try {
        html = await SillyTavern.getContext().renderExtensionTemplateAsync(TEMPLATE_PATH, 'settings');
    } catch (err) {
        console.error(LOG_PREFIX, 'failed to load settings.html template', err);
        return;
    }
    const container = byId('extensions_settings2');
    if (!container) return;
    container.insertAdjacentHTML('beforeend', html);

    const enabledBox = byId('ar_enabled');
    enabledBox.addEventListener('change', async () => {
        enabledBox.disabled = true;
        try {
            await setArchivistEnabled(enabledBox.checked);
        } finally {
            enabledBox.disabled = false;
            renderStatus();
        }
    });

    const repair = byId('ar_repair');
    repair.addEventListener('click', async () => {
        if (repair.dataset.busy === 'true') return;
        repair.dataset.busy = 'true';
        try {
            const health = await repairLiveExtraction();
            if (health.state === 'ok') toastr.success('Archivist\'s State Engine preset is set up and active for this chat.', 'Archivist');
        } finally {
            delete repair.dataset.busy;
            renderStatus();
        }
    });

    byId('ar_open_browser').addEventListener('click', () => void openMemoryBrowser());
    wireCatchUp();

    onLiveHealthChange(renderStatus);
    onHarvest(renderStatus);
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(MEMORIES_CHANGED_EVENT, refreshChat);
    eventSource.on(eventTypes.CHAT_CHANGED, refreshChat);
    eventSource.on(eventTypes.CHAT_CHANGED, renderCatchUp);

    renderStatus();
    refreshChat();
}
