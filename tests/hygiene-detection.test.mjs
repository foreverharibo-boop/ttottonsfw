import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const index = fs.readFileSync(new URL('index.js', root), 'utf8');
const moduleSource = fs.readFileSync(new URL('scene-detector.js', root), 'utf8');
const { scoreScene } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const inline = vm.runInNewContext(index.split('// BEGIN LOCAL SCENE DETECTOR\n')[1].split('// END LOCAL SCENE DETECTOR')[0] + '\nscoreScene;');
const plain = x => JSON.parse(JSON.stringify(x));
const ordinary = [
    '샤워를 하며 비누로 가슴을 문지르고 바지를 내렸다.',
    '그녀는 목욕을 하며 가슴을 비볐다.',
    '샤워 중이었다. 손으로 유두 주변을 문질렀다.',
    '그는 비누를 묻혀 성기를 문지르고 헹궜다.',
    '그는 수건으로 가슴의 물기를 닦았다.',
    'She washed her nipples with her hand, rubbing soap over them.',
    'She stepped into the shower. Her hands rubbed her nipples.',
    'He washed himself in the bath. His hand rubbed his genitals.',
    'He rubbed his erection with soap in the shower.',
    'She rinsed the soap off her breasts and dried herself with a towel.',
    'She whimpered in pain. She moaned from a bruise.',
    '그녀는 아픈 가슴을 문질렀다.',
    'The doctor inserted a catheter during the medical examination.',
    'He did not lick her nipples.',
    '그는 그녀의 유두를 핥지 않았다.',
    '그녀는 옷을 벗겨 갈아입었다. 바지를 내리고 팬티를 내렸다.',
    'She kissed deeply. Their tongues met. She moaned. She whimpered.',
    '하앙. 흐응. 아앙.',
    'She explained what an orgasm was.',
];
for (const text of ordinary) test(`ordinary/denied: ${text}`, () => {
    assert.equal(scoreScene(text).score, 0);
    assert.deepEqual(plain(inline(text)), scoreScene(text));
});
const active = [
    'He licked her nipples.',
    '그는 그녀의 유두를 핥았다.',
    'She showered. He licked her nipples.',
    '목욕 중이었다. 그는 그녀의 유두를 핥았다.',
    'He sucked her nipple in the shower.',
    'She washed her hair while he licked her nipples.',
    'He licked her nipples while she washed her hair.',
    'He did not stop licking her nipples.',
    'His hands rubbed her nipples.',
    'He rubbed his jeans against her hips. His penis was hard.',
    '그는 바지를 비비며 골반을 밀어붙였다. 성기가 단단하게 발기했다.',
    'He masturbated in the shower.',
    '그는 샤워 중에 자위를 했다.',
];
for (const text of active) test(`active contact: ${text}`, () => {
    assert.ok(scoreScene(text).score >= 4, JSON.stringify(scoreScene(text)));
    assert.deepEqual(plain(inline(text)), scoreScene(text));
});

test('state metadata is not evidence, including incomplete tags', () => {
    for (const ending of ['</scene_state>', '']) {
        assert.equal(scoreScene('She showered. <scene_state>{"heat":9,"acts":["lick nipples"]}' + ending).score, 0);
    }
});
test('bath-only classification does not suppress separate actual contact', () => {
    assert.equal(scoreScene('She showered.').routineOnly, true);
    assert.equal(scoreScene('She showered. He licked her nipples.').routineOnly, false);
});
test('custom keywords do not turn washing anatomy into sex', () => {
    assert.equal(scoreScene('She washed her breasts with soap.', 'breasts,soap').score, 0);
    assert.equal(scoreScene('Their private signal was velvet.', 'velvet').score, 3);
});
test('weak cues in another paragraph do not increase an earlier act', () => {
    assert.equal(scoreScene('He licked her nipples.\n\nShe whimpered in pain. She moaned.').score, 4);
});

