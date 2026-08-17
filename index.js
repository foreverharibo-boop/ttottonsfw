// 🔞또또NSFW — NSFW 장면 연속성 추적 + 직전 전개 반복 금지 + 진도 강제
// 또또(ttotto)의 자매 확장. 정적 import 없이 getContext() 기반으로 동작.
//
// 동작 개요 (하이브리드):
//  1) 매 생성마다 프롬프트에 "현재 장면 상태 + 최근 N턴 전개(반복 금지) + 상태 태그 갱신 지시"를 주입
//  2) AI 응답 끝의 <scene_state>{...}</scene_state> 태그를 파싱해 메시지 extra에 저장하고 본문에서 제거
//  3) 태그가 누락되면(또는 수동 버튼) 보조 AI 호출로 최근 대화를 분석해 상태를 보정

const MODULE_NAME = 'ttotto-nsfw';
// 설치된 폴더 이름이 무엇이든 동작하도록, 템플릿은 모듈 URL 기준으로 직접 불러온다.
const EXTENSION_BASE_URL = new URL('.', import.meta.url);
const PROMPT_KEY = 'ttotto_nsfw_continuity';
const CHAT_STATE_KEY = 'ttottoNsfw';
const MESSAGE_EXTRA_KEY = 'ttottoNsfw';
const LOG_PREFIX = '[🔞또또NSFW]';
const EXTENSION_VERSION = '0.7.0';
const ALLOWED_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue']);
// setExtensionPrompt 안정 상수: IN_CHAT = 1, SYSTEM = 0 (또또와 동일한 이유로 직접 import 회피)
const PROMPT_POSITION_IN_CHAT = 1;
const PROMPT_ROLE_SYSTEM = 0;

const STATE_TAG_REGEX = /<scene_state>([\s\S]*?)<\/scene_state>/gi;
const STATE_TAG_LOOSE_REGEX = /```(?:json)?\s*<scene_state>[\s\S]*?<\/scene_state>\s*```/gi;

const PACE_INSTRUCTIONS = Object.freeze({
    hold: 'Maintain the current stage of the scene. Deepen sensation and reaction without jumping ahead.',
    slow: 'Move the scene forward to its next natural beat. Advance gradually — one meaningful step per response.',
    push: 'Actively escalate. Each response must clearly progress the scene beyond where the previous one ended.',
});

// 장면 스타일 다이얼 — 무장 중에만 적용
const STYLE_LENGTH_INSTRUCTIONS = Object.freeze({
    tight: 'Length: keep the response tight — 2-3 short paragraphs. Every sentence must carry sensation, action, or reaction; cut filler narration. Leave room for the user to act.',
    normal: '',
    long: 'Length: write a full, unhurried response — take space to build each moment. Do not rush through beats; linger where it matters.',
});
const STYLE_BALANCE_INSTRUCTIONS = Object.freeze({
    dialogue: 'Balance: dialogue-forward. The character keeps talking through the scene — teasing, reacting, murmuring, demanding. Physical description supports the dialogue, not the other way around.',
    balanced: '',
    sensory: 'Balance: sensory-forward. Prioritize concrete physical sensation — touch, heat, breath, weight, sound. Keep dialogue sparse and purposeful.',
    internal: 'Balance: interiority-forward. Keep the character\'s inner voice present — thoughts, restraint, want, conflict — woven through the physical action.',
});

// 해제 브릿지 — 개입 해제 직후 딱 한 번, 장면을 자연스럽게 마무리시키는 지시
const BRIDGE_LINES = [
    '[Scene Wind-Down] The intimate scene has just concluded. This response is the wind-down: settle the afterglow naturally — calming breath, small gestures, quiet words, gentle humor if it fits the characters.',
    'Reflect what just happened in the characters\' mood and closeness. Do not restart or escalate the scene, and do not jump abruptly to unrelated everyday narration.',
];

// 실질적 무제한 — 잘림 방지용 안전 상한만 백만으로 걸어둔다
const SAFETY_LIMIT = 1000000;

// 온도 자동 무장 히스테리시스: 이 온도 이상이면 개입 시작, 이 온도 이하면 해제
const AUTO_ARM_ON = 5;
const AUTO_ARM_OFF = 2;

// 스텔스 모드 로컬 감지: 최근 메시지에서 NSFW 신호를 점수화 (주입·호출 없음)
const STEALTH_WINDOW = 4; // 최근 몇 개 메시지를 스캔할지
const STEALTH_THRESHOLDS = Object.freeze({ high: 4, normal: 6, low: 9 });
const STEALTH_COLD_STREAK = 3; // 이 턴 수 연속 신호 0점이면 온도와 무관하게 개입 해제
const STEALTH_LEXICON = [
    // 강한 신호 (3점): 명시적 행위·신체
    { label: '명시적 표현', re: /삽입|절정|사정|오르가즘|음경|성기|질\s*안|클리|유두|허리를\s*박|안에\s*들어오|안을\s*채우|몸\s*안에|하나가\s*되|thrust(?:ing|s)?|orgasm|climax|cock|pussy|nipple|entrance|inside\s+her|inside\s+him/gi, w: 3 },
    // 신음 표기 (3점)
    { label: '신음 표기', re: /하앙|흐응|아앙|으응|흐읏|하아앙|응아|앗\s*…?\s*안|moan(?:ed|ing|s)?|whimper(?:ed|ing)?/gi, w: 3 },
    // 중간 신호 (2점): 탈의·밀착·애무
    { label: '탈의·밀착', re: /벗기|벗겨|탈의|알몸|나체|속옷|브래지어|팬티|지퍼를\s*내리|단추를\s*풀|신음|헐떡|핥|빨아|깨물|침대에\s*눕히|다리\s*사이|허벅지\s*안쪽|가슴을\s*움켜|가슴을\s*쓸|몸을\s*겹치|밀어\s*넘어뜨리|undress|strip(?:ped|ping)?|naked|underwear|lick(?:ed|ing|s)?|suck(?:ed|ing|s)?|grind(?:ed|ing|s)?|straddl(?:e|ed|ing)|between\s+(?:her|his)\s+thighs/gi, w: 2 },
    // 약한 신호 (1점): 달아오르는 분위기
    { label: '분위기', re: /키스가\s*깊어|입술을\s*탐|혀가\s*얽|숨이\s*가빠|숨이\s*거칠|달아오|몸이\s*뜨거|열기가\s*번지|목덜미에\s*입|귓불을|허리를\s*끌어당|kiss\s+deepen|breath(?:ing)?\s+(?:hitch|ragged|heavy)|heat\s+pool|shiver(?:ed|ing)?\s+under/gi, w: 1 },
];

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    adultConfirmed: false,
    // 'stealth' = 로컬 감지, SFW에선 주입 제로(기본) / 'auto' = 온도 태그 감시 / 'manual' = 채팅 토글로 직접
    armMode: 'stealth',
    stealthSensitivity: 'normal', // 'high' | 'normal' | 'low'
    stealthKeywords: '', // 쉼표 구분 커스텀 감지 키워드 (각 3점)
    nextBeatHints: true,
    repeatWindow: 3,
    maxBannedActs: 15, // 반복 금지 목록 총량 상한 — 넘치면 오래된 것부터 제외
    paceMode: 'slow',
    styleLength: 'normal', // 'tight' | 'normal' | 'long' — 무장 중 응답 길이
    styleBalance: 'balanced', // 'dialogue' | 'balanced' | 'sensory' | 'internal' — 무장 중 묘사 밸런스
    exitBridge: true, // 해제 직후 한 번, 장면 마무리 지시 주입
    autoRefine: true,
    refineProfileId: '',
    refineMaxTokens: SAFETY_LIMIT,
    refineContextMessages: 8,
});

