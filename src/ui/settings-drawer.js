// The Archivist drawer in SillyTavern's Extensions settings: the Enable
// Archivist switch, live extraction's status (with a Repair button), and the
// open chat's newest memories. Rendered from settings.html and appended to
// #extensions_settings2, the same way State Engine's, Curator's and Pretty
// Panels' drawers are. What it says comes from src/ui/drawer-model.js; this
// file only wires it to the page.

import { LOG_PREFIX } from '../constants.js';
import { getSettings } from '../settings.js';
import { getAllMemories, MEMORIES_CHANGED_EVENT } from '../memory/archivist.js';
import { getCurrentChatRef } from '../memory/registry.js';
import { getLiveHealth, onLiveHealthChange, repairLiveExtraction, setArchivistEnabled } from '../extraction/live.js';
import { statusLine, chatSummary, recentMemories, memoryView } from './drawer-model.js';

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

    onLiveHealthChange(renderStatus);
    const { eventSource, eventTypes } = SillyTavern.getContext();
    eventSource.on(MEMORIES_CHANGED_EVENT, refreshChat);
    eventSource.on(eventTypes.CHAT_CHANGED, refreshChat);

    renderStatus();
    refreshChat();
}
