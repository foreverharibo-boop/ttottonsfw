import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const nsfw = source.includes("const MODULE_NAME = 'ttotto-nsfw'");
const moduleName = nsfw ? 'ttotto-nsfw' : 'ttotto-sfw';
const metaKey = nsfw ? 'ttottoNsfw' : 'ttottoSfw';
const promptKey = nsfw ? 'ttotto_nsfw_continuity' : 'ttotto_sfw_continuity';
const tag = nsfw ? 'scene_state' : 'sfw_scene';
const report = { location: 'Room', characters: { A: { appearance: 'Coat', clothing: 'Coat', position: 'Chair', holding: 'Book', condition: 'Calm', contact: 'None' } },
    acts: ['Discussed the plan'], next: ['Read the note'], heat: 8, intensity: 8, stage: 5 };
function setup(persisted = null) {
    const prompts = {};
    const settings = { settingsSchemaVersion: 4, enabled: true, adultConfirmed: true, armMode: 'auto', autoRefine: false, slowBurnEnabled: true };
    let calls = 0;
    const context = { chat: [], chatMetadata: { [metaKey]: { chatSchemaVersion: 1, enabled: true, autoArmed: true, armSource: 'heat' } },
        extensionSettings: { [moduleName]: settings }, setExtensionPrompt(key, value) { prompts[key] = value; },
        saveSettingsDebounced() {}, saveMetadataDebounced() {}, saveChat() {}, generateRaw() { calls++; throw Error('Unexpected AI call'); } };
    if (persisted) {
        context.chat = JSON.parse(JSON.stringify(persisted.chat));
        context.chatMetadata = JSON.parse(JSON.stringify(persisted.chatMetadata));
    }
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false, hidden: false, querySelector: () => null, closest: () => null });
        return nodes.get(id);
    };
    const document = { getElementById: () => null };
    const env = { SillyTavern: { getContext: () => context }, URL, structuredClone, AbortController, document, window: {},
        console: { log() {}, warn() {}, error() {}, debug() {} }, toastr: { info() {}, warning() {}, success() {}, error() {} },
        setTimeout() { return 1; }, clearTimeout() {} };
    vm.createContext(env);
    const script = source.slice(0, source.indexOf('const bootContext = getContext();'))
        .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
    vm.runInContext(script + '\nglobalThis.api={getSettings,getChatMeta,handleIncomingMessage,effectiveState,prepareSceneInjection,slowBurnStageInfo,slowBurnProgress,renderSlowBurnPanel,snapshotForMessage,buildSlowBurnLines,diagnosticState,diagnosticReport};', env);
    const api = env.api; api.getSettings(); api.getChatMeta();
    function receive(state = report, body = 'Current reply.' + 'X'.repeat(40)) {
        context.chat.push({ mes: body + `<${tag}>${JSON.stringify(state)}</${tag}>`, is_user: false });
        api.handleIncomingMessage(context.chat.length - 1);
        return context.chat.at(-1);
    }
    function prepare() { api.prepareSceneInjection({ generationType: 'normal' }); return prompts[promptKey]; }
    return { api, context, settings, receive, prepare, node, document, get calls() { return calls; }, get meta() { return context.chatMetadata[metaKey]; } };
}

test('invalidating a saved stage five never injects a stage-one cap; a new valid report restores progression', () => {
    const r = setup(), message = r.receive();
    assert.match(r.prepare(), /CURRENT STAGE 5\/6/);
    message.mes = message.mes.slice(0, -40);
    r.api.handleIncomingMessage(0);
    assert.equal(r.api.snapshotForMessage(message).state.stage, 5);
    assert.equal(r.api.effectiveState().state, null);
    assert.equal(r.api.slowBurnStageInfo().stage, null);
    assert.equal(r.api.slowBurnStageInfo().source, 'unknown');
    const prompt = r.prepare();
    assert.match(prompt, /CURRENT STAGE UNCONFIRMED/);
    assert.doesNotMatch(prompt, /CURRENT STAGE \d\/6|MAXIMUM CHARACTER-INITIATED STAGE|current cap \d/);
    r.receive(report, 'Verified continuation.');
    assert.match(r.prepare(), /CURRENT STAGE 5\/6/);
    r.receive({ ...report, stage: 1, heat: 5 }, 'New scene.');
    assert.match(r.prepare(), /CURRENT STAGE 1\/6/);
    assert.equal(r.settings.autoRefine, false);
});