let runtimeActive = true;
let uiReady = false;
let eventsRegistered = false;
let refineRunning = false;
let refineAbortController = null;
let refineTimer = null;
const registeredEventHandlers = [];

// ───────────────────────── 컨텍스트/설정 ─────────────────────────

function getContext() {
    return SillyTavern.getContext();
}

function getEventTypes(context = getContext()) {
    return context.eventTypes ?? context.event_types ?? {};
}

function getSettings() {
    const context = getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const settings = context.extensionSettings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    // 구버전(700토큰 상한) 설정 마이그레이션 — 잘림 방지
    if (Number(settings.refineMaxTokens) < SAFETY_LIMIT) settings.refineMaxTokens = SAFETY_LIMIT;
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced();
}

function getChatMeta(create = true) {
    const context = getContext();
    if (!context.chatMetadata || typeof context.chatMetadata !== 'object') return null;
    if (!context.chatMetadata[CHAT_STATE_KEY]) {
        if (!create) return null;
        context.chatMetadata[CHAT_STATE_KEY] = { enabled: false, manualState: null, ignoredActs: [], autoArmed: false };
    }
    const meta = context.chatMetadata[CHAT_STATE_KEY];
    if (!Array.isArray(meta.ignoredActs)) meta.ignoredActs = [];
    if (!Array.isArray(meta.customBans)) meta.customBans = [];
    return meta;
}

function saveChatMeta() {
    const context = getContext();
    if (typeof context.saveMetadataDebounced === 'function') context.saveMetadataDebounced();
    else if (typeof context.saveMetadata === 'function') void context.saveMetadata();
}

// 감시 중: 이 채팅에서 확장이 동작할 조건이 다 켜져 있는 상태 (최소한 상태 태그는 수집)
function isSupervising() {
    const settings = getSettings();
    const meta = getChatMeta(false);
    return Boolean(runtimeActive && settings.enabled && settings.adultConfirmed && meta?.enabled);
}

// 완전 무장: 연속성·반복금지·진행 지시까지 전부 주입하는 상태
function isFullyArmed() {
    if (!isSupervising()) return false;
    const settings = getSettings();
    if (settings.armMode === 'manual') return true;
    return Boolean(getChatMeta(false)?.autoArmed);
}

// ───────────────────────── 스텔스 로컬 감지 ─────────────────────────

function nsfwScoreDetail(text) {
    const source = String(text ?? '');
    const hits = [];
    let score = 0;
    if (!source) return { score, hits };
    for (const { label, re, w } of STEALTH_LEXICON) {
        re.lastIndex = 0;
        let match;
        let count = 0;
        while (count < 3 && (match = re.exec(source)) !== null) {
            hits.push({ label, text: match[0], w });
            count++;
        }
        score += count * w;
    }
    const custom = String(getSettings().stealthKeywords ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    for (const keyword of custom) {
        if (source.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) {
            score += 3;
            hits.push({ label: '커스텀', text: keyword, w: 3 });
        }
    }
    return { score, hits };
}

function nsfwScore(text) {
    return nsfwScoreDetail(text).score;
}

function stealthWindowDetail() {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    // 해제 직후 직전 장면의 잔열로 곧바로 재무장하는 것 방지: 쿨다운 마커 이후 메시지만 스캔
    const from = Number(getChatMeta(false)?.stealthCooldownFrom ?? 0);
    const recent = chat
        .map((message, index) => ({ message, index }))
        .filter(({ message, index }) => message && !message.is_system && index >= from)
        .slice(-STEALTH_WINDOW);
    const hits = [];
    let score = 0;
    for (const { message } of recent) {
        const detail = nsfwScoreDetail(stripStateTag(message.mes));
        score += detail.score;
        hits.push(...detail.hits);
    }
    return { score, hits };
}

function stealthWindowScore() {
    return stealthWindowDetail().score;
}

// 최근 k개 메시지가 전부 신호 0점인지 (해제 폴백용 — 쿨다운 마커와 무관하게 전체에서 봄)
function stealthColdStreak(k = STEALTH_COLD_STREAK) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const recent = chat.filter((message) => message && !message.is_system).slice(-k);
    if (recent.length < k) return false;
    return recent.every((message) => nsfwScore(stripStateTag(message.mes)) === 0);
}

// 스텔스 모드에서 NSFW 신호가 기준을 넘으면 무장. 주입도 호출도 없이 로컬 스캔만 사용.
function maybeStealthArm() {
    const settings = getSettings();
    if (settings.armMode !== 'stealth' || !isSupervising()) return false;
    const meta = getChatMeta(false);
    if (!meta || meta.autoArmed) return false;
    const threshold = STEALTH_THRESHOLDS[settings.stealthSensitivity] ?? STEALTH_THRESHOLDS.normal;
    const score = stealthWindowScore();
    if (score < threshold) return false;
    meta.autoArmed = true;
    saveChatMeta();
    toastr.info(`NSFW 신호 감지 (점수 ${score}) — 연속성 개입을 시작해요.`, '🔞또또NSFW');
    if (settings.autoRefine) {
        clearTimeout(refineTimer);
        refineTimer = setTimeout(() => { void runRefine(); }, 400);
    }
    updateUi();
    return true;
}

// ───────────────────────── 상태 스냅샷 ─────────────────────────
// 값은 이중 언어로 저장: 주입은 영어(en), UI 표시는 한국어(ko).
// 태그에는 "English phrase || 한국어 구" 형식으로 오고, 구버전 데이터(단일 문자열)도 호환.

function toBi(value) {
    if (value && typeof value === 'object') {
        return { en: String(value.en ?? '').trim().slice(0, SAFETY_LIMIT), ko: String(value.ko ?? '').trim().slice(0, SAFETY_LIMIT) };
    }
    const raw = String(value ?? '').trim().slice(0, SAFETY_LIMIT);
    if (!raw) return { en: '', ko: '' };
    const parts = raw.split(/\s*\|\|\s*/);
    if (parts.length >= 2 && parts[0].trim() && parts[1].trim()) {
        return { en: parts[0].trim(), ko: parts.slice(1).join(' ').trim() };
    }
    return { en: raw, ko: raw };
}

function biText(bi, lang = 'ko') {
    if (!bi) return '';
    if (typeof bi === 'string') return bi;
    return bi[lang] || bi[lang === 'en' ? 'ko' : 'en'] || '';
}

function hasBi(bi) {
    return Boolean(biText(bi, 'en') || biText(bi, 'ko'));
}

