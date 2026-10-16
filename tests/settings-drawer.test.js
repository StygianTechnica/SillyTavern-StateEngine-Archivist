// @vitest-environment jsdom
//
// The Archivist drawer, driven the way a user would: the real settings.html,
// the real memory core and live extraction, against the SillyTavern and
// State Engine stand-ins.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getContext, openChat } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { startLiveExtraction, LIVE_PRESET } from '../src/extraction/live.js';
import { addSettingsDrawer } from '../src/ui/settings-drawer.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const TEMPLATE = readFileSync(resolve(process.cwd(), 'settings.html'), 'utf8');
const $ = (id) => document.getElementById(id);
const waitFor = (check) => vi.waitFor(check, { timeout: 1000, interval: 5 });
let fake;

const item = (text, extra = {}) => ({ text, subtype: 'event', scope: 'scene', importance: 'medium', source_message_id: 'Chat A#1@d', ...extra });

beforeEach(async () => {
    fake = resetFakeStateEngine();
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    globalThis.toastr = { success: vi.fn(), info: vi.fn(), warning: vi.fn() };
    const context = getContext();
    context.renderExtensionTemplateAsync = vi.fn(async () => TEMPLATE);
    context.eventTypes.CHAT_CHANGED = 'chat_id_changed';
    context.eventSource.on('chat_id_changed', () => void loadCurrentChat());
    context.chat = [{ is_user: false, mes: 'hi', send_date: 'd' }];
    await loadCurrentChat();
});

async function openDrawer() {
    await startLiveExtraction();
    await addSettingsDrawer();
}

