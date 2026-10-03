// NSFW 로컬 감지기. API나 프롬프트를 호출하지 않는다.
// 신체 단어 하나가 아니라 가까운 행동 표현과 함께 있을 때 강한 신호로 센다.
const EN_BODY = String.raw`\b(?:breasts?|nipples?|clit(?:oris)?|pussy|cock|dick|penis|vulva|vagina|genitals?|outer\s+lips|bundle\s+of\s+nerves)\b`;
const EN_ORAL = String.raw`\b(?:lick(?:s|ed|ing)?|suck(?:s|ed|ing)?|lap(?:s|ped|ping)?|suction)\b`;
const EN_ORAL_MOTION = /\b(?:swirl(?:s|ed|ing)?|press(?:es|ed|ing)?|drag(?:s|ged|ging)?|circl(?:e|es|ed|ing)|flick(?:s|ed|ing)?|lick(?:s|ed|ing)?|suck(?:s|ed|ing)?|lap(?:s|ped|ping)?)\b/i;
const EN_HAND = String.raw`\b(?:finger(?:s|ed|ing)?|digits?|hands?)\b`;
const EN_INTIMATE = String.raw`\b(?:wetness|pussy|vagina|canal|clit(?:oris)?|nipples?|genitals?)\b`;
const EN_MOTION = /\b(?:sink(?:s|ing)?|sank|buried|insert(?:s|ed|ing)?|pump(?:s|ed|ing)?|stretch(?:es|ed|ing)?|rub(?:s|bed|bing)?|strok(?:e|es|ed|ing)|penetrat(?:e|es|ed|ing)|fuck(?:s|ed|ing)?)\b/i;
const KO_BODY = String.raw`(?:가슴|유두|젖꼭지|성기|클리토리스|음핵|음순|보지|자지|애액|젖은\s*(?:구멍|속살))`;
const KO_TOUCH = String.raw`(?:핥|빨|애무|주무|움켜|문지|문질|쑤셔|쑤시|쑤셔대|비벼|비비|비볐|삽입|밀어\s*넣|박아\s*넣|잠겨|파묻|마디.{0,20}잠)`;
const NEAR = String.raw`[^.!?。！？\n]{0,180}?`;
function nearby(left, right, span = NEAR) {
    return new RegExp(`(?:${left})${span}(?:${right})|(?:${right})${span}(?:${left})`, 'gi');
}

// 의복 마찰은 운동/세탁에도 등장한다. 같은 문단의 구체적인 성적 신체 반응이 있어야 인정한다.
const EN_GENITAL_RESPONSE = nearby(String.raw`\b(?:cock|dick|penis|erection)\b`,
    String.raw`\b(?:hard|stiff|rigid|erect|throb(?:s|bed|bing)?|aching|aroused)\b`);
const KO_GENITAL_RESPONSE = nearby(String.raw`(?:성기|자지|발기)`,
    String.raw`(?:발기|단단|팽팽|굳|빳빳|뻣뻣|욱신|발딱|꼿꼿)`, String.raw`[^.!?。！？\n]{0,80}?`);