function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const clean = { location: { en: '', ko: '' }, characters: {}, acts: [] };
    clean.location = toBi(raw.location);
    const characters = raw.characters && typeof raw.characters === 'object' ? raw.characters : {};
    for (const [name, info] of Object.entries(characters).slice(0, 64)) {
        if (!name || typeof info !== 'object' || info === null) continue;
        clean.characters[String(name).slice(0, SAFETY_LIMIT)] = {
            clothing: toBi(info.clothing),
            position: toBi(info.position),
            contact: toBi(info.contact),
        };
    }
    const acts = Array.isArray(raw.acts) ? raw.acts : [];
    clean.acts = acts.map(toBi).filter(hasBi).slice(0, 64);
    const heat = Number(raw.heat);
    clean.heat = Number.isFinite(heat) ? Math.max(0, Math.min(10, Math.round(heat))) : null;
    const next = Array.isArray(raw.next) ? raw.next : [];
    clean.next = next.map(toBi).filter(hasBi).slice(0, 8);
    const hasCharacters = Object.values(clean.characters).some((info) => hasBi(info.clothing) || hasBi(info.position) || hasBi(info.contact));
    if (!hasBi(clean.location) && !hasCharacters && !clean.acts.length && clean.heat === null && !clean.next.length) return null;
    return clean;
}

function parseStateFromText(text) {
    const source = String(text ?? '');
    let lastJson = null;
    for (const match of source.matchAll(STATE_TAG_REGEX)) {
        lastJson = match[1];
    }
    if (!lastJson) return null;
    const start = lastJson.indexOf('{');
    const end = lastJson.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return sanitizeState(JSON.parse(lastJson.slice(start, end + 1)));
    } catch {
        return null;
    }
}

function stripStateTag(text) {
    return String(text ?? '')
        .replace(STATE_TAG_LOOSE_REGEX, '')
        .replace(STATE_TAG_REGEX, '')
        .replace(/\n{3,}$/g, '\n')
        .replace(/[ \t]+$/g, '')
        .trimEnd();
}

function getMessageStore(message, create = true) {
    if (!message) return null;
    if (!message.extra || typeof message.extra !== 'object') {
        if (!create) return null;
        message.extra = {};
    }
    if (!message.extra[MESSAGE_EXTRA_KEY]) {
        if (!create) return null;
        message.extra[MESSAGE_EXTRA_KEY] = { swipes: {} };
    }
    const store = message.extra[MESSAGE_EXTRA_KEY];
    if (!store.swipes || typeof store.swipes !== 'object') store.swipes = {};
    return store;
}

function currentSwipeIndex(message) {
    return Number.isInteger(message?.swipe_id) ? message.swipe_id : 0;
}

function snapshotForMessage(message) {
    const store = getMessageStore(message, false);
    if (!store) return null;
    return store.swipes[String(currentSwipeIndex(message))] ?? null;
}

// AI 메시지에서 상태 태그를 추출·저장하고 본문에서 제거. 변경 여부를 반환.
function harvestMessage(message) {
    if (!message || message.is_user || message.is_system) return { changed: false, found: false, state: null };
    const swipeIndex = currentSwipeIndex(message);
    let changed = false;
    let found = false;

    const state = parseStateFromText(message.mes);
    if (state) {
        const store = getMessageStore(message);
        store.swipes[String(swipeIndex)] = { state, at: Date.now() };
        found = true;
    }
    const strippedMes = stripStateTag(message.mes);
    if (strippedMes !== message.mes) {
        message.mes = strippedMes;
        changed = true;
    }
    if (Array.isArray(message.swipes) && typeof message.swipes[swipeIndex] === 'string') {
        const strippedSwipe = stripStateTag(message.swipes[swipeIndex]);
        if (strippedSwipe !== message.swipes[swipeIndex]) {
            message.swipes[swipeIndex] = strippedSwipe;
            changed = true;
        }
    }
    if (!found) {
        found = Boolean(snapshotForMessage(message));
    }
    return { changed, found, state };
}

function assistantMessages() {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    return chat.filter((message) => message && !message.is_user && !message.is_system);
}

// 유효한 현재 상태: 수동 보정이 최신이면 그것을, 아니면 마지막 스냅샷을 사용.
function effectiveState() {
    const meta = getChatMeta(false);
    const messages = assistantMessages();
    let lastSnapshot = null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const snapshot = snapshotForMessage(messages[i]);
        if (snapshot?.state) {
            lastSnapshot = snapshot;
            break;
        }
    }
    const manual = meta?.manualState;
    if (manual?.state && (!lastSnapshot || Number(manual.at ?? 0) >= Number(lastSnapshot.at ?? 0))) {
        return { state: manual.state, source: manual.source ?? 'manual' };
    }
    if (lastSnapshot) return { state: lastSnapshot.state, source: 'tag' };
    return { state: null, source: 'none' };
}

function ignoredActSet() {
    const meta = getChatMeta(false);
    return new Set((meta?.ignoredActs ?? []).map((act) => String(act).toLocaleLowerCase()));
}

function isActIgnored(act, ignored) {
    return ignored.has(biText(act, 'en').toLocaleLowerCase()) || ignored.has(biText(act, 'ko').toLocaleLowerCase());
}

