import { archivistApi, exposeArchivistApi } from '../src/public-api.js';
import { addMemoryRecords, loadCurrentChat } from '../src/memory/archivist.js';
import { getCurrentChatRef } from '../src/memory/registry.js';

describe('public API', () => {
    it('exposes exactly the three query APIs, the compiled memory, the dossier, the change events and forgetChat', () => {
        expect(Object.keys(archivistApi).sort()).toEqual([
            'COMPILED_CHANGED_EVENT', 'MEMORIES_CHANGED_EVENT', 'PHRASE_TICS_CHANGED_EVENT', 'forgetChat', 'getAllMemories', 'getCompiledMemory', 'getEntityDossier', 'getMemoriesBySubtype',
            'getMemoriesForEntity', 'getPhraseTics', 'getRelationship',
        ]);
        expect(Object.isFrozen(archivistApi)).toBe(true);
    });

    it('is published as window.StateEngineArchivist', async () => {
        delete window.StateEngineArchivist;
        exposeArchivistApi();
        await loadCurrentChat();
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'hello', subtype: 'fact', entity_ids: ['chr_a'], source_message_id: 'Chat A#0@x' }]);

        expect(window.StateEngineArchivist.getMemoriesForEntity('chr_a').map((r) => r.text)).toEqual(['hello']);
        expect(window.StateEngineArchivist.getMemoriesBySubtype('fact')).toHaveLength(1);
        expect(await window.StateEngineArchivist.getAllMemories('Chat A')).toHaveLength(1);
    });

    it('forgets a chat on request, and says false when there was nothing', async () => {
        exposeArchivistApi();
        await loadCurrentChat();
        const ref = getCurrentChatRef();
        await addMemoryRecords(ref, [{ text: 'hello', subtype: 'fact', entity_ids: ['chr_a'], source_message_id: 'Chat A#0@x' }]);
        const key = ref.groupId ? `group:${ref.groupId}:${ref.chatId}` : `char:${ref.characterAvatar}:${ref.chatId}`;
        expect(await window.StateEngineArchivist.forgetChat(key)).toBe(true);
        expect(await window.StateEngineArchivist.getAllMemories('Chat A')).toHaveLength(0);
        expect(await window.StateEngineArchivist.forgetChat('char:nobody.png:x')).toBe(false);
    });
});
