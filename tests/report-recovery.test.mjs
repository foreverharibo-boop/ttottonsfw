import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const report = heat => ({ location: 'Room', characters: { A: { clothing: 'Coat', position: 'Standing', contact: 'None' } }, acts: ['Read the note'], heat, next: ['Check the timetable'] });
const message = mes => ({ mes, is_user: false });
function setup({ autoRefine = false, mode = 'auto', heat = 8, fail = false } = {}) {
    const timers = new Map(); let timerId = 0, calls = 0;
    const context = {
        chat: [message('Current test reply.')],
        chatMetadata: { ttottoNsfw: { chatSchemaVersion: 1, enabled: true } },
        extensionSettings: { 'ttotto-nsfw': { settingsSchemaVersion: 3, enabled: true, adultConfirmed: true, autoRefine, armMode: mode, slowBurnEnabled: false } },
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, saveChat() {}, setExtensionPrompt() {},
        async generateRaw() { calls++; if (fail) throw new Error('Unavailable'); return JSON.stringify(report(heat)); },
    };
    const env = { SillyTavern: { getContext: () => context }, URL, structuredClone, AbortController,
        document: { getElementById: () => null }, window: {}, console: { log() {}, warn() {}, error() {}, debug() {} },
        toastr: { info() {}, warning() {}, error() {}, success() {} },
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    };
    vm.createContext(env);
    const script = source.slice(0, source.indexOf('const bootContext = getContext();'))
        .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
    vm.runInContext(script + '\nglobalThis.api={getSettings,getChatMeta,handleIncomingMessage,effectiveState,stateForDisplay,runRefine,scheduleAutoRefine,autoRefineNeeded,isFullyArmed};', env);
    env.api.getSettings(); env.api.getChatMeta();
    return { env, api: env.api, context, timers, get calls() { return calls; }, get meta() { return context.chatMetadata.ttottoNsfw; } };
}

test('latest missing report never presents the previous temperature as current', () => {
    const r = setup();
    r.context.chat[0].mes += '<scene_state>{"heat":5}</scene_state>';
    r.api.handleIncomingMessage(0);
    assert.equal(r.api.effectiveState().state.heat, 5);
    r.context.chat.push(message('New reply without a report.'));
    r.api.handleIncomingMessage(1);
    assert.equal(r.api.effectiveState().source, 'missing-report');
    assert.equal(r.api.effectiveState().state, null);
    assert.equal(r.api.stateForDisplay().state, null);
    assert.equal(r.timers.size, 0);
    assert.equal(r.calls, 0);
});

test('manual repair applies recovered heat immediately without enabling automatic calls', async () => {
    const r = setup();
    assert.equal(await r.api.runRefine({ manual: true }), true);
    assert.equal(r.calls, 1);
    assert.equal(r.api.isFullyArmed(), true);
    assert.equal(r.meta.armSource, 'heat');
    assert.equal(r.api.effectiveState().state.heat, 8);
    assert.equal(r.api.effectiveState().source, 'ai-refine');
    assert.equal(r.api.getSettings().autoRefine, false);
    assert.equal(r.timers.size, 0);
});

test('a recovered low temperature stays in monitoring', async () => {
    const r = setup({ heat: 2 });
    assert.equal(await r.api.runRefine({ manual: true }), true);
    assert.equal(r.api.isFullyArmed(), false);
    assert.equal(r.api.effectiveState().state.heat, 2);
});

test('enabled monitoring repair schedules once and applies its result', async () => {
    const r = setup({ autoRefine: true });
    r.api.handleIncomingMessage(0); r.api.handleIncomingMessage(0);
    assert.equal(r.timers.size, 1);
    assert.equal(await r.api.runRefine(), true);
    r.api.handleIncomingMessage(0); r.api.scheduleAutoRefine();
    assert.equal(r.calls, 1);
    assert.equal(r.timers.size, 0);
    assert.equal(r.api.isFullyArmed(), true);
});

test('failed automatic repair does not loop on repeated render events', async () => {
    const r = setup({ autoRefine: true, fail: true });
    r.api.handleIncomingMessage(0);
    assert.equal(await r.api.runRefine(), false);
    for (let i = 0; i < 5; i++) r.api.handleIncomingMessage(0);
    assert.equal(await r.api.runRefine(), false);
    assert.equal(r.calls, 1);
    assert.equal(r.timers.size, 0);
    assert.equal(await r.api.runRefine({ manual: true }), false);
    assert.equal(r.calls, 2);
});

test('idle stealth and valid low-temperature monitoring do not schedule unnecessary repairs', () => {
    const stealth = setup({ autoRefine: true, mode: 'stealth' });
    stealth.api.handleIncomingMessage(0);
    assert.equal(stealth.timers.size, 0);
    const low = setup({ autoRefine: true });
    low.context.chat[0].mes += '<scene_state>{"heat":2}</scene_state>';
    low.api.handleIncomingMessage(0);
    assert.equal(low.timers.size, 0);
});

test('repaired state expires for a changed body, new swipe, or next reply', async () => {
    const r = setup();
    await r.api.runRefine({ manual: true });
    r.context.chat[0].mes = 'Edited test reply.';
    assert.equal(r.api.effectiveState().source, 'body-changed');
    assert.equal(r.api.effectiveState().state, null);
    assert.equal(r.api.stateForDisplay().state.heat, 8);
    r.context.chat[0].swipe_id = 1;
    assert.equal(r.api.stateForDisplay().state, null);
    r.context.chat.push(message('Next test reply.'));
    assert.equal(r.api.effectiveState().state, null);
});

test('a reply changed during repair cannot receive an outdated result', async () => {
    const r = setup(); let finish;
    r.context.generateRaw = () => new Promise(resolve => { finish = resolve; });
    const request = r.api.runRefine({ manual: true });
    r.context.chat[0].swipe_id = 1;
    finish(JSON.stringify(report(8)));
    assert.equal(await request, false);
    assert.equal(r.context.chat[0].extra, undefined);
    assert.equal(r.api.isFullyArmed(), false);
});