test('missing reports and a new swipe are unknown, while reported heat/intensity remains a valid fallback', () => {
    const r = setup();
    assert.equal(r.api.slowBurnStageInfo().stage, null);
    const message = r.receive({ ...report, stage: null });
    assert.equal(r.api.slowBurnStageInfo().stage, 5);
    assert.equal(r.api.slowBurnStageInfo().source, nsfw ? 'heat' : 'intensity');
    message.swipe_id = 1; message.mes = 'Another reply without a report.';
    assert.equal(r.api.slowBurnStageInfo().stage, null);
    assert.match(r.prepare(), /CURRENT STAGE UNCONFIRMED/);
});

test('manual stage locks and user targets keep priority with an unknown reported stage', () => {
    const r = setup(); r.receive(); r.context.chat[0].mes = 'Changed reply.';
    Object.assign(r.meta, { slowBurnStageOverride: 4, slowBurnLocked: true });
    assert.match(r.prepare(), /CURRENT STAGE 4\/6/);
    assert.match(r.prepare(), /STAGE LOCKED BY USER/);
    Object.assign(r.meta, { slowBurnStageOverride: null, slowBurnLocked: false, slowBurnTarget: 'Discuss the plan', slowBurnTargetTurns: 3,
        slowBurnTargetActive: true, slowBurnSessionActive: true });
    r.settings.developerMode = true;
    assert.match(r.prepare(), /USER-TARGET SLOW-BURN LOCK/);
    assert.doesNotMatch(r.prepare(), /CURRENT STAGE UNCONFIRMED/);
});

test('changed historical reports do not count toward verified stage residence', () => {
    const r = setup(); const first = r.receive(); r.receive();
    Object.assign(r.meta, { slowBurnSessionActive: true, slowBurnSessionStartAssistantCount: 0 });
    assert.equal(r.api.slowBurnProgress().turns, 2);
    first.mes = 'Changed history.';
    assert.equal(r.api.slowBurnProgress().turns, 1);
});

test('unknown stage renders as waiting, cannot be locked, and supports explicit selection and recovery', () => {
    const r = setup();
    r.document.getElementById = r.node;
    const prefix = nsfw ? 'tns' : 'tsf';
    r.api.renderSlowBurnPanel(r.settings);
    assert.equal(r.node(`${prefix}-slow-burn-stage`).textContent, '단계 확인 대기');
    assert.equal(r.node(`${prefix}-slow-burn-lock`).disabled, true);
    assert.equal(r.node(`${prefix}-slow-burn-next`).disabled, false);
    assert.equal(r.node(`${prefix}-slow-burn-next`).textContent, '1단계 직접 선택');
    r.meta.slowBurnStageOverride = 5;
    r.api.renderSlowBurnPanel(r.settings);
    assert.match(r.node(`${prefix}-slow-burn-stage`).textContent, /5단계/);
    assert.equal(r.node(`${prefix}-slow-burn-lock`).disabled, false);
    assert.equal(r.node(`${prefix}-slow-burn-next`).textContent, '다음 ▶');
});

