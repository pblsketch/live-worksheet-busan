/**
 * 연수 설정 파일(공개 events/<id>.json + 비밀 events/<id>.secret.json)의 형식 검사.
 * 형식의 정의는 events/README.md 에 있다. 이 파일과 README를 함께 고친다.
 *
 * 서버(supabase/migrations/0002)는 등록된 설정을 읽어 제출을 검사한다.
 * 여기서는 등록 전에 설정 자체가 올바른지 본다.
 */
import { randomInt } from 'node:crypto';

export const EVENT_ID_RE = /^[a-z0-9-]{3,40}$/;
export const ACTIVITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const PART_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;       // 항목·학습목표·문장 틀 id
export const PASSCODE_RE = /^[A-Za-z0-9]{8,16}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 활동 종류 등록부(서버 검사 쪽 목록과 같아야 한다: lwb_validate_payload) */
export const ACTIVITY_TYPES = ['ox', 'stage_check', 'sentence', 'rewrite'];

const TOP_KEYS = ['id', 'title', 'date', 'listed', 'description', 'activities', 'materials'];
const COMMON_ACTIVITY_KEYS = ['id', 'type', 'title', 'description'];
const TYPE_KEYS = {
  ox: ['questions', 'choices'],
  stage_check: ['items', 'objectives', 'allowCustom', 'criteria', 'example', 'stages'],
  sentence: ['templates', 'image'],
  rewrite: ['round', 'pairOf', 'level', 'prompts', 'checks', 'maxLength', 'context']
};
const REWRITE_CONTEXT_KEYS = ['case', 'task', 'standard', 'grasps', 'guide', 'levels', 'note'];

/** rewrite 글자 수: 최소 5자, maxLength 기본 200 · 최대 300 */
export const REWRITE_MIN = 5;
export const REWRITE_MAX_LIMIT = 300;
/** 공개 파일에 들어가면 안 되는 비밀 칸(OX 정답 등) */
const SECRET_LIKE_KEYS = ['answers', 'answer', 'labels', 'notes', 'panel', 'admin_passcode', 'passcode', 'reveal'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.trim().length > 0;
const len = (s) => [...s].length; // 글자 수(코드 포인트)

function validDate(s) {
  if (!isStr(s) || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 문자열 안의 HTML 태그는 <b>, </b> 만 허용한다(화면이 그대로 그리는 문구 대비). */
function badTags(s) {
  const bad = [];
  for (const m of s.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
    if (m[0] !== '<b>' && m[0] !== '</b>') bad.push(m[0]);
  }
  return bad;
}

function walkStrings(v, path, fn) {
  if (isStr(v)) fn(v, path);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, fn));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) walkStrings(x, `${path}.${k}`, fn);
}

function uniqueIds(list, path, re, errors, { reserved = [] } = {}) {
  const seen = new Set();
  list.forEach((x, i) => {
    const p = `${path}[${i}].id`;
    if (!isObj(x)) return;
    if (!isStr(x.id) || !re.test(x.id)) errors.push(`${p}: id 형식이 틀렸습니다(${re}).`);
    else if (reserved.includes(x.id)) errors.push(`${p}: "${x.id}" 는 예약어라 쓸 수 없습니다.`);
    else if (seen.has(x.id)) errors.push(`${p}: id "${x.id}" 가 중복됩니다.`);
    else seen.add(x.id);
  });
}

function checkOx(a, p, errors) {
  if (!Array.isArray(a.questions) || a.questions.length === 0) {
    errors.push(`${p}.questions: 문항 문장 목록(1개 이상)이 필요합니다.`);
    return;
  }
  a.questions.forEach((q, i) => {
    if (!nonEmpty(q)) errors.push(`${p}.questions[${i}]: 문항은 비어 있지 않은 문자열이어야 합니다.`);
  });
  if (a.choices !== undefined) {
    if (!isObj(a.choices)) errors.push(`${p}.choices: { "O": "…", "X": "…" } 형식이어야 합니다.`);
    else for (const [k, v] of Object.entries(a.choices)) {
      if (k !== 'O' && k !== 'X') errors.push(`${p}.choices.${k}: O 또는 X 만 쓸 수 있습니다.`);
      else if (!isStr(v)) errors.push(`${p}.choices.${k}: 문자열이어야 합니다.`);
    }
  }
}