function runtime({mode='stealth', sensitivity='normal', armed=false, force=false, autoRefine=false, chat=[]}={}) {
    const foreign = { preset:[{identifier:'A'}, {identifier:'B'}], prompt:{text:'foreign'}, settings:{flag:true} };
    const savedForeign = JSON.stringify(foreign);
    const context = {
        chat, chatMetadata:{ttottoNsfw:{chatSchemaVersion:1,enabled:true,autoArmed:armed,forceArmed:force}},
        extensionSettings:{'ttotto-nsfw':{settingsSchemaVersion:3, enabled:true, adultConfirmed:true, armMode:mode, stealthSensitivity:sensitivity, autoRefine, slowBurnEnabled:false}},
        setExtensionPrompt(){}, saveMetadataDebounced(){}, saveSettingsDebounced(){}, saveChat(){}, foreign,
    };
    let calls=0;
    const env = { SillyTavern:{getContext:()=>context}, URL, console:{log(){},warn(){},error(){},debug(){}}, structuredClone,
        toastr:{info(){},warning(){},success(){},error(){}}, setTimeout:()=>{calls++;return 1;}, clearTimeout(){}, AbortController,
        document:{getElementById:()=>null}, window:{}, };
    vm.createContext(env);
    const script = index.slice(0,index.indexOf('const bootContext = getContext();'))
        .replaceAll('export function ', 'function ').replace('import.meta.url', "'file:///extension/index.js'");
    vm.runInContext(script + '\nglobalThis.testApi={getSettings,getChatMeta,maybeStealthArm,maybeStealthRelease,stealthWindowDetail,handleIncomingMessage,prepareSceneInjection,isFullyArmed,beginSceneGeneration,finishSceneGeneration};',env);
    const api=env.testApi;
    api.getSettings(); api.getChatMeta();
    return {api, context, env, meta:context.chatMetadata.ttottoNsfw, noForeignChanges:()=>assert.equal(JSON.stringify(foreign),savedForeign), noCalls:()=>assert.equal(calls,0)};
}
const message = (mes,is_user=false)=>({mes,is_user});
for (const mode of ['stealth','auto']) for (const sensitivity of ['high','normal','low']) {
    test(`bath remains inactive: ${mode}/${sensitivity}`,()=>{
        const r=runtime({mode,sensitivity,chat:[message('샤워를 하며 비누로 가슴을 문지르고 바지를 내렸다.')]});
        assert.equal(r.api.maybeStealthArm(),false);
        assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
        assert.equal(r.meta.autoArmed,false);
        r.noForeignChanges();r.noCalls();
    });
}
test('new routine user message does not inherit previous sexual score',()=>{
    const r=runtime({chat:[message('He licked her nipples.'), message('I am washing with soap in the shower.',true)]});
    assert.equal(r.api.stealthWindowDetail().score,0);
    assert.equal(r.api.maybeStealthArm(),false);
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
});
for (const mode of ['stealth','auto']) test(`high model heat cannot activate bath: ${mode}`,()=>{
    const body='She washed her nipples with her hand, rubbing soap over them.';
    const r=runtime({mode,chat:[message(body+'<scene_state>{"heat":9}</scene_state>')]});
    r.api.handleIncomingMessage(0);
    assert.equal(r.meta.autoArmed,false);
    assert.equal(r.context.chat[0].mes,body); // existing state harvesting only
    assert.equal(r.context.chat[0].extra.ttottoNsfw.swipes['0'].state.heat,9); // no falsified report
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
    r.noCalls();r.noForeignChanges();
});
test('bath transition releases local auto activation despite high previous report',()=>{
    const r=runtime({armed:true,chat:[message('He licked her nipples.<scene_state>{"heat":9}</scene_state>'),message('I showered with soap.',true)]});
    assert.equal(r.api.maybeStealthRelease(),true);
    assert.equal(r.meta.autoArmed,false);
    assert.equal(r.meta.sfwImmediateHandoff,true);
    assert.equal(r.meta.bridgePending,false);
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
});
test('high heat in a new ordinary bath reply does not keep stale activation',()=>{
    const r=runtime({armed:true,chat:[message('He licked her nipples.'),message('She washed with soap in the shower.<scene_state>{"heat":8}</scene_state>')]});
    r.api.handleIncomingMessage(1);
    assert.equal(r.meta.autoArmed,false);
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
});
test('real contact in a bath still arms and low reported heat does not cancel it',()=>{
    const r=runtime({chat:[message('She showered. He licked her nipples.<scene_state>{"heat":0}</scene_state>')]});
    r.api.handleIncomingMessage(0);
    assert.equal(r.meta.autoArmed,true);
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),true);
});
test('manual mode and force activation remain intentional overrides',()=>{
    for (const options of [{mode:'manual'}, {armed:true,force:true}]) {
        const r=runtime({...options,chat:[message('She showered with soap.')]});
        assert.equal(r.api.maybeStealthRelease(),false);
        assert.equal(r.env.ttottoNsfwSceneBridge.sync(),true);
    }
});
test('slow burn no-conclusion lock remains user controlled',()=>{
    const r=runtime({armed:true,chat:[message('She showered with soap.')]});
    r.context.extensionSettings['ttotto-nsfw'].slowBurnEnabled=true;
    r.meta.slowBurnSessionActive=true;
    r.meta.slowBurnStageOverride=1;
    r.meta.slowBurnLocked=true;
    assert.equal(r.api.maybeStealthRelease(),false);
    assert.equal(r.meta.slowBurnRecoveryPending,true);
    assert.equal(r.meta.autoArmed,true);
});
test('different selected swipes are evaluated from their current body',()=>{
    const r=runtime({chat:[message('He licked her nipples.')]});
    r.api.handleIncomingMessage(0);
    assert.equal(r.meta.autoArmed,true);
    r.context.chat[0].mes='She washed with soap in the shower.';
    r.context.chat[0].swipe_id=1;
    r.api.handleIncomingMessage(0);
    assert.equal(r.meta.autoArmed,false);
});
test('unrelated ordinary scenes still honor two-message cold streak',()=>{
    const r=runtime({armed:true,chat:[message('They drank tea.'),message('She opened a book.',true)]});
    assert.equal(r.api.maybeStealthRelease(),true);
});
test('thresholds, UI, version and heat instructions agree',()=>{
    assert.match(index,/high: 3, normal: 4, low: 7/);
    assert.match(index,/Ordinary bathing, showering/);
    assert.equal(JSON.parse(fs.readFileSync(new URL('manifest.json',root))).version,'0.13.14');
    assert.match(fs.readFileSync(new URL('settings.html',root),'utf8'),/민감 3점 · 보통 4점 · 둔감 7점/);
});