for (const [heat, stage] of [[7, 1], [8, 1], [10, 2]]) test(`heat ${heat}/stage ${stage}: fresh and reloaded reports release the cap without rewriting facts or calling AI`, () => {
    const original = setup();
    const message = original.receive({ ...report, heat, stage });
    const saved = JSON.stringify(message.extra);
    for (const r of [original, setup(original.context)]) {
        r.settings.diagnosticsEnabled = true;
        r.api.handleIncomingMessage(0);
        const prompt = r.prepare();
        assert.match(prompt, /CURRENT STAGE UNCONFIRMED/);
        assert.match(prompt, /Reassess BOTH heat and stage/);
        assert.match(prompt, /stage value 1 is a FORMAT PLACEHOLDER/);
        assert.doesNotMatch(prompt, /CURRENT STAGE \d\/6|MAXIMUM CHARACTER-INITIATED STAGE|current cap \d/);
        assert.match(prompt, /clothing: Coat/);
        const current = r.api.diagnosticState();
        assert.equal(current.currentHeat, heat); assert.equal(current.currentStage, stage);
        assert.equal(current.stageSource, 'conflict'); assert.equal(current.displayedStage, null);
        assert.ok(JSON.parse(r.api.diagnosticReport()).events.some(e => e.data.stageSource === 'conflict'));
        assert.equal(JSON.stringify(r.context.chat[0].extra), saved);
        assert.equal(r.settings.autoRefine, false); assert.equal(r.calls, 0);
        // Manual selection and locks override automatic conflict detection.
        Object.assign(r.meta, { slowBurnStageOverride: 1, slowBurnLocked: true });
        assert.match(r.prepare(), /CURRENT STAGE 1\/6/);
        assert.match(r.prepare(), /STAGE LOCKED BY USER/);
        r.meta.slowBurnStageOverride = 4; r.meta.slowBurnLocked = false;
        assert.match(r.prepare(), /CURRENT STAGE 4\/6/);
        // User targets still take priority while automatic stage is unconfirmed.
        Object.assign(r.meta, { slowBurnStageOverride: null, slowBurnTarget: 'Discuss the plan', slowBurnTargetTurns: 3,
            slowBurnTargetActive: true, slowBurnSessionActive: true });
        r.settings.developerMode = true;
        assert.match(r.prepare(), /USER-TARGET SLOW-BURN LOCK/);
        r.meta.slowBurnTargetActive = false;
        r.receive({ ...report, heat: 8, stage: 5 }, 'Verified continuation.');
        assert.match(r.prepare(), /CURRENT STAGE 5\/6/);
        assert.equal(r.api.slowBurnStageInfo().source, 'reported');
        assert.equal(JSON.stringify(r.context.chat[0].extra), saved);
        assert.equal(r.calls, 0);
    }
});

test('conflicting historical reports do not satisfy stage residence after a consistent new report', () => {
    const r = setup();
    r.settings.slowBurnIntensity = 'slow';
    for (const heat of [8, 8, 8, 5]) { r.receive({ ...report, heat, stage: 1 }); r.prepare(); }
    assert.equal(r.api.slowBurnProgress().turns, 1);
    assert.match(r.prepare(), /MAXIMUM CHARACTER-INITIATED STAGE THIS RESPONSE: 1\/6/);
    r.receive({ ...report, heat: 5, stage: 1 });
    assert.equal(r.api.slowBurnProgress().turns, 2);
    assert.match(r.prepare(), /MAXIMUM CHARACTER-INITIATED STAGE THIS RESPONSE: 2\/6/);
});

test('consistent stage reports and heat-only fallback retain their original meanings', () => {
    const r = setup();
    for (const [heat, stage] of [[5, 1], [6, 2], [8, 3], [8, 4], [8, 5], [10, 6]]) {
        r.receive({ ...report, heat, stage });
        assert.equal(r.api.slowBurnStageInfo().stage, stage);
        assert.equal(r.api.slowBurnStageInfo().source, 'reported');
    }
    r.receive({ ...report, heat: 8, stage: null });
    assert.equal(r.api.slowBurnStageInfo().stage, 5);
    assert.equal(r.api.slowBurnStageInfo().source, 'heat');
});

test('conflicting stage renders as recheck pending, allows manual selection and recovers on a consistent report', () => {
    const r = setup(); r.receive({ ...report, heat: 8, stage: 1 });
    r.document.getElementById = r.node;
    r.api.renderSlowBurnPanel(r.settings);
    assert.equal(r.node('tns-slow-burn-stage').textContent, '단계 재확인 대기');
    assert.equal(r.node('tns-slow-burn-source').textContent, '온도·단계 불일치, 재확인 대기');
    assert.equal(r.node('tns-slow-burn-lock').disabled, true);
    assert.equal(r.node('tns-slow-burn-next').disabled, false);
    r.meta.slowBurnStageOverride = 1; r.meta.slowBurnLocked = true;
    r.api.renderSlowBurnPanel(r.settings);
    assert.match(r.node('tns-slow-burn-stage').textContent, /1단계/);
    assert.equal(r.node('tns-slow-burn-source').textContent, '수동 선택');
    r.meta.slowBurnStageOverride = null; r.meta.slowBurnLocked = false;
    r.receive(); r.api.renderSlowBurnPanel(r.settings);
    assert.match(r.node('tns-slow-burn-stage').textContent, /5단계/);
    assert.equal(r.node('tns-slow-burn-source').textContent, 'AI 단계 감지');
});