// 노출/젖은 몸/탈의는 위생 장면에서도 흔하다. 신체+동사의 일치만으로
// 성적 행위라고 단정하지 않고, 일치한 행동의 문장 맥락을 확인한다.
const HYGIENE = /\b(?:shower(?:s|ed|ing)?|bath(?:s|ing)?|bathe[ds]?|wash(?:es|ed|ing)?|rins(?:e|es|ed|ing)|soap(?:y)?|shampoo(?:s|ed|ing)?|scrub(?:s|bed|bing)?|lather(?:s|ed|ing)?|towell?(?:ed|ing)?|clean(?:s|ed|ing)?|dry(?:ing)?\s+(?:off|herself|himself))\b|샤워|목욕|씻|헹[구궈]|비누|샴푸|세정|물기|때를\s*(?:밀|벗)|수건.{0,20}(?:닦|말리)/i;
const NONSEXUAL = /\b(?:pain|injur(?:y|ies|ed)|wound|bruise[ds]?|sore|fever|shiver(?:s|ed|ing)?|medical|examin(?:e|es|ed|ing)|bandage|breastfeed(?:s|ing)?|nurs(?:e|es|ed|ing)\s+(?:a|the|her)\s+baby|chang(?:e|es|ed|ing)\s+(?:her|his|their|into|clothes))\b|통증|아파|아픈|부상|상처|멍든|진찰|검사|치료|수유|갈아입/i;
const SEXUAL_ACTION = /\b(?:lick(?:s|ed|ing)?|suck(?:s|ed|ing)?|fondl(?:e|es|ed|ing)|masturbat(?:e|es|ed|ing)|penetrat(?:e|es|ed|ing)|fuck(?:s|ed|ing)?|ejaculat(?:e|es|ed|ing)|orgasm(?:s|ed|ing)?|thrust(?:s|ed|ing)?)\b|핥|빨아|빨았|빨며|빨고|애무|자위|성교|사정(?:하|했|해|중)|오르가즘/i;
const SEXUAL_INTENT = /\b(?:sexually|sexual\s+(?:pleasure|stimulation|contact)|arous(?:e|ed|al)|lust(?:ful)?|masturbat(?:e|es|ed|ing)|fondl(?:e|es|ed|ing))\b|성적\s*(?:쾌감|자극|접촉|흥분)|애무|자위/i;
const NOT_AN_ACT = /\b(?:(?:did|does|do|is|was|were|will|would|could|had|has|have)\s+not|didn['’]t|doesn['’]t|don['’]t|wasn['’]t|isn['’]t|wouldn['’]t|couldn['’]t|never|without)\s+(?!(?:stop|ceas|pause|hesitat))|(?:하지|하지는|하지도|하지\s*않|핥지|빨지|문지르지|넣지|느끼지|삽입하지|사정하지).{0,12}(?:않|못)|(?:할|하려는)\s*(?:생각|계획)|\b(?:discuss(?:es|ed|ing)?|explain(?:s|ed|ing)?|definition|hypothetical)\b/i;

function sentenceAt(source, start, end) {
    const before = source.slice(Math.max(0, start - 180), start).match(/[^.!?。！？\n;]*$/)[0];
    const after = source.slice(end, end + 180).match(/^[^.!?。！？\n;]*/)[0];
    return before + source.slice(start, end) + after;
}

function paragraphAt(source, start, end) {
    return source.slice(Math.max(0, start - 600), start).split(/\n\s*\n/).at(-1)
        + source.slice(start, end) + source.slice(end, end + 600).split(/\n\s*\n/)[0];
}

function isWeakSignal(label) {
    return ['신음 표기', '현재 탈의·밀착', '성적 접촉 분위기'].includes(label);
}

const RULES = [
    { label: '현재 명시적 행위', w: 4, re: /삽입(?:하|했|해|되|된|되는|중)|박아\s*넣|쑤셔\s*넣|사정(?:하|했|해|시키|하며|하는|하려)|오르가즘(?:에|을)\s*(?:도달|느끼)|질\s*(?:안|속)에\s*(?:넣|박)|\bmasturbat(?:e|es|ed|ing)\b|자위(?:를)?\s*(?:하|했|해|중)|\bpenetrat(?:e|es|ed|ing)\b|\bthrust(?:ed|ing|s)?\s+(?:inside|into|against)\b|\borgasm(?:s|ed|ing)\b|\bejaculat(?:e|es|ed|ing)\b|\bcame\s+(?:inside|over|on)\b|\bcoming\s+(?:inside|in\s+her|in\s+him)\b/gi },
    { label: '영어 구강 접촉', w: 4, re: nearby(EN_BODY, EN_ORAL) },
    { label: '영어 입·혀 접촉', w: 4, re: nearby(EN_BODY, String.raw`\b(?:tongue|mouth)\b`), require: EN_ORAL_MOTION },
    { label: '영어 직접 행동', w: 4, re: nearby(EN_BODY, String.raw`\b(?:fuck(?:s|ed|ing)?|thrust(?:s|ed|ing)?|insert(?:s|ed|ing)?|fondl(?:e|es|ed|ing))\b`) },
    { label: '영어 손 접촉', w: 4, re: nearby(EN_HAND, EN_INTIMATE), require: EN_MOTION },
    { label: '한국어 직접 접촉', w: 4, re: nearby(KO_BODY, KO_TOUCH, String.raw`[^.!?。！？\n]{0,80}?`) },
    { label: '영어 의복·골반 마찰과 성적 반응', w: 4,
        re: nearby(String.raw`\b(?:jeans|sweatpants|trousers|underwear|panties|boxers|crotch|groin|pelvis|hips?|lap)\b`,
            String.raw`\b(?:rub(?:s|bed|bing)?|grind(?:s|ing)?|ground|friction|press(?:es|ed|ing)?|rock(?:s|ed|ing)?)\b`),
        requireParagraph: EN_GENITAL_RESPONSE },
    { label: '한국어 의복·골반 마찰과 성적 반응', w: 4,
        re: nearby(String.raw`(?:청바지|트레이닝\s*(?:팬츠|바지)|바지|속옷|팬티|가랑이|아랫도리|사타구니|골반|치골)`,
            String.raw`(?:문질|문지|비비|비벼|마찰|밀착|눌러|누르|맞대|밀어붙)`, String.raw`[^.!?。！？\n]{0,80}?`),
        requireParagraph: KO_GENITAL_RESPONSE },
    { label: '신음 표기', w: 3, re: /하앙|흐응|아앙|흐읏|하아앙|응아|앗\s*…?\s*안|\bmoan(?:ed|ing|s)?\b|\bwhimper(?:ed|ing)?\b/gi },
    { label: '현재 탈의·밀착', w: 2, re: /(?:옷|속옷|팬티|브래지어|바지|치마)(?:을|를)?\s*(?:벗기|벗겨|내리)|\bgrind(?:s|ing)?\s+(?:against|on|into)\b|\bground\s+(?:against|on|into)\b|\bstraddl(?:e|es|ed|ing)\s+(?:her|him|them)\b/gi },
    { label: '성적 접촉 분위기', w: 1, re: /키스가\s*깊어|혀가\s*얽|목덜미에\s*입|귓불을\s*(?:물|빨|핥)|\bkiss(?:es|ed|ing)?\s+(?:deeply|hungrily)\b|\btongues?\s+(?:tangled|met)\b|\bhands?\s+(?:slid|moved)\s+(?:under|between)\b/gi },
];

export function scoreScene(text, customKeywords = '') {
    const source = String(text ?? '')
        .replace(/<(scene_state|sfw_scene)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<(?:scene_state|sfw_scene)\b[^>]*>[\s\S]*$/gi, '')
        // 별개 행동을 한 쌍으로 연결하지 않는다. 샤워 뒤의 실제 성적 행동은 따로 검사한다.
        .replace(/\b(?:while|whereas|meanwhile|but\s+then)\b|하지만|그러나/gi, '\n');
    const hits = [];
    const candidates = [];
    for (const { label, re, w, require, requireParagraph } of RULES) {
        re.lastIndex = 0;
        let match;
        let count = 0;
        while (count < 3 && (match = re.exec(source)) !== null) {
            const sentence = sentenceAt(source, match.index, re.lastIndex);
            if (NOT_AN_ACT.test(sentence)) continue;
            if ((HYGIENE.test(sentence) || NONSEXUAL.test(sentence))
                && !SEXUAL_ACTION.test(match[0])) continue;
            // '샤워 중이다. 몸을 문질렀다.'처럼 위생 목적이 직전 문장에만 있어도 구분한다.
            if (HYGIENE.test(paragraphAt(source, match.index, re.lastIndex))
                && !SEXUAL_ACTION.test(match[0]) && !SEXUAL_INTENT.test(sentence)) continue;
            // 동사가 신체/도구보다 먼저 나오는 어순도 같은 문장 안에서 확인한다.
            if (require) {
                const before = source.slice(Math.max(0, match.index - 180), match.index).match(/[^.!?。！？\n]*$/)[0];
                const after = source.slice(re.lastIndex, re.lastIndex + 180).match(/^[^.!?。！？\n]*/)[0];
                if (!require.test(before + match[0] + after)) continue;
            }
            if (requireParagraph) {
                requireParagraph.lastIndex = 0;
                if (!requireParagraph.test(paragraphAt(source, match.index, re.lastIndex))) continue;
            }
            candidates.push({ label, text: match[0], w, start: match.index, end: re.lastIndex });
            count++;
        }
    }
    const strong = candidates.filter(hit => !isWeakSignal(hit.label));
    for (const hit of candidates) {
        // 키스·탈의·소리만 합산해서 자동 개입하지 않는다.
        if (isWeakSignal(hit.label) && !strong.some(other =>
            !/\n\s*\n/.test(source.slice(Math.min(hit.end, other.end), Math.max(hit.start, other.start))))) continue;
        hits.push({ label: hit.label, text: hit.text, w: hit.w });
    }
    const lower = source.toLocaleLowerCase();
    for (const keyword of String(customKeywords).split(',').map((word) => word.trim()).filter(Boolean)) {
        const needle = keyword.toLocaleLowerCase();
        for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + needle.length)) {
            const sentence = sentenceAt(source, index, index + keyword.length);
            if (!HYGIENE.test(sentence) && !NONSEXUAL.test(sentence) && !NOT_AN_ACT.test(sentence)) {
                hits.push({ label: '커스텀', text: keyword, w: 3 });
                break;
            }
        }
    }
    const score = hits.reduce((sum, hit) => sum + hit.w, 0);
    return { score, hits, routineOnly: HYGIENE.test(source) && score === 0 };
}