function checkStageCheck(a, p, errors) {
  if (!Array.isArray(a.items) || a.items.length === 0) {
    errors.push(`${p}.items: 항목 목록(1개 이상)이 필요합니다.`);
  } else {
    uniqueIds(a.items, `${p}.items`, PART_ID_RE, errors);
    a.items.forEach((it, i) => {
      if (!isObj(it)) return errors.push(`${p}.items[${i}]: 객체여야 합니다.`);
      if (!nonEmpty(it.name)) errors.push(`${p}.items[${i}].name: 항목 이름이 필요합니다.`);
      if (it.desc !== undefined && !isStr(it.desc)) errors.push(`${p}.items[${i}].desc: 문자열이어야 합니다.`);
    });
  }
  if (a.allowCustom !== undefined && typeof a.allowCustom !== 'boolean') {
    errors.push(`${p}.allowCustom: true 또는 false 여야 합니다.`);
  }
  const objectives = a.objectives ?? [];
  if (!Array.isArray(objectives)) {
    errors.push(`${p}.objectives: 배열이어야 합니다.`);
  } else {
    if (objectives.length === 0 && a.allowCustom !== true) {
      errors.push(`${p}.objectives: 학습목표 보기가 하나도 없고 직접 적기도 꺼져 있습니다.`);
    }
    uniqueIds(objectives, `${p}.objectives`, PART_ID_RE, errors, { reserved: ['custom'] });
    objectives.forEach((o, i) => {
      if (!isObj(o)) return errors.push(`${p}.objectives[${i}]: 객체여야 합니다.`);
      if (!nonEmpty(o.text)) errors.push(`${p}.objectives[${i}].text: 목표 문장이 필요합니다.`);
      for (const k of ['group', 'code']) {
        if (o[k] !== undefined && !isStr(o[k])) errors.push(`${p}.objectives[${i}].${k}: 문자열이어야 합니다.`);
      }
    });
  }
  if (a.criteria !== undefined) {
    const c = a.criteria;
    if (!isObj(c)) errors.push(`${p}.criteria: 객체여야 합니다.`);
    else {
      if (c.question !== undefined && !isStr(c.question)) errors.push(`${p}.criteria.question: 문자열이어야 합니다.`);
      if (c.common !== undefined && !isStr(c.common)) errors.push(`${p}.criteria.common: 문자열이어야 합니다.`);
      if (c.rules !== undefined && (!Array.isArray(c.rules) || !c.rules.every(isStr))) {
        errors.push(`${p}.criteria.rules: 문자열 배열이어야 합니다.`);
      }
    }
  }
  if (a.example !== undefined) {
    const e = a.example;
    if (!isObj(e)) errors.push(`${p}.example: 객체여야 합니다.`);
    else {
      if (e.label !== undefined && !isStr(e.label)) errors.push(`${p}.example.label: 문자열이어야 합니다.`);
      if (e.risk !== undefined && !['상', '중', '하', ''].includes(e.risk)) errors.push(`${p}.example.risk: 상·중·하 가운데 하나여야 합니다.`);
      if (e.stage !== undefined && e.stage !== null && ![1, 2, 3, 4, 5].includes(e.stage)) errors.push(`${p}.example.stage: 1~5 여야 합니다.`);
      if (e.memo !== undefined && (!isStr(e.memo) || len(e.memo) > 80)) errors.push(`${p}.example.memo: 80자 이내 문자열이어야 합니다.`);
    }
  }
  if (a.stages !== undefined) {
    if (!Array.isArray(a.stages) || a.stages.length !== 5) {
      errors.push(`${p}.stages: 허용 단계는 정확히 5개여야 합니다(없으면 기본 5단계).`);
    } else {
      a.stages.forEach((s, i) => {
        if (!isObj(s) || !nonEmpty(s.name)) errors.push(`${p}.stages[${i}].name: 단계 이름이 필요합니다.`);
        else if (s.color !== undefined && !(isStr(s.color) && /^#[0-9a-fA-F]{6}$/.test(s.color))) {
          errors.push(`${p}.stages[${i}].color: #rrggbb 형식이어야 합니다.`);
        }
      });
    }
  }
}

/** 그림 주소: 저장소 안 상대 경로(앞에 / 나 .. 없이) 또는 https 주소 */
function validImageSrc(s) {
  if (!nonEmpty(s)) return false;
  if (/^https:\/\//i.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('/') || s.startsWith('\\')) return false;
  return !s.split(/[\\/]/).includes('..');
}

function checkImage(a, p, errors) {
  if (a.image === undefined) return;
  const im = a.image;
  if (!isObj(im)) return errors.push(`${p}.image: { "src": "…", "alt": "…" } 형식이어야 합니다.`);
  if (!validImageSrc(im.src)) errors.push(`${p}.image.src: 저장소 안의 상대 경로(예: assets/img/grow.jpg)나 https 주소여야 합니다.`);
  if (im.alt !== undefined && !(isStr(im.alt) && len(im.alt) <= 200)) errors.push(`${p}.image.alt: 200자 이내 문자열이어야 합니다.`);
}

function checkSentence(a, p, errors) {
  checkImage(a, p, errors);
  if (!Array.isArray(a.templates) || a.templates.length === 0) {
    errors.push(`${p}.templates: 문장 틀 목록(1개 이상)이 필요합니다.`);
    return;
  }
  uniqueIds(a.templates, `${p}.templates`, PART_ID_RE, errors);
  a.templates.forEach((t, i) => {
    if (!isObj(t)) return errors.push(`${p}.templates[${i}]: 객체여야 합니다.`);
    for (const k of ['label', 'before', 'after']) {
      if (t[k] !== undefined && !isStr(t[k])) errors.push(`${p}.templates[${i}].${k}: 문자열이어야 합니다.`);
    }
    if (t.placeholder !== undefined && !(isStr(t.placeholder) && len(t.placeholder) <= 60)) {
      errors.push(`${p}.templates[${i}].placeholder: 60자 이내 문자열이어야 합니다(글상자 안내 문구).`);
    }
    if (a.templates.length > 1 && !nonEmpty(t.label)) {
      errors.push(`${p}.templates[${i}].label: 틀이 둘 이상이면 라벨이 필요합니다.`);
    }
    if (!nonEmpty(t.before) && !nonEmpty(t.after)) {
      errors.push(`${p}.templates[${i}]: 앞말(before)과 뒷말(after)이 모두 비어 있습니다.`);
    }
  });
}

/** rewrite 의 과제 맥락: 사례·과제 이름, 성취기준, GRASPS, 성취기준 해설, 성취수준 */
function checkRewriteContext(c, p, errors, warnings) {
  if (!isObj(c)) return errors.push(`${p}: 객체여야 합니다.`);
  for (const k of Object.keys(c)) if (!REWRITE_CONTEXT_KEYS.includes(k)) warnings.push(`${p}: 알 수 없는 칸 "${k}" (그대로 저장됩니다)`);
  for (const k of ['case', 'task', 'note']) {
    if (c[k] !== undefined && !isStr(c[k])) errors.push(`${p}.${k}: 문자열이어야 합니다.`);
  }
  if (c.standard !== undefined) {
    const s = c.standard;
    if (!isObj(s) || !nonEmpty(s.text)) errors.push(`${p}.standard: { "code", "text" } 형식이고 성취기준 문장(text)이 있어야 합니다.`);
    else if (s.code !== undefined && !isStr(s.code)) errors.push(`${p}.standard.code: 문자열이어야 합니다.`);
  }
  if (c.grasps !== undefined) {
    if (!Array.isArray(c.grasps) || c.grasps.length === 0) errors.push(`${p}.grasps: [{ "key", "name", "text" }] 1개 이상이어야 합니다.`);
    else c.grasps.forEach((g, i) => {
      if (!isObj(g) || !nonEmpty(g.text)) return errors.push(`${p}.grasps[${i}]: 내용(text)이 필요합니다.`);
      if (g.key !== undefined && !(isStr(g.key) && len(g.key) <= 4)) errors.push(`${p}.grasps[${i}].key: 4자 이내 문자열이어야 합니다(예: "G").`);
      if (g.name !== undefined && !isStr(g.name)) errors.push(`${p}.grasps[${i}].name: 문자열이어야 합니다.`);
    });
  }
  if (c.guide !== undefined) {
    const g = c.guide;
    if (!isObj(g) || !Array.isArray(g.items) || g.items.length === 0 || !g.items.every(nonEmpty)) {
      errors.push(`${p}.guide: { "title", "lead", "items": [문자열…], "source" } 형식이고 items 가 1개 이상이어야 합니다.`);
    } else {
      for (const k of ['title', 'lead', 'source']) {
        if (g[k] !== undefined && !isStr(g[k])) errors.push(`${p}.guide.${k}: 문자열이어야 합니다.`);
      }
    }
  }
  if (c.levels !== undefined) {
    const l = c.levels;
    if (!isObj(l) || !Array.isArray(l.items) || l.items.length === 0) {
      errors.push(`${p}.levels: { "title", "items": [{ "level", "text" }…], "source" } 형식이고 items 가 1개 이상이어야 합니다.`);
    } else {
      l.items.forEach((x, i) => {
        if (!isObj(x) || !(isStr(x.level) && x.level.trim() && len(x.level) <= 4) || !nonEmpty(x.text)) {
          errors.push(`${p}.levels.items[${i}]: 수준(level, 4자 이내)과 기술(text)이 필요합니다.`);
        }
      });
      for (const k of ['title', 'source']) {
        if (l[k] !== undefined && !isStr(l[k])) errors.push(`${p}.levels.${k}: 문자열이어야 합니다.`);
      }
    }
  }
}

/** rewrite 가 1차(round 1, 없으면 1)인가 */
const firstRound = (a) => isObj(a) && a.type === 'rewrite' && (a.round === undefined || a.round === 1);

function checkRewrite(a, p, errors, { warnings, pub }) {
  if (a.round !== undefined && a.round !== 1 && a.round !== 2) errors.push(`${p}.round: 1 또는 2 여야 합니다(없으면 1).`);
  if (a.level !== undefined && !(isStr(a.level) && len(a.level) <= 20)) errors.push(`${p}.level: 20자 이내 문자열이어야 합니다.`);
  if (a.maxLength !== undefined &&
      !(Number.isInteger(a.maxLength) && a.maxLength >= REWRITE_MIN && a.maxLength <= REWRITE_MAX_LIMIT)) {
    errors.push(`${p}.maxLength: ${REWRITE_MIN}~${REWRITE_MAX_LIMIT} 사이의 정수여야 합니다(없으면 200).`);
  }
  if (!Array.isArray(a.prompts) || a.prompts.length === 0) {
    errors.push(`${p}.prompts: 고쳐 쓸 문장 목록(1개 이상)이 필요합니다.`);
  } else {
    uniqueIds(a.prompts, `${p}.prompts`, PART_ID_RE, errors);
    a.prompts.forEach((x, i) => {
      if (!isObj(x)) return errors.push(`${p}.prompts[${i}]: 객체여야 합니다.`);
      if (!nonEmpty(x.text)) errors.push(`${p}.prompts[${i}].text: 문장이 필요합니다.`);
      if (x.element !== undefined && !nonEmpty(x.element)) errors.push(`${p}.prompts[${i}].element: 평가 요소는 비어 있지 않은 문자열이어야 합니다.`);
    });
    if (a.prompts.length > 9) warnings.push(`${p}.prompts: 현황판 숫자 키(1~9)로는 앞의 9개만 고를 수 있습니다.`);
  }
  if (a.checks !== undefined && (!Array.isArray(a.checks) || !a.checks.every(nonEmpty))) {
    errors.push(`${p}.checks: 비어 있지 않은 문자열 배열이어야 합니다.`);
  }
  if (a.context !== undefined) checkRewriteContext(a.context, `${p}.context`, errors, warnings);

  // 짝: 2차는 같은 연수의 1차 rewrite 와 짝짓는다
  const acts = Array.isArray(pub.activities) ? pub.activities : [];
  if (a.pairOf !== undefined) {
    if (a.round !== 2) errors.push(`${p}.pairOf: 2차(round 2) 활동에만 둘 수 있습니다.`);
    const q = acts.find((x) => isObj(x) && x.id === a.pairOf);
    if (!isStr(a.pairOf) || !q || q === a) errors.push(`${p}.pairOf: 같은 연수에 있는 다른 활동 id 여야 합니다.`);
    else if (!firstRound(q)) errors.push(`${p}.pairOf: "${a.pairOf}" 는 1차(round 1) rewrite 활동이 아닙니다.`);
    else if (Array.isArray(q.prompts) && Array.isArray(a.prompts)) {
      const ids = (xs) => xs.filter(isObj).map((x) => x.id).sort().join(',');
      if (ids(q.prompts) !== ids(a.prompts)) {
        errors.push(`${p}.prompts: 짝 활동 "${a.pairOf}" 와 문장 id 가 같아야 합니다(1차에서 고른 문장을 2차에서 고쳐 쓴다).`);
      } else if (a.prompts.some((x) => isObj(x) && !q.prompts.some((y) => isObj(y) && y.id === x.id && y.text === x.text))) {
        warnings.push(`${p}.prompts: 짝 활동 "${a.pairOf}" 와 문장 글이 다릅니다.`);
      }
    }
  } else if (a.round === 2) {
    const i = acts.indexOf(a);
    const prev = acts.slice(0, Math.max(0, i)).reverse().find(firstRound);
    if (prev) warnings.push(`${p}.pairOf: 없어서 앞쪽의 1차 활동 "${prev.id}" 와 짝짓습니다.`);
    else errors.push(`${p}.pairOf: 2차 활동은 짝이 되는 1차 활동 id(pairOf)가 필요합니다.`);
  }
}

const TYPE_CHECK = { ox: checkOx, stage_check: checkStageCheck, sentence: checkSentence, rewrite: checkRewrite };

/**
 * 공개 설정 검사.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validatePublic(id, pub) {
  const errors = [];
  const warnings = [];
  if (!isStr(id) || !EVENT_ID_RE.test(id)) errors.push(`연수 id "${id}": 소문자·숫자·하이픈 3~40자여야 합니다.`);
  if (!isObj(pub)) {
    errors.push('공개 설정은 JSON 객체여야 합니다.');
    return { errors, warnings };
  }
  for (const k of Object.keys(pub)) if (!TOP_KEYS.includes(k)) warnings.push(`알 수 없는 칸 "${k}" (그대로 저장됩니다)`);
  if (pub.id !== undefined && pub.id !== id) errors.push(`id: 파일 안의 id "${pub.id}" 가 파일 이름의 id "${id}" 와 다릅니다.`);
  if (!nonEmpty(pub.title)) errors.push('title: 제목이 필요합니다.');
  else if (len(pub.title.trim()) > 200) errors.push('title: 200자 이내여야 합니다.');
  if (pub.date === undefined) errors.push('date: 날짜가 필요합니다(YYYY-MM-DD).');
  else if (!validDate(pub.date)) errors.push(`date: "${pub.date}" 는 올바른 날짜(YYYY-MM-DD)가 아닙니다.`);
  if (pub.listed !== undefined && typeof pub.listed !== 'boolean') errors.push('listed: true 또는 false 여야 합니다.');
  if (pub.description !== undefined && !isStr(pub.description)) errors.push('description: 문자열이어야 합니다.');

  if (!Array.isArray(pub.activities) || pub.activities.length === 0) {
    errors.push('activities: 활동 목록(1개 이상)이 필요합니다.');
  } else {
    uniqueIds(pub.activities, 'activities', ACTIVITY_ID_RE, errors);
    pub.activities.forEach((a, i) => {
      const p = `activities[${i}]${isObj(a) && isStr(a.id) ? `(${a.id})` : ''}`;
      if (!isObj(a)) return errors.push(`${p}: 객체여야 합니다.`);
      if (a.type === undefined) return errors.push(`${p}.type: 활동 종류가 필요합니다.`);
      if (!ACTIVITY_TYPES.includes(a.type)) {
        return errors.push(`${p}.type: 알 수 없는 종류 "${a.type}" (가능: ${ACTIVITY_TYPES.join(', ')})`);
      }
      if (!nonEmpty(a.title)) errors.push(`${p}.title: 활동 제목이 필요합니다.`);
      if (a.description !== undefined && !isStr(a.description)) errors.push(`${p}.description: 문자열이어야 합니다.`);
      for (const k of Object.keys(a)) {
        if (SECRET_LIKE_KEYS.includes(k)) {
          errors.push(`${p}.${k}: 정답·해설·패널 같은 공개 전용 내용은 비밀 파일(reveal)에 두세요.`);
        } else if (!COMMON_ACTIVITY_KEYS.includes(k) && !TYPE_KEYS[a.type].includes(k)) {
          warnings.push(`${p}: 알 수 없는 칸 "${k}" (그대로 저장됩니다)`);
        }
      }
      TYPE_CHECK[a.type](a, p, errors, { warnings, pub });
    });
  }

  if (pub.materials !== undefined) {
    if (!Array.isArray(pub.materials)) errors.push('materials: 배열이어야 합니다.');
    else pub.materials.forEach((m, i) => {
      const p = `materials[${i}]`;
      if (!isObj(m)) return errors.push(`${p}: 객체여야 합니다.`);
      if (!nonEmpty(m.title)) errors.push(`${p}.title: 자료 제목이 필요합니다.`);
      if (!['자료', '도구'].includes(m.kind)) errors.push(`${p}.kind: "자료" 또는 "도구" 여야 합니다.`);
      if (m.desc !== undefined && !isStr(m.desc)) errors.push(`${p}.desc: 문자열이어야 합니다.`);
      if (m.url === undefined || !isStr(m.url)) errors.push(`${p}.url: 문자열이어야 합니다(준비 중이면 "").`);
      else if (m.url !== '' && /^[a-z][a-z0-9+.-]*:/i.test(m.url) && !/^https?:\/\//i.test(m.url)) {
        errors.push(`${p}.url: http(s) 주소나 저장소 안의 상대 경로만 쓸 수 있습니다.`);
      }
    });
  }

  walkStrings(pub, '', (s, path) => {
    const bad = badTags(s);
    if (bad.length) errors.push(`${path.replace(/^\./, '')}: 허용하지 않는 HTML 태그 ${bad.join(' ')} (<b>만 쓸 수 있습니다)`);
  });
  return { errors, warnings };
}

/**
 * 비밀 설정 검사(공개 설정이 통과한 뒤에 부른다).
 * 암호가 비어 있으면 오류가 아니다(등록할 때 새로 만든다).
 */
export function validateSecret(pub, sec) {
  const errors = [];
  const warnings = [];
  if (!isObj(sec)) {
    errors.push('비밀 설정은 JSON 객체여야 합니다.');
    return { errors, warnings };
  }
  for (const k of Object.keys(sec)) {
    if (!['admin_passcode', 'reveal'].includes(k)) warnings.push(`비밀 파일의 알 수 없는 칸 "${k}" (무시합니다)`);
  }
  const pc = sec.admin_passcode;
  if (pc !== undefined && pc !== null && pc !== '' && !(isStr(pc) && PASSCODE_RE.test(pc))) {
    errors.push('admin_passcode: 관리자 암호는 영문·숫자 8~16자여야 합니다.');
  }
  const reveal = sec.reveal ?? {};
  if (!isObj(reveal)) {
    errors.push('reveal: 객체여야 합니다({ "<ox 활동 id>": {...} }).');
    return { errors, warnings };
  }
  const acts = new Map((pub.activities || []).map((a) => [a.id, a]));
  for (const k of Object.keys(reveal)) {
    const a = acts.get(k);
    if (!a) errors.push(`reveal.${k}: 공개 설정에 없는 활동입니다.`);
    else if (a.type !== 'ox') errors.push(`reveal.${k}: 공개 전용 내용은 ox 활동에만 둘 수 있습니다(이 활동은 ${a.type}).`);
  }
  for (const a of pub.activities || []) {
    if (a.type !== 'ox') continue;
    const n = a.questions.length;
    const r = reveal[a.id];
    const p = `reveal.${a.id}`;
    if (!isObj(r)) {
      errors.push(`${p}: ox 활동의 정답이 없습니다(문항 ${n}개, 정답 0개).`);
      continue;
    }
    for (const k of Object.keys(r)) {
      if (!['answers', 'labels', 'notes', 'panel'].includes(k)) warnings.push(`${p}: 알 수 없는 칸 "${k}" (그대로 저장됩니다)`);
    }
    if (!Array.isArray(r.answers)) errors.push(`${p}.answers: 정답 배열이 필요합니다(문항 ${n}개).`);
    else {
      if (r.answers.length !== n) errors.push(`${p}.answers: 문항 ${n}개와 정답 ${r.answers.length}개의 수가 다릅니다.`);
      if (!r.answers.every((x) => x === 'O' || x === 'X')) errors.push(`${p}.answers: 정답은 "O" 또는 "X" 여야 합니다.`);
    }
    for (const k of ['labels', 'notes']) {
      if (r[k] === undefined) continue;
      if (!Array.isArray(r[k]) || !r[k].every(isStr)) errors.push(`${p}.${k}: 문자열 배열이어야 합니다.`);
      else if (r[k].length !== n) errors.push(`${p}.${k}: 문항 ${n}개와 ${k} ${r[k].length}개의 수가 다릅니다.`);
    }
    if (r.panel !== undefined) {
      if (!Array.isArray(r.panel)) errors.push(`${p}.panel: 배열이어야 합니다.`);
      else r.panel.forEach((m, i) => {
        const q = `${p}.panel[${i}]`;
        if (!isObj(m)) return errors.push(`${q}: 객체여야 합니다.`);
        if (!nonEmpty(m.name)) errors.push(`${q}.name: 이름이 필요합니다.`);
        if (m.desc !== undefined && !isStr(m.desc)) errors.push(`${q}.desc: 문자열이어야 합니다.`);
        if (!Array.isArray(m.picks) || m.picks.length !== n || !m.picks.every((x) => x === 'O' || x === 'X')) {
          errors.push(`${q}.picks: O/X ${n}개가 필요합니다.`);
        }
        if (m.score !== undefined && !isStr(m.score)) errors.push(`${q}.score: 문자열이어야 합니다(예: "2/3").`);
      });
    }
  }
  return { errors, warnings };
}

/** 이 연수가 가져야 할 진행 설정 키 */
export function settingKeys(pub) {
  const keys = [];
  for (const a of pub.activities || []) {
    keys.push(`open:${a.id}`);
    if (a.type === 'ox') keys.push(`reveal:${a.id}`);
  }
  keys.push('materials_open');
  return keys;
}

/** DB의 lwb_events.config 에 넣을 공개 설정(연수 열로 따로 두는 칸은 뺀다) */
export function publicConfig(pub) {
  const { id: _id, title: _t, date: _d, listed: _l, ...rest } = pub;
  return rest;
}

/** 휴대폰으로 치기 쉬운 영문·숫자 암호(헷갈리는 0 O o 1 l I 는 뺀다) */
export function generatePasscode(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  while (s.length < length) s += chars[randomInt(chars.length)];
  // 숫자와 영문이 모두 들어가게 한다(아니면 다시 뽑는다)
  return /[0-9]/.test(s) && /[A-Za-z]/.test(s) ? s : generatePasscode(length);
}