// 최근 N턴의 전개(행위) 목록 — 오래된 것 → 최신 순.
// 총량이 maxBannedActs를 넘으면 오래된 것부터 잘라서 주입문 비대화를 막는다.
function recentActs(windowSize) {
    const ignored = ignoredActSet();
    const messages = assistantMessages();
    const rows = [];
    for (let i = messages.length - 1; i >= 0 && rows.length < windowSize; i--) {
        const snapshot = snapshotForMessage(messages[i]);
        if (!snapshot?.state?.acts?.length) continue;
        const acts = snapshot.state.acts.filter((act) => !isActIgnored(act, ignored));
        if (acts.length) rows.unshift({ turnsAgo: rows.length + 1, acts });
    }
    // 중복 제거 (같은 전개가 여러 턴에 반복 기록된 경우 최신 것만)
    const seen = new Set();
    for (let i = rows.length - 1; i >= 0; i--) {
        rows[i].acts = rows[i].acts.filter((act) => {
            const key = (biText(act, 'en') || biText(act, 'ko')).toLocaleLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    // 총량 상한: 오래된 것부터 제거
    const max = Math.max(3, Number(getSettings().maxBannedActs) || DEFAULT_SETTINGS.maxBannedActs);
    let total = rows.reduce((sum, row) => sum + row.acts.length, 0);
    while (total > max && rows.length) {
        const first = rows[0];
        const drop = Math.min(first.acts.length, total - max);
        first.acts = first.acts.slice(drop);
        total -= drop;
        if (!first.acts.length) rows.shift();
    }
    return rows.filter((row) => row.acts.length);
}

// ───────────────────────── 주입문 생성 ─────────────────────────

function buildStateLines(state) {
    const lines = [];
    if (hasBi(state.location)) lines.push(`- Location: ${biText(state.location, 'en')}`);
    for (const [name, info] of Object.entries(state.characters)) {
        const parts = [];
        if (hasBi(info.clothing)) parts.push(`clothing: ${biText(info.clothing, 'en')}`);
        if (hasBi(info.position)) parts.push(`position/posture: ${biText(info.position, 'en')}`);
        if (hasBi(info.contact)) parts.push(`physical contact: ${biText(info.contact, 'en')}`);
        if (parts.length) lines.push(`- ${name} — ${parts.join('; ')}`);
    }
    return lines;
}

// 최신 스냅샷의 다음 전개 후보 (반복 금지 목록·무시 목록과 겹치는 건 제외)
function nextBeatCandidates() {
    const ignored = ignoredActSet();
    const { state } = effectiveState();
    if (!state?.next?.length) return [];
    const settings = getSettings();
    const banned = new Set(
        recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow)
            .flatMap((row) => row.acts)
            .flatMap((act) => [biText(act, 'en').toLocaleLowerCase(), biText(act, 'ko').toLocaleLowerCase()])
            .filter(Boolean),
    );
    const customBans = new Set((getChatMeta(false)?.customBans ?? []).map((ban) => String(ban).toLocaleLowerCase()));
    return state.next.filter((beat) => {
        if (isActIgnored(beat, ignored)) return false;
        if (customBans.has(biText(beat, 'en').toLocaleLowerCase()) || customBans.has(biText(beat, 'ko').toLocaleLowerCase())) return false;
        return !banned.has(biText(beat, 'en').toLocaleLowerCase()) && !banned.has(biText(beat, 'ko').toLocaleLowerCase());
    });
}

const STATE_REPORT_LINES = [
    'STATE REPORT: End your response with exactly one state block in this format (single line, valid JSON). It is machine-read and hidden from the reader — include it every time:',
    '<scene_state>{"location":"short English phrase || 짧은 한국어 구","characters":{"이름":{"clothing":"current clothing state, English || 한국어","position":"current posture/position, English || 한국어","contact":"current physical contact, English || 한국어"}},"acts":["2-4 significant new beats in this response, each \'English || 한국어\'"],"heat":0,"next":["2-3 fresh beats the scene could move to next, each \'English || 한국어\'"]}</scene_state>',
    'Every string value must be a bilingual pair: concise English first, then " || ", then natural Korean. Use the same character names as in the chat.',
    '"acts" rules: list ONLY substantive beats — physical/romantic/emotional developments that matter for repetition control. Skip mundane logistics (snacks, drinks, blankets, remote controls, small housekeeping actions). 2-4 items maximum, only what is NEW in this response.',
    '"heat" is the scene\'s current erotic/tension intensity as an integer from 0 (everyday scene) to 10 (peak). Update every field to reflect the situation at the END of your response. "next" must not repeat anything from "acts".',
];

// 감시 모드 전용 초경량 주입 — 장면 온도 한 줄만 요청 (SFW 장면에는 개입하지 않음)
const MONITOR_REPORT_LINES = [
    '[Scene Monitor] End your response with exactly one line in this format. It is machine-read and hidden from the reader — include it every time, and change nothing else about how you write:',
    '<scene_state>{"heat":0}</scene_state>',
    '"heat" is the scene\'s current erotic/tension intensity as an integer from 0 (everyday scene) to 10 (peak). Report it factually. Do not mention this line in your prose.',
];

function buildInjection() {
    const settings = getSettings();
    const { state } = effectiveState();

    // 무장 전: 해제 브릿지가 걸려 있으면 마무리 지시를 한 번 주입.
    // 그 외엔 스텔스 모드는 아무것도 주입하지 않고, 온도 감시 모드는 온도 한 줄만 요청
    if (!isFullyArmed()) {
        const parts = [];
        if (settings.exitBridge && getChatMeta(false)?.bridgePending) parts.push(...BRIDGE_LINES);
        if (settings.armMode !== 'stealth') parts.push(...MONITOR_REPORT_LINES);
        return parts.join('\n');
    }

    const actRows = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow);
    const pace = PACE_INSTRUCTIONS[settings.paceMode] ?? PACE_INSTRUCTIONS.slow;

    const sections = ['[Scene Continuity Directive]'];

    if (state) {
        sections.push(
            'CURRENT SCENE STATE (established facts — never contradict them):',
            ...buildStateLines(state),
            'Clothing that has been removed stays removed. Positions, locations, and contact only change through explicit on-page actions in your response. Never silently reset or teleport anything.',
        );
    } else {
        sections.push('No scene state has been recorded yet. Establish it in your response and report it in the state block below.');
    }

    const customBans = (getChatMeta(false)?.customBans ?? []).filter(Boolean);
    if (actRows.length || customBans.length) {
        sections.push('');
        if (actRows.length) {
            sections.push(
                `ALREADY HAPPENED in the last ${actRows.length} response(s) — do NOT repeat these beats, actions, or their near-identical variations:`,
                ...actRows.map((row) => `- ${row.acts.map((act) => biText(act, 'en')).join(', ')}`),
            );
        }
        if (customBans.length) {
            sections.push(`USER-BANNED (permanent for this chat — never do these): ${customBans.join(', ')}`);
        }
        sections.push('Repeating a listed beat with different wording still counts as repetition. Bring something new.');
    }

    if (settings.nextBeatHints) {
        const beats = nextBeatCandidates();
        if (beats.length) {
            sections.push(
                '',
                `SUGGESTED NEXT BEATS (pick one, or do something even better — never fall back to a banned beat): ${beats.map((beat) => biText(beat, 'en')).join(' / ')}`,
            );
        }
    }

    sections.push('', `PACING: ${pace}`);

    const styleParts = [
        STYLE_LENGTH_INSTRUCTIONS[settings.styleLength] ?? '',
        STYLE_BALANCE_INSTRUCTIONS[settings.styleBalance] ?? '',
    ].filter(Boolean);
    if (styleParts.length) sections.push('', ...styleParts);

    sections.push('', ...STATE_REPORT_LINES);

    return sections.join('\n');
}

function clearInjectedPrompt() {
    try {
        getContext().setExtensionPrompt(PROMPT_KEY, '', PROMPT_POSITION_IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
    } catch (error) {
        console.debug(`${LOG_PREFIX} 주입문 초기화 생략`, error);
    }
}

globalThis.ttottoNsfwGenerationInterceptor = async function ttottoNsfwGenerationInterceptor(_chat, _contextSize, _abort, type) {
    clearInjectedPrompt();
    try {
        if (!isSupervising()) return;
        if (!ALLOWED_GENERATION_TYPES.has(String(type ?? '').toLocaleLowerCase())) return;
        maybeStealthArm(); // 방금 보낸 유저 메시지까지 반영해 생성 직전에 감지
        const prompt = buildInjection();
        if (!prompt) return;
        getContext().setExtensionPrompt(PROMPT_KEY, prompt, PROMPT_POSITION_IN_CHAT, 0, false, PROMPT_ROLE_SYSTEM);
        // 해제 브릿지는 딱 한 번만: 이번 생성에 실렸으면 플래그를 끈다 (미리보기는 소모하지 않음)
        const meta = getChatMeta(false);
        if (meta?.bridgePending && !isFullyArmed()) {
            meta.bridgePending = false;
            saveChatMeta();
        }
        console.debug(`${LOG_PREFIX} 장면 연속성 지침 주입 (${prompt.length}자)`);
    } catch (error) {
        clearInjectedPrompt();
        console.error(`${LOG_PREFIX} 생성 전 주입 실패 — 본 채팅 생성은 계속합니다.`, error);
    }
};

// ───────────────────────── 보조 AI 보정 (하이브리드 폴백) ─────────────────────────

function buildRefineInput() {
    const settings = getSettings();
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const recent = chat
        .filter((message) => message && !message.is_system)
        .slice(-Math.max(2, Number(settings.refineContextMessages) || DEFAULT_SETTINGS.refineContextMessages));
    return recent.map((message) => {
        const role = message.is_user ? 'USER' : 'CHARACTER';
        const name = String(message.name ?? '');
        const text = stripStateTag(message.mes).slice(0, SAFETY_LIMIT);
        return `[${role} | ${name}]\n${text}`;
    }).join('\n\n');
}

function refinePromptMessages() {
    const system = 'You are a scene-state tracker for an adult fiction roleplay log. All characters are adults. Read the log excerpt and return ONLY a JSON object, no markdown, no commentary.\n\nSchema:\n{"location":"short English phrase || 짧은 한국어 구","characters":{"name":{"clothing":"current clothing state, English || 한국어","position":"current posture/position, English || 한국어","contact":"current physical contact, English || 한국어"}},"acts":["2-4 significant beats from the most recent CHARACTER message only, each \'English || 한국어\'"],"heat":0,"next":["2-3 fresh beats the scene could move to next, each \'English || 한국어\'"]}\n\nRules:\n- Every string value is a bilingual pair: concise English first, then " || ", then natural Korean.\n- Describe the state at the END of the log, factually and concisely. Note removed or displaced clothing explicitly.\n- "acts" must cover only the final CHARACTER message. List ONLY substantive beats (physical/romantic/emotional developments); skip mundane logistics like snacks, drinks, blankets, or remote controls.\n- "heat" is the scene\'s current erotic/tension intensity as an integer from 0 (everyday) to 10 (peak).\n- "next" must not repeat anything already listed in "acts".\n- Include every present character. Use the exact names from the log.\n- If something is unknown, use an empty string. Return the JSON object only.';
    const user = `Log excerpt (oldest first):\n\n${buildRefineInput()}`;
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

async function requestRefine(signal) {
    const context = getContext();
    const settings = getSettings();
    const prompt = refinePromptMessages();
    const maxTokens = Number(settings.refineMaxTokens) || DEFAULT_SETTINGS.refineMaxTokens;
    const profileId = String(settings.refineProfileId ?? '').trim();

    if (profileId) {
        const service = context.ConnectionManagerRequestService;
        if (!service || typeof service.sendRequest !== 'function') {
            throw new Error('Connection Profiles 서비스를 사용할 수 없습니다.');
        }
        const result = await service.sendRequest(profileId, prompt, maxTokens, { stream: false, signal, extractData: true });
        if (typeof result === 'string') return result;
        if (result && typeof result.content === 'string') return result.content;
        throw new Error('보정 분석 연결 프로필이 텍스트를 반환하지 않았습니다.');
    }
    if (typeof context.generateRaw !== 'function') {
        throw new Error('현재 연결을 통한 백그라운드 생성을 사용할 수 없습니다.');
    }
    return context.generateRaw({ prompt, responseLength: maxTokens, trimNames: false, signal });
}

function parseRefineResponse(text) {
    const clean = String(text ?? '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('보정 분석 응답에 JSON 객체가 없습니다.');
    const state = sanitizeState(JSON.parse(clean.slice(start, end + 1)));
    if (!state) throw new Error('보정 분석 결과가 비어 있습니다.');
    return state;
}

async function runRefine({ manual = false } = {}) {
    const settings = getSettings();
    if (!runtimeActive || refineRunning) return false;
    if (!settings.adultConfirmed) {
        if (manual) toastr.warning('설정에서 성인 캐릭터 확인에 먼저 체크해주세요.', '🔞또또NSFW');
        return false;
    }
    if (assistantMessages().length < 1) {
        if (manual) toastr.info('분석할 AI 응답이 아직 없어요.', '🔞또또NSFW');
        return false;
    }

    refineRunning = true;
    refineAbortController?.abort();
    refineAbortController = new AbortController();
    updateUi();

    try {
        const response = await requestRefine(refineAbortController.signal);
        const state = parseRefineResponse(response);
        const meta = getChatMeta();
        meta.manualState = { state, at: Date.now(), source: 'ai-refine' };
        saveChatMeta();
        if (manual) toastr.success('보조 AI가 장면 상태를 다시 잡았어요.', '🔞또또NSFW');
        return true;
    } catch (error) {
        if (error?.name === 'AbortError') return false;
        console.error(`${LOG_PREFIX} 보정 분석 실패`, error);
        if (manual) toastr.error(`보정 분석 실패: ${error?.message ?? error}`, '🔞또또NSFW');
        return false;
    } finally {
        refineRunning = false;
        refineAbortController = null;
        if (runtimeActive) updateUi();
    }
}

function scheduleAutoRefine() {
    const settings = getSettings();
    // 무장 상태에서만 자동 보정 — 대기(스텔스/감시) 중 태그가 없는 건 정상이므로 호출 낭비 금지
    if (!settings.autoRefine || !isFullyArmed()) return;
    clearTimeout(refineTimer);
    refineTimer = setTimeout(() => { void runRefine(); }, 900);
}

// ───────────────────────── 메시지 이벤트 처리 ─────────────────────────

function messageByIndex(index) {
    const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
    const numeric = Number(index);
    if (Number.isInteger(numeric) && chat[numeric]) return chat[numeric];
    return chat.length ? chat[chat.length - 1] : null;
}

function rerenderMessage(index, message) {
    const context = getContext();
    try {
        if (typeof context.updateMessageBlock === 'function') context.updateMessageBlock(Number(index), message);
    } catch (error) {
        console.debug(`${LOG_PREFIX} 메시지 재렌더 생략`, error);
    }
}

function persistChat() {
    const context = getContext();
    try {
        if (typeof context.saveChatDebounced === 'function') context.saveChatDebounced();
        else if (typeof context.saveChat === 'function') void context.saveChat();
    } catch (error) {
        console.debug(`${LOG_PREFIX} 채팅 저장 생략`, error);
    }
}

function handleIncomingMessage(index) {
    const settings = getSettings();
    if (!settings.enabled || !settings.adultConfirmed) return;
    const meta = getChatMeta(false);
    if (!meta?.enabled) return;

    const message = messageByIndex(index);
    if (!message || message.is_user || message.is_system) return;

    const { changed, found, state } = harvestMessage(message);
    if (found) {
        // 새 스냅샷이 수동 보정보다 최신이므로 수동 보정은 자연히 밀려남
        if (meta.manualState && Number(meta.manualState.at ?? 0) < Date.now()) meta.manualState = null;
        saveChatMeta();
    }
    // 스텔스 모드: 무장 전이면 로컬 감지 시도
    if (settings.armMode === 'stealth') maybeStealthArm();
    // 온도 자동 무장/해제 (히스테리시스: 켜짐 5↑, 꺼짐 2↓) — auto·stealth 공통 (해제는 온도 기준)
    if (state?.heat !== null && state?.heat !== undefined && settings.armMode !== 'manual') {
        if (!meta.autoArmed && state.heat >= AUTO_ARM_ON) {
            meta.autoArmed = true;
            saveChatMeta();
            toastr.info(`장면 온도 ${state.heat}/10 — 연속성 개입을 시작해요.`, '🔞또또NSFW');
            // 감시 모드에서는 온도만 수집했으므로, 무장 직후 보조 AI로 전체 상태를 백필
            if (settings.autoRefine) {
                clearTimeout(refineTimer);
                refineTimer = setTimeout(() => { void runRefine(); }, 400);
            }
        } else if (meta.autoArmed && state.heat <= AUTO_ARM_OFF) {
            meta.autoArmed = false;
            meta.bridgePending = true; // 다음 생성 한 번은 장면 마무리 지시
            if (settings.armMode === 'stealth') {
                const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
                meta.stealthCooldownFrom = chat.length; // 이후 메시지부터 다시 감지
            }
            saveChatMeta();
            toastr.info(`장면 온도 ${state.heat}/10 — 개입을 해제하고 대기로 돌아가요.`, '🔞또또NSFW');
        }
    }
    // 해제 폴백: 모델의 온도 보고와 무관하게, 최근 턴들이 연속으로 신호 0점이면 개입 해제
    // (모델이 온도를 계속 높게 불러서 일상 장면에까지 진행 지시가 들어가는 것 방지)
    if (settings.armMode !== 'manual' && meta.autoArmed && stealthColdStreak()) {
        meta.autoArmed = false;
        meta.bridgePending = true;
        const chat = Array.isArray(getContext().chat) ? getContext().chat : [];
        meta.stealthCooldownFrom = chat.length;
        saveChatMeta();
        toastr.info(`장면 신호가 ${STEALTH_COLD_STREAK}턴째 없어요 — 개입을 해제해요.`, '🔞또또NSFW');
    }
    if (changed) {
        rerenderMessage(index, message);
        persistChat();
    }
    if (!found) {
        console.debug(`${LOG_PREFIX} 상태 태그 누락 — 보조 AI 보정 ${settings.autoRefine ? '예약' : '비활성'}`);
        scheduleAutoRefine();
    }
    updateUi();
}

// ───────────────────────── UI ─────────────────────────

function element(id) {
    return document.getElementById(id);
}

function setTab(tab) {
    document.querySelectorAll('#ttotto-nsfw-settings [data-tns-tab]').forEach((button) => {
        const active = button.dataset.tnsTab === tab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    element('tns-panel-state').hidden = tab !== 'state';
    element('tns-panel-settings').hidden = tab !== 'settings';
}

function populateProfiles() {
    if (!uiReady) return;
    const select = element('tns-refine-profile');
    const settings = getSettings();
    const currentValue = String(settings.refineProfileId ?? '');
    select.replaceChildren();
    const current = document.createElement('option');
    current.value = '';
    current.textContent = '현재 연결 사용';
    select.append(current);
    try {
        const service = getContext().ConnectionManagerRequestService;
        const profiles = typeof service?.getSupportedProfiles === 'function' ? service.getSupportedProfiles() : [];
        for (const profile of profiles ?? []) {
            if (!profile?.id) continue;
            const option = document.createElement('option');
            option.value = String(profile.id);
            option.textContent = String(profile.name || profile.id);
            select.append(option);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} 연결 프로필 목록을 불러오지 못했습니다.`, error);
    }
    if (currentValue && ![...select.options].some((option) => option.value === currentValue)) {
        const missing = document.createElement('option');
        missing.value = currentValue;
        missing.textContent = '저장된 연결 프로필을 찾을 수 없음';
        select.append(missing);
    }
    select.value = currentValue;
}

function applyManualEdit(mutator) {
    const meta = getChatMeta();
    const { state } = effectiveState();
    const base = state ? structuredClone(state) : { location: '', characters: {}, acts: [] };
    mutator(base);
    meta.manualState = { state: sanitizeState(base) ?? base, at: Date.now(), source: 'manual' };
    saveChatMeta();
    updateUi();
}

function renderStatePanel() {
    const { state, source } = effectiveState();
    const settings = getSettings();
    const sourceLabel = { tag: '응답 태그에서 추적됨', 'ai-refine': '보조 AI 보정 결과', manual: '수동 수정됨', none: '아직 기록 없음' }[source] ?? source;
    element('tns-state-source').textContent = refineRunning ? '보조 AI 분석 중…' : sourceLabel;

    const heatBadge = element('tns-heat');
    if (state?.heat !== null && state?.heat !== undefined) {
        heatBadge.hidden = false;
        heatBadge.textContent = `🌡️ ${state.heat}/10`;
        heatBadge.classList.toggle('is-hot', state.heat >= AUTO_ARM_ON);
    } else {
        heatBadge.hidden = true;
    }

    const locationInput = element('tns-state-location');
    if (document.activeElement !== locationInput) locationInput.value = biText(state?.location);

    const list = element('tns-char-list');
    list.replaceChildren();
    const characters = state?.characters ?? {};
    for (const [name, info] of Object.entries(characters)) {
        const row = document.createElement('div');
        row.className = 'tns-char-row';
        const title = document.createElement('strong');
        title.textContent = name;
        row.append(title);
        for (const [field, label] of [['clothing', '복장'], ['position', '자세·위치'], ['contact', '접촉']]) {
            const wrap = document.createElement('label');
            wrap.className = 'tns-char-field';
            const caption = document.createElement('span');
            caption.textContent = label;
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'text_pole';
            input.value = biText(info[field]);
            input.addEventListener('change', () => {
                applyManualEdit((draft) => {
                    if (!draft.characters[name]) draft.characters[name] = { clothing: '', position: '', contact: '' };
                    draft.characters[name][field] = input.value;
                });
            });
            wrap.append(caption, input);
            row.append(wrap);
        }
        list.append(row);
    }
    element('tns-char-empty').hidden = Object.keys(characters).length > 0;

    const actsList = element('tns-acts-list');
    actsList.replaceChildren();
    const rows = recentActs(Number(settings.repeatWindow) || DEFAULT_SETTINGS.repeatWindow);
    for (const row of rows) {
        for (const act of row.acts) {
            const chip = document.createElement('span');
            chip.className = 'tns-act-chip';
            const text = document.createElement('span');
            text.textContent = biText(act);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = '이 항목은 반복 금지에서 제외';
            remove.textContent = '×';
            remove.addEventListener('click', () => {
                const meta = getChatMeta();
                for (const key of [biText(act, 'en'), biText(act, 'ko')]) {
                    if (key && !meta.ignoredActs.includes(key)) meta.ignoredActs.push(key);
                }
                saveChatMeta();
                updateUi();
            });
            chip.append(text, remove);
            actsList.append(chip);
        }
    }
    element('tns-acts-empty').hidden = rows.length > 0;
    element('tns-acts-summary').textContent = `최근 ${settings.repeatWindow}턴 기준`;

    // 다음 전개 후보
    const nextList = element('tns-next-list');
    nextList.replaceChildren();
    const beats = settings.nextBeatHints ? nextBeatCandidates() : [];
    for (const beat of beats) {
        const chip = document.createElement('span');
        chip.className = 'tns-act-chip tns-next-chip';
        const text = document.createElement('span');
        text.textContent = biText(beat);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = '이 후보는 제안에서 제외';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const meta = getChatMeta();
            for (const key of [biText(beat, 'en'), biText(beat, 'ko')]) {
                if (key && !meta.ignoredActs.includes(key)) meta.ignoredActs.push(key);
            }
            saveChatMeta();
            updateUi();
        });
        chip.append(text, remove);
        nextList.append(chip);
    }
    const nextSection = element('tns-next-section');
    nextSection.hidden = !settings.nextBeatHints;
    element('tns-next-empty').hidden = !settings.nextBeatHints || beats.length > 0;

    // 수동 금지 목록
    const customList = element('tns-custom-ban-list');
    customList.replaceChildren();
    const meta = getChatMeta(false);
    for (const ban of meta?.customBans ?? []) {
        const chip = document.createElement('span');
        chip.className = 'tns-act-chip tns-custom-chip';
        const text = document.createElement('span');
        text.textContent = ban;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = '금지 해제';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            const chatMeta = getChatMeta();
            chatMeta.customBans = chatMeta.customBans.filter((item) => item !== ban);
            saveChatMeta();
            updateUi();
        });
        chip.append(text, remove);
        customList.append(chip);
    }

    // 스텔스 감지 점수 뷰어
    const scoreBox = element('tns-score-box');
    if (settings.armMode === 'stealth' && isSupervising()) {
        scoreBox.hidden = false;
        const { score, hits } = stealthWindowDetail();
        const threshold = STEALTH_THRESHOLDS[settings.stealthSensitivity] ?? STEALTH_THRESHOLDS.normal;
        element('tns-score-value').textContent = `${score} / 기준 ${threshold}`;
        const hitsList = element('tns-score-hits');
        hitsList.replaceChildren();
        const seenHits = new Set();
        for (const hit of hits) {
            const key = `${hit.label}:${hit.text.toLocaleLowerCase()}`;
            if (seenHits.has(key)) continue;
            seenHits.add(key);
            if (seenHits.size > 12) break;
            const chip = document.createElement('span');
            chip.className = 'tns-act-chip tns-hit-chip';
            chip.textContent = `${hit.text} (${hit.label} +${hit.w})`;
            hitsList.append(chip);
        }
        element('tns-score-note').hidden = hits.length > 0;
    } else {
        scoreBox.hidden = true;
    }
}

function updateUi() {
    if (!uiReady) return;
    try {
        const settings = getSettings();
        const meta = getChatMeta(false);

        element('tns-enabled').checked = Boolean(settings.enabled);
        element('tns-adult-confirmed').checked = Boolean(settings.adultConfirmed);
        element('tns-chat-enabled').checked = Boolean(meta?.enabled);
        element('tns-repeat-window').value = String(settings.repeatWindow);
        element('tns-repeat-window-value').textContent = `${settings.repeatWindow}턴`;
        element('tns-max-banned').value = String(settings.maxBannedActs);
        element('tns-max-banned-value').textContent = `${settings.maxBannedActs}개`;
        element('tns-pace-mode').value = String(settings.paceMode);
        element('tns-style-length').value = String(settings.styleLength);
        element('tns-style-balance').value = String(settings.styleBalance);
        element('tns-exit-bridge').checked = Boolean(settings.exitBridge);
        element('tns-arm-mode').value = String(settings.armMode);
        element('tns-stealth-sensitivity').value = String(settings.stealthSensitivity);
        const keywordsInput = element('tns-stealth-keywords');
        if (document.activeElement !== keywordsInput) keywordsInput.value = String(settings.stealthKeywords ?? '');
        element('tns-next-hints').checked = Boolean(settings.nextBeatHints);
        element('tns-auto-refine').checked = Boolean(settings.autoRefine);

        element('tns-adult-warning').hidden = Boolean(settings.adultConfirmed);

        const armed = isSupervising();
        const heat = effectiveState().state?.heat;
        const heatText = heat !== null && heat !== undefined ? ` (온도 ${heat}/10)` : '';
        element('tns-header-status').textContent = !settings.enabled
            ? '꺼져 있어요'
            : !settings.adultConfirmed
                ? '성인 캐릭터 확인이 필요해요'
                : !meta?.enabled
                    ? '이 채팅에서는 쉬는 중'
                    : refineRunning
                        ? '보조 AI 분석 중…'
                        : settings.armMode === 'stealth'
                            ? (meta?.autoArmed ? `개입 중이에요${heatText}` : '조용히 대기 중이에요 (주입 없음)')
                            : settings.armMode === 'auto'
                                ? (meta?.autoArmed ? `개입 중이에요${heatText}` : `온도를 감시하는 중이에요${heatText}`)
                                : '장면을 지켜보는 중이에요';

        element('tns-refine').disabled = refineRunning;
        renderStatePanel();

        const preview = element('tns-prompt-preview');
        if (!preview.hidden) {
            const prompt = armed ? buildInjection() : '';
            element('tns-prompt-text').textContent = prompt || '(지금은 주입할 내용이 없어요)';
            element('tns-prompt-size').textContent = `${prompt.length}자`;
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} UI 갱신 실패`, error);
    }
}

function bindSetting(id, key, parser = (value) => value, after = null) {
    element(id).addEventListener('change', () => {
        const target = element(id);
        const value = target.type === 'checkbox' ? target.checked : target.value;
        const settings = getSettings();
        settings[key] = parser(value);
        saveSettings();
        if (!settings.enabled) clearInjectedPrompt();
        if (typeof after === 'function') after(settings);
        updateUi();
    });
}

function bindUi() {
    document.querySelectorAll('#ttotto-nsfw-settings [data-tns-tab]').forEach((button) => {
        button.addEventListener('click', () => setTab(button.dataset.tnsTab));
    });

    bindSetting('tns-enabled', 'enabled', Boolean);
    bindSetting('tns-adult-confirmed', 'adultConfirmed', Boolean);
    bindSetting('tns-arm-mode', 'armMode', String, (settings) => {
        // 수동으로 전환하면 자동 무장 상태는 리셋 (스텔스↔온도 자동 전환은 유지)
        if (settings.armMode === 'manual') {
            const meta = getChatMeta(false);
            if (meta) { meta.autoArmed = false; saveChatMeta(); }
        }
    });
    bindSetting('tns-stealth-sensitivity', 'stealthSensitivity', String);
    bindSetting('tns-stealth-keywords', 'stealthKeywords', String);
    bindSetting('tns-next-hints', 'nextBeatHints', Boolean);
    bindSetting('tns-pace-mode', 'paceMode', String);
    bindSetting('tns-style-length', 'styleLength', String);
    bindSetting('tns-style-balance', 'styleBalance', String);
    bindSetting('tns-exit-bridge', 'exitBridge', Boolean);
    bindSetting('tns-auto-refine', 'autoRefine', Boolean);
    bindSetting('tns-refine-profile', 'refineProfileId', String);

    const slider = element('tns-repeat-window');
    slider.addEventListener('input', () => {
        element('tns-repeat-window-value').textContent = `${slider.value}턴`;
    });
    slider.addEventListener('change', () => {
        const settings = getSettings();
        settings.repeatWindow = Math.min(10, Math.max(1, Number(slider.value) || DEFAULT_SETTINGS.repeatWindow));
        saveSettings();
        updateUi();
    });

    const maxBannedSlider = element('tns-max-banned');
    maxBannedSlider.addEventListener('input', () => {
        element('tns-max-banned-value').textContent = `${maxBannedSlider.value}개`;
    });
    maxBannedSlider.addEventListener('change', () => {
        const settings = getSettings();
        settings.maxBannedActs = Math.min(30, Math.max(5, Number(maxBannedSlider.value) || DEFAULT_SETTINGS.maxBannedActs));
        saveSettings();
        updateUi();
    });

    element('tns-chat-enabled').addEventListener('change', () => {
        const meta = getChatMeta();
        meta.enabled = element('tns-chat-enabled').checked;
        saveChatMeta();
        if (!meta.enabled) clearInjectedPrompt();
        updateUi();
    });

    element('tns-state-location').addEventListener('change', () => {
        applyManualEdit((draft) => { draft.location = element('tns-state-location').value; });
    });

    element('tns-refine').addEventListener('click', () => { void runRefine({ manual: true }); });

    const addCustomBan = () => {
        const input = element('tns-custom-ban-input');
        const value = input.value.trim();
        if (!value) return;
        const meta = getChatMeta();
        if (!meta.customBans.includes(value)) meta.customBans.push(value);
        input.value = '';
        saveChatMeta();
        updateUi();
    };
    element('tns-custom-ban-add').addEventListener('click', addCustomBan);
    element('tns-custom-ban-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); addCustomBan(); }
    });

    element('tns-clear-state').addEventListener('click', () => {
        const meta = getChatMeta();
        meta.manualState = null;
        meta.ignoredActs = [];
        for (const message of assistantMessages()) {
            const store = getMessageStore(message, false);
            if (store) delete message.extra[MESSAGE_EXTRA_KEY];
        }
        saveChatMeta();
        persistChat();
        toastr.info('이 채팅의 장면 기록을 비웠어요.', '🔞또또NSFW');
        updateUi();
    });

    element('tns-toggle-preview').addEventListener('click', () => {
        const preview = element('tns-prompt-preview');
        preview.hidden = !preview.hidden;
        element('tns-toggle-preview').textContent = preview.hidden ? '주입문 보기' : '주입문 접기';
        updateUi();
    });
}

async function loadSettingsHtml() {
    const response = await fetch(new URL('settings.html', EXTENSION_BASE_URL));
    if (!response.ok) throw new Error(`settings.html 로드 실패 (HTTP ${response.status})`);
    return response.text();
}

async function initializeUi() {
    if (document.getElementById('ttotto-nsfw-settings')) return; // 중복 삽입 방지
    const html = await loadSettingsHtml();
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) throw new Error('확장 설정 컨테이너를 찾을 수 없습니다.');
    container.insertAdjacentHTML('beforeend', html);
    const required = ['tns-enabled', 'tns-adult-confirmed', 'tns-chat-enabled', 'tns-repeat-window', 'tns-pace-mode', 'tns-refine', 'tns-state-location'];
    const missing = required.filter((id) => !document.getElementById(id));
    if (missing.length) throw new Error(`설정 패널 요소 누락: ${missing.join(', ')}`);
    uiReady = true;
    bindUi();
    populateProfiles();
    setTab('state');
    updateUi();
}

// ───────────────────────── 이벤트 등록/수명주기 ─────────────────────────

function registerEvents() {
    if (eventsRegistered) return;
    const context = getContext();
    const events = getEventTypes(context);
    const listen = (name, handler) => {
        const event = events[name];
        if (!event) return;
        context.eventSource.on(event, handler);
        registeredEventHandlers.push({ event, handler });
    };

    listen('MESSAGE_RECEIVED', (index) => handleIncomingMessage(index));
    // 스와이프 보험: ST 버전에 따라 스와이프 생성 후 MESSAGE_RECEIVED가 안 오는 경우를 이중으로 잡는다
    listen('GENERATION_ENDED', () => handleIncomingMessage());
    listen('MESSAGE_SWIPED', (index) => handleIncomingMessage(index));
    listen('MESSAGE_EDITED', () => updateUi());
    listen('MESSAGE_DELETED', () => updateUi());
    listen('CHAT_CHANGED', () => {
        clearTimeout(refineTimer);
        refineAbortController?.abort();
        clearInjectedPrompt();
        populateProfiles();
        updateUi();
    });
    listen('CHAT_CREATED', () => updateUi());
    listen('CONNECTION_PROFILE_LOADED', populateProfiles);
    eventsRegistered = true;
}

function unregisterEvents() {
    if (!eventsRegistered) return;
    const eventSource = getContext().eventSource;
    for (const { event, handler } of registeredEventHandlers.splice(0)) {
        if (typeof eventSource.removeListener === 'function') eventSource.removeListener(event, handler);
        else if (typeof eventSource.off === 'function') eventSource.off(event, handler);
    }
    eventsRegistered = false;
}

async function initialize() {
    runtimeActive = true;
    getSettings();
    registerEvents();
    await initializeUi();
    console.log(`${LOG_PREFIX} v${EXTENSION_VERSION} 로드 완료`);
}

export function onEnable() {
    runtimeActive = true;
    registerEvents();
    updateUi();
}

export function onDisable() {
    runtimeActive = false;
    clearTimeout(refineTimer);
    refineAbortController?.abort();
    unregisterEvents();
    clearInjectedPrompt();
}

export function onClean() {
    const context = getContext();
    delete context.extensionSettings[MODULE_NAME];
    if (context.chatMetadata && typeof context.chatMetadata === 'object') {
        delete context.chatMetadata[CHAT_STATE_KEY];
        saveChatMeta();
    }
    context.saveSettingsDebounced();
    clearInjectedPrompt();
}

const bootContext = getContext();
const bootEvents = getEventTypes(bootContext);
if (bootEvents.APP_READY) {
    bootContext.eventSource.on(bootEvents.APP_READY, () => {
        if (!runtimeActive) return;
        void initialize().catch((error) => {
            console.error(`${LOG_PREFIX} 초기화 실패`, error);
            toastr.error(`초기화 실패: ${error?.message ?? error}`, '🔞또또NSFW');
        });
    });
} else {
    void initialize().catch((error) => console.error(`${LOG_PREFIX} 초기화 실패`, error));
}
