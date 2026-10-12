// An in-memory stand-in for the slice of the State Engine API Archivist
// calls, with the same signatures. Tests swap it in with:
//
//   vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));
//
// Value writes announce state_engine_variables_changed on the harness's
// SillyTavern event bus, the way State Engine does (asynchronously).

import { eventSource } from './st.js';

const OBJECT_TYPES = ['character', 'location', 'faction', 'item', 'creature', 'lore', 'quest', 'scene', 'event'];

export function createFakeStateEngine() {
    const presets = new Map();      // name -> { name, triggers, showInTracker, description, variables: Map(qualified -> def) }
    const active = new Map();       // chatId -> Set(presetName)
    const values = new Map();       // `${chatId}|${qualified}` -> value
    const objects = [];             // { id, type, names: [] }
    const calls = [];
    const statuses = new Map();     // `${namespace}.${name}` -> independent preset status

    const preset = (namespace, name) => presets.get(`${namespace}.${name}`);
    const qualified = (ref) => `${ref.namespace}__${ref.variableName}`;
    const log = (name, args) => calls.push({ name, args });

    const announce = (chatId) => queueMicrotask(() => void eventSource.emit('state_engine_variables_changed', chatId));

    const stateEngine = {
        listPresets(extensionId, instanceId, namespace) {
            return [...presets.values()].filter((p) => p.namespace === namespace).map((p) => ({ ...p, variables: Object.fromEntries(p.variables) }));
        },
        createPreset(extensionId, instanceId, def) {
            log('createPreset', [def]);
            if (preset(def.namespace, def.name)) return null;
            const created = { namespace: def.namespace, name: def.name, description: def.description ?? '', triggers: def.triggers ?? ['ai'], showInTracker: def.showInTracker ?? false, variables: new Map() };
            presets.set(`${def.namespace}.${def.name}`, created);
            return { id: `p_${def.name}`, ...created };
        },
        updatePreset(extensionId, instanceId, namespace, name, patch) {
            log('updatePreset', [namespace, name, patch]);
            const p = preset(namespace, name);
            if (!p) return null;
            if (patch.name && patch.name !== name) {
                if (preset(namespace, patch.name)) return null;
                presets.delete(`${namespace}.${name}`);
                presets.set(`${namespace}.${patch.name}`, p);
                // Chat activations follow the preset (State Engine keys them by preset id).
                for (const names of active.values()) if (names.delete(name)) names.add(patch.name);
            }
            Object.assign(p, patch);
            return p;
        },
        activatePreset(extensionId, instanceId, chatId, namespace, name) {
            log('activatePreset', [chatId, namespace, name]);
            const p = preset(namespace, name);
            if (!p || !chatId) return false;
            (active.get(chatId) ?? active.set(chatId, new Set()).get(chatId)).add(name);
            for (const [q, def] of p.variables) {
                if (!values.has(`${chatId}|${q}`)) values.set(`${chatId}|${q}`, structuredClone(def.defaultValue));
            }
            return true;
        },
        deactivatePreset(extensionId, instanceId, chatId, namespace, name) {
            log('deactivatePreset', [chatId, namespace, name]);
            active.get(chatId)?.delete(name);
            return true;
        },
        getVariable(extensionId, instanceId, ref) {
            return preset(ref.namespace, ref.presetName)?.variables.get(qualified(ref));
        },
        createVariable(extensionId, instanceId, def) {
            log('createVariable', [def]);
            const p = preset(def.namespace, def.presetName);
            const q = `${def.namespace}__${def.name}`;
            if (!p || p.variables.has(q)) return null;
            const stored = { ...def, name: q };
            p.variables.set(q, stored);
            return stored;
        },
        updateVariable(extensionId, instanceId, ref, patch) {
            log('updateVariable', [ref, patch]);
            const def = preset(ref.namespace, ref.presetName)?.variables.get(qualified(ref));
            if (!def) return null;
            Object.assign(def, patch, { name: def.name });
            return def;
        },
        getVariableValue(extensionId, instanceId, chatId, name) {
            const key = `${chatId}|${name}`;
            return values.has(key) ? { value: structuredClone(values.get(key)), def: null } : undefined;
        },
        setVariableValue(extensionId, instanceId, chatId, ref, value) {
            log('setVariableValue', [chatId, ref, value]);
            values.set(`${chatId}|${qualified(ref)}`, structuredClone(value));
            announce(chatId);
            return true;
        },
        createIndependentPreset(extensionId, instanceId, def) {
            const created = stateEngine.createPreset(extensionId, instanceId, { namespace: def.namespace, name: def.name, description: def.description });
            if (!created) return null;
            const p = preset(def.namespace, def.name);
            p.independentPreset = true;
            p.independentConfig = { ...def };
            delete p.independentConfig.namespace;
            delete p.independentConfig.name;
            return { ...created, independentPreset: true };
        },
        configureIndependentPreset(extensionId, instanceId, namespace, name, config) {
            log('configureIndependentPreset', [namespace, name, config]);
            const p = preset(namespace, name);
            if (!p) return null;
            p.independentConfig = { ...(p.independentConfig || {}), ...config };
            return p.independentConfig;
        },
        updateIndependentPresetContext(extensionId, instanceId, namespace, name, context) {
            const p = preset(namespace, name);
            if (!p) return null;
            p.independentConfig = { ...(p.independentConfig || {}), context };
            return true;
        },
        // What State Engine's run does, with the model played by
        // fakeEngine.respond(context, { chatId, preset }): it returns the
        // list to write into the preset's first prompted variable, an object
        // { qualifiedName: value } for several, or throws (the model call
        // failed).
        async runIndependentPreset(extensionId, instanceId, chatId, ref) {
            const p = preset(ref.namespace, ref.name);
            log('runIndependentPreset', [chatId, ref, p?.independentConfig?.context]);
            if (!p) return false;
            const record = (status) => { statuses.set(`${ref.namespace}.${ref.name}`, { lastRunAt: Date.now(), ...status }); };
            let answer;
            try {
                answer = await api.respond(p.independentConfig?.context, { chatId, preset: p });
            } catch (err) {
                record({ lastOutcome: 'skipped-parse-error', lastError: err.message });
                return false;
            }
            // A list fills the preset's first variable; an object maps
            // qualified variable names to values.
            // Like State Engine, only the preset's own variables are written.
            const writes = Array.isArray(answer) ? [[[...p.variables.keys()][0], answer]] : Object.entries(answer ?? {}).filter(([q]) => p.variables.has(q));
            for (const [q, value] of writes) values.set(`${chatId}|${q}`, structuredClone(value));
            announce(chatId);
            record({ lastOutcome: 'updated', lastError: null });
            return true;
        },
        getIndependentPresetStatus(namespace, name) {
            return statuses.get(`${namespace}.${name}`) ?? null;
        },
        listObjectTypes() {
            return OBJECT_TYPES.map((id) => ({ id }));
        },
        getObject(extensionId, instanceId, chatId, id) {
            const found = objects.find((o) => o.id === id);
            return found ? { id: found.id, type: found.type, name: found.names[0], aliases: found.names.slice(1) } : null;
        },
        getObjectByAlias(extensionId, instanceId, chatId, type, name) {
            const wanted = name.toLowerCase();
            return objects.find((o) => o.type === type && o.names.some((n) => n.toLowerCase() === wanted)) ?? null;
        },
    };

    const api = {
        stateEngine,
        calls,
        // The model for independent preset runs - replace per test.
        respond: async () => [],
        presets,
        isActive: (chatId, name) => active.get(chatId)?.has(name) ?? false,
        addObject: (id, type, ...names) => objects.push({ id, type, names }),
        // What State Engine's prompted update does: writes the model's answer.
        writeValue(chatId, qualifiedName, value) {
            values.set(`${chatId}|${qualifiedName}`, structuredClone(value));
            announce(chatId);
        },
        readValue: (chatId, qualifiedName) => values.get(`${chatId}|${qualifiedName}`),
    };
    return api;
}

export let fake = createFakeStateEngine();

export function resetFakeStateEngine() {
    fake = createFakeStateEngine();
    return fake;
}