describe('the Archivist drawer', () => {
    it('is added once, from settings.html, into the extensions settings', async () => {
        await openDrawer();
        await addSettingsDrawer();
        expect(document.querySelectorAll('#archivist_settings')).toHaveLength(1);
        expect(getContext().renderExtensionTemplateAsync).toHaveBeenCalledWith(expect.stringMatching(/^third-party\//), 'settings');
    });

    it('starts off, saying so, with no Repair button', async () => {
        await openDrawer();
        expect($('ar_enabled').checked).toBe(false);
        expect($('ar_status').textContent).toMatch(/^Off/);
        expect($('ar_repair').hidden).toBe(true);
    });

    it('Enable Archivist switches live extraction on for this chat, and off again', async () => {
        await openDrawer();
        $('ar_enabled').checked = true;
        $('ar_enabled').dispatchEvent(new Event('change'));
        await waitFor(() => expect($('ar_status').textContent).toMatch(/^On/));
        expect(getSettings().enabled).toBe(true);
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);
        expect($('ar_repair').hidden).toBe(false);

        $('ar_enabled').checked = false;
        $('ar_enabled').dispatchEvent(new Event('change'));
        await waitFor(() => expect($('ar_status').textContent).toMatch(/^Off/));
        expect(getSettings().enabled).toBe(false);
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(false);
    });

    it('shows a setup failure, and Repair fixes it', async () => {
        getSettings().enabled = true;
        const create = fake.stateEngine.createPreset;
        fake.stateEngine.createPreset = () => null;
        await openDrawer();
        expect($('ar_status').textContent).toMatch(/^Not working: could not create the Archivist Recent Memory Collection preset/);
        expect($('ar_status').classList.contains('ar-status-error')).toBe(true);

        fake.stateEngine.createPreset = create;
        $('ar_repair').click();
        await waitFor(() => expect($('ar_status').textContent).toMatch(/^On/));
        expect($('ar_status').classList.contains('ar-status-error')).toBe(false);
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);
        expect(toastr.success).toHaveBeenCalled();
    });

    it('lists this chat\'s newest memories, and updates as memories are stored', async () => {
        await openDrawer();
        await waitFor(() => expect($('ar_chat_info').textContent).toBe('No memories stored for this chat yet.'));

        await addMemoryRecords(getCurrentChatRef(), [item('first'), item('second', { importance: 'high', subtype: 'secret', scope: 'long_term' })]);
        await waitFor(() => expect($('ar_chat_info').textContent).toBe('2 memories stored for this chat:'));
        const rows = [...document.querySelectorAll('#ar_recent .ar-memory')];
        expect(rows.map((r) => r.querySelector('.ar-memory-text').textContent)).toEqual(['second', 'first']);
        expect(rows[0].classList.contains('ar-importance-high')).toBe(true);
        expect(rows[0].querySelector('.ar-memory-meta').textContent).toBe('secretlong termhigh');
    });

    it('shows memory text as text, never as markup', async () => {
        await openDrawer();
        await addMemoryRecords(getCurrentChatRef(), [item('<img src=x onerror=alert(1)>')]);
        await waitFor(() => expect(document.querySelector('#ar_recent .ar-memory-text').textContent).toBe('<img src=x onerror=alert(1)>'));
        expect(document.querySelector('#ar_recent img')).toBeNull();
    });

    it('Review memories opens the memory browser', async () => {
        await openDrawer();
        $('ar_open_browser').click();
        await waitFor(() => expect(document.querySelector('.ar-mb-overlay')?.hidden).toBe(false));
        document.querySelector('[data-mb="close"]').click();
    });

    it('shows what happened to the last memories State Engine sent', async () => {
        getSettings().enabled = true;
        await openDrawer();
        expect($('ar_last_harvest').textContent).toBe('Last update: no new memories from State Engine yet this session.');

        fake.writeValue('Chat A', 'ar__memories', [{ text: 'Mira laughed.' }, { text: 'Mira left.' }]);
        await waitFor(() => expect($('ar_last_harvest').textContent).toMatch(/^Last update \(.+\): stored 2 memories\.$/));
        expect($('ar_last_harvest').classList.contains('ar-status-error')).toBe(false);
    });

    it('offers State Engine\'s connection or any connection profile for catch-up, and saves the choice', async () => {
        getContext().extensionSettings.connectionManager = { profiles: [{ id: 'p1', name: 'Big Model' }] };
        await openDrawer();
        const select = $('ar_connection');
        expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([['', 'Same as State Engine'], ['p1', 'Big Model']]);
        select.value = 'p1';
        select.dispatchEvent(new Event('change'));
        expect(getSettings().connectionProfileId).toBe('p1');
    });

    it('keeps catch-up numbers within limits', async () => {
        await openDrawer();
        const chunk = $('ar_chunk_size');
        expect(chunk.value).toBe('50');
        chunk.value = '1';
        chunk.dispatchEvent(new Event('change'));
        expect(getSettings().chunkSize).toBe(5);
        expect(chunk.value).toBe('5');
    });

    it('runs catch-up for this chat and shows its progress, then the result', async () => {
        getContext().chat = [{ is_user: true, name: 'User', mes: 'hello', send_date: 'd0' }, { is_user: false, name: 'Mira', mes: 'Mira waves.', send_date: 'd1' }];
        fake.respond = async () => [{ text: 'Mira waved hello.', message_index: 1 }];
        await openDrawer();
        expect($('ar_catchup_cancel').hidden).toBe(true);
        $('ar_catchup_run').click();
        await waitFor(() => expect($('ar_catchup_status').textContent).toBe('Done: 1 memory stored from 2 messages.'));
        expect($('ar_catchup_run').hidden).toBe(false);
        expect($('ar_catchup_cancel').hidden).toBe(true);
        await waitFor(() => expect($('ar_chat_info').textContent).toBe('1 memory stored for this chat:'));
    });

    it('compiles this chat on Compile now and shows when it did', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('Lucian works at the gym')]);
        fake.respond = async () => ({ ar__compiled_facts: [{ text: 'Lucian works at the gym.', classification: 'PERMANENT', sources: ['m1'] }], ar__compiled_relationships: [] });
        await openDrawer();
        await waitFor(() => expect($('ar_compile_status').textContent).toBe('Not compiled yet.'));
        $('ar_compile_now').click();
        await waitFor(() => expect($('ar_compile_status').textContent).toMatch(/^Compiled .+ · up to date\.$/));
    });

    it('saves the compiler settings', async () => {
        await openDrawer();
        $('ar_compile_auto').checked = false;
        $('ar_compile_auto').dispatchEvent(new Event('change'));
        $('ar_compile_threshold').value = '25';
        $('ar_compile_threshold').dispatchEvent(new Event('change'));
        expect($('ar_compile_world').checked).toBe(true);
        $('ar_compile_world').checked = false;
        $('ar_compile_world').dispatchEvent(new Event('change'));
        expect(getSettings()).toMatchObject({ compileAuto: false, compileThreshold: 25, compileWorld: false });
    });

    it('follows chat changes', async () => {
        await openDrawer();
        await addMemoryRecords(getCurrentChatRef(), [item('alice memory')]);
        await waitFor(() => expect($('ar_chat_info').textContent).toBe('1 memory stored for this chat:'));

        openChat({ chatId: 'Bob Chat', characterId: 1 });
        await getContext().eventSource.emit('chat_id_changed');
        await waitFor(() => expect($('ar_chat_info').textContent).toBe('No memories stored for this chat yet.'));
        expect($('ar_recent').children).toHaveLength(0);

        openChat({ chatId: undefined });
        await getContext().eventSource.emit('chat_id_changed');
        await waitFor(() => expect($('ar_chat_info').textContent).toBe('No chat open.'));
    });
});