for (const mode of ['stealth','auto']) test(`bath does not schedule enabled auxiliary analysis: ${mode}`,()=>{
    const r=runtime({mode,autoRefine:true,chat:[message('She washed her nipples with her hand, rubbing soap over them.<scene_state>{"heat":9}</scene_state>')]});
    r.api.handleIncomingMessage(0);
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
    r.noCalls();
});
for (const first of ['sync','incoming']) test(`handoff order ${first} does not rearm a bath`,()=>{
    const r=runtime({armed:true,chat:[message('He licked her nipples.<scene_state>{"heat":9}</scene_state>'),message('She washed with soap in the shower.<scene_state>{"heat":9}</scene_state>')]});
    if(first==='sync') r.env.ttottoNsfwSceneBridge.sync();
    r.api.handleIncomingMessage(1);
    assert.equal(r.env.ttottoNsfwSceneBridge.sync(),false);
    assert.equal(r.meta.autoArmed,false);
    r.noForeignChanges();
});
test('low sensitivity retains its two-strong-message threshold',()=>{
    const r=runtime({sensitivity:'low',chat:[message('He licked her nipples.')]});
    assert.equal(r.api.maybeStealthArm(),false);
    r.context.chat.push(message('He licked her nipples.',true));
    assert.equal(r.api.maybeStealthArm(),true);
});
test('score calculation never changes source body, swipes or settings',()=>{
    const r=runtime({chat:[{...message('She washed with soap in the shower.'),swipes:['She washed with soap in the shower.'],extra:{foreign:'keep'}}]});
    const before=JSON.stringify({chat:r.context.chat,settings:r.context.extensionSettings});
    for (let i=0;i<100;i++) r.api.stealthWindowDetail();
    assert.equal(JSON.stringify({chat:r.context.chat,settings:r.context.extensionSettings}),before);
    r.noForeignChanges();
});

test('module and actual runtime detector are identical',()=>{
    const actual=index.split('const scoreScene = (() => {\n')[1].split('\nreturn scoreScene;')[0];
    assert.equal(actual,moduleSource.replace('export function scoreScene(', 'function scoreScene(',1));
});
test('later intentional custom keyword is not hidden by an earlier washing mention',()=>{
    assert.equal(scoreScene('She washed the velvet with soap. Their private signal was velvet.', 'velvet').score,3);
});
