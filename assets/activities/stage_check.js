/**
 * 활동 부품: stage_check (학습목표를 고르고, 항목마다 외주화 위험·AI 허용 단계·장치 메모를 적는다)
 *
 * 공개 설정: items[{id,name,desc?}], objectives[{id,group?,text,code?}], allowCustom?,
 *           criteria?{question,rules[],common}, example?{label,risk,stage,memo}, stages?[5개 {name,color}]
 * payload: { objective: { id: '<보기 id>'|'custom', text? }, items: { '<항목 id>': { risk, stage, memo } } }
 * 설정 문구는 <b>만 살려 그린다(rich). 참가자가 적은 글은 모두 이스케이프한다(esc).
 */
import { esc, rich, len, oneLine } from '../core.js';

export const DEFAULT_STAGES = [
  { name: '혼자 힘으로', color: '#7d9b5a' },
  { name: '생각 틔우기', color: '#5f814f' },
  { name: '초안 거들기', color: '#4a7a76' },
  { name: '함께 다듬기', color: '#35507c' },
  { name: '같이 만들기', color: '#2a4066' }
];
export const RISKS = ['상', '중', '하'];
const MEMO_MAX = 80;
const CUSTOM_MIN = 2;
const CUSTOM_MAX = 80;

/** 허용 단계 다섯 개 [{ n, name, color }] (설정에 stages가 있으면 그것을 쓴다) */
export function stagesOf(activity) {
  const s = Array.isArray(activity.stages) && activity.stages.length === 5 ? activity.stages : null;
  return DEFAULT_STAGES.map((d, i) => ({
    n: i + 1,
    name: (s && s[i] && s[i].name) || d.name,
    color: (s && s[i] && /^#[0-9a-fA-F]{6}$/.test(s[i].color || '') && s[i].color) || d.color
  }));
}

/** 응답의 학습목표 → { group, text, custom } */
export function objectiveOf(activity, objective) {
  if (!objective) return null;
  if (objective.id === 'custom') return { group: '직접 적은 목표', text: objective.text || '', custom: true };
  const o = (activity.objectives || []).find((x) => x.id === objective.id);
  return o ? { group: o.group || '', text: o.text, code: o.code || '', custom: false } : null;
}

/** 항목 하나가 채워졌는가 */
export function filled(v) {
  return !!(v && (v.risk || v.stage || oneLine(v.memo)));
}

const clone = (x) => JSON.parse(JSON.stringify(x || {}));

/* ───────────── 참가자 화면 ───────────── */

function participant(ctx) {
  const a = ctx.activity;
  const items = a.items || [];
  const objectives = a.objectives || [];
  const stages = stagesOf(a);
  const root = ctx.root;
  const draft = ctx.draft;
  let cur = ctx;

  const saved = draft.load();
  let form = normalize(saved || (ctx.mine ? clone(ctx.mine) : {}));
  // 낸 적이 있으면 제출 화면부터 보인다. 고쳐 쓰던 내용이 기기에 있고 활동이 열려 있으면 입력 화면으로 간다.
  let mode = ctx.mine && (!saved || !ctx.isOpen) ? 'result' : 'form';

  function normalize(f) {
    const out = { objective: null, items: {} };
    if (f && f.objective && typeof f.objective.id === 'string') {
      out.objective = { id: f.objective.id, text: typeof f.objective.text === 'string' ? f.objective.text : '' };
      if (out.objective.id === 'custom' && a.allowCustom !== true) out.objective = null;
      if (out.objective && out.objective.id !== 'custom' && !objectives.some((o) => o.id === out.objective.id)) out.objective = null;
    }
    const src = (f && f.items) || {};
    for (const it of items) {
      const v = src[it.id] || {};
      out.items[it.id] = {
        risk: RISKS.includes(v.risk) ? v.risk : '',
        stage: [1, 2, 3, 4, 5].includes(v.stage) ? v.stage : null,
        memo: typeof v.memo === 'string' ? v.memo : ''
      };
    }
    return out;
  }

  const save = () => draft.save(form);

  /* ─── 입력 화면 ─── */

  function objectiveHTML() {
    const chosen = form.objective ? form.objective.id : '';
    return objectives.map((o) =>
      `<label class="obj${chosen === o.id ? ' on' : ''}">` +
      `<input type="radio" name="obj" value="${esc(o.id)}"${chosen === o.id ? ' checked' : ''}>` +
      '<span class="obj-body">' +
      (o.group ? `<span class="obj-grp">${rich(o.group)}</span>` : '') +
      `<span class="obj-txt">${rich(o.text)}</span>` +
      (o.code ? `<span class="obj-code">${esc(o.code)}</span>` : '') +
      '</span></label>').join('') +
      (a.allowCustom === true
        ? `<label class="obj custom${chosen === 'custom' ? ' on' : ''}">` +
          `<input type="radio" name="obj" value="custom"${chosen === 'custom' ? ' checked' : ''}>` +
          '<span class="obj-body"><span class="obj-txt">직접 적기</span></span></label>' +
          `<input type="text" class="obj-custom" maxlength="${CUSTOM_MAX}" placeholder="학습목표를 한 줄로 적어 주세요 (${CUSTOM_MIN}~${CUSTOM_MAX}자)"` +
          ` value="${esc(chosen === 'custom' ? form.objective.text : '')}"${chosen === 'custom' ? '' : ' hidden'}>`
        : '');
  }

  function criteriaHTML() {
    const c = a.criteria;
    if (!c || (!c.question && !(c.rules || []).length && !c.common)) return '';
    return '<details class="crit" open><summary>판단 기준</summary>' +
      (c.question ? `<div class="q">${rich(c.question)}</div>` : '') +
      ((c.rules || []).length ? `<ol>${c.rules.map((r) => `<li>${rich(r)}</li>`).join('')}</ol>` : '') +
      (c.common ? `<div class="rule">${rich(c.common)}</div>` : '') +
      '</details>';
  }

  function exampleHTML() {
    const e = a.example;
    if (!e) return '';
    const st = e.stage ? stages[e.stage - 1] : null;
    const parts = [];
    if (e.risk) parts.push(`외주화 위험 <b>${esc(e.risk)}</b>`);
    if (st) parts.push(`허용 단계 <b>${st.n} ${esc(st.name)}</b>`);
    if (e.memo) parts.push(`장치 <b>${rich(e.memo)}</b>`);
    return '<div class="ex"><div class="lb">기입 예시</div>' +
      `<div class="rowline">${e.label ? `${rich(e.label)} → ` : ''}${parts.join(' · ')}</div></div>`;
  }

  function itemHTML(it, k) {
    const v = form.items[it.id];
    const ph = a.example && a.example.memo ? `예) ${a.example.memo}` : '한 줄로 적어 주세요';
    return `<div class="item" data-item="${esc(it.id)}">` +
      '<div class="item-h">' +
      `<div class="no">${k + 1}</div>` +
      `<div class="nm">${rich(it.name)}${it.desc ? `<div class="ds">${rich(it.desc)}</div>` : ''}</div>` +
      '</div>' +
      '<div class="sub-label">외주화 위험 · 지시문을 그대로 AI에 넣으면 3분 안에 나오는가?</div>' +
      '<div class="seg risk">' +
      RISKS.map((r) => `<button type="button" data-risk="${r}" class="${v.risk === r ? 'on' : ''}">${r}</button>`).join('') +
      '</div>' +
      '<div class="sub-label">AI 허용 단계 · 나라면 몇 단계로 열까?</div>' +
      '<div class="seg stage">' +
      stages.map((s) =>
        `<button type="button" data-stage="${s.n}" class="${v.stage === s.n ? 'on' : ''}" style="--c:${s.color}">` +
        `<b>${s.n}</b><small>${esc(s.name)}</small></button>`).join('') +
      '</div>' +
      '<div class="sub-label">배움을 지키는 장치 · 학생이 직접 하게 만들 방법 한 줄</div>' +
      `<input type="text" data-memo maxlength="${MEMO_MAX}" placeholder="${esc(ph)}" value="${esc(v.memo)}">` +
      '</div>';
  }

  function itemsHTML() {
    if (!form.objective) {
      return '<div class="locked-items">학습목표를 고르면 항목 카드가 열립니다.</div>';
    }
    return items.map(itemHTML).join('');
  }

  function drawForm() {
    root.innerHTML =
      (a.description ? `<div class="hint lead">${rich(a.description)}</div>` : '') +
      '<div class="step"><span>1</span>학습목표 고르기</div>' +
      '<div class="hint step-hint">이 과제의 학습목표를 하나 고르세요.</div>' +
      `<div class="objs" id="objs">${objectiveHTML()}</div>` +
      criteriaHTML() +
      exampleHTML() +
      '<div class="step"><span>2</span>항목별 판단</div>' +
      '<div class="hint step-hint">항목마다 세 칸을 채웁니다. 막히면 건너뛰어도 됩니다. ' +
      '정답이 있는 활동이 아닙니다.</div>' +
      `<div id="items">${itemsHTML()}</div>` +
      '<div class="save-note">적은 내용은 이 기기에 저장됩니다.</div>' +
      (a.criteria ? '<button type="button" class="link-btn" data-act="crit">판단 기준 다시 보기</button>' : '') +
      `<div class="sticky-b"><button class="btn" data-act="submit">${cur.mine ? '고쳐서 다시 내기' : '제출하기'}</button></div>`;
    bindForm();
  }

  function bindForm() {
    const objs = root.querySelector('#objs');
    objs.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name !== 'obj') return;
      const wasLocked = !form.objective;
      const text = form.objective && form.objective.id === 'custom' ? form.objective.text : '';
      form.objective = { id: t.value, text: t.value === 'custom' ? text : '' };
      objs.querySelectorAll('.obj').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
      const ci = objs.querySelector('.obj-custom');
      if (ci) {
        ci.hidden = t.value !== 'custom';
        if (t.value === 'custom') ci.focus();
      }
      save();
      if (wasLocked) {
        root.querySelector('#items').innerHTML = itemsHTML();
      }
    });
    const ci = objs.querySelector('.obj-custom');
    if (ci) {
      ci.addEventListener('input', () => {
        if (form.objective && form.objective.id === 'custom') { form.objective.text = ci.value; save(); }
      });
    }

    const box = root.querySelector('#items');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const card = b.closest('[data-item]');
      if (!card) return;
      const v = form.items[card.dataset.item];
      if (b.dataset.risk) {
        v.risk = v.risk === b.dataset.risk ? '' : b.dataset.risk; // 다시 누르면 지운다
        card.querySelectorAll('[data-risk]').forEach((x) => x.classList.toggle('on', x.dataset.risk === v.risk));
      } else if (b.dataset.stage) {
        const n = Number(b.dataset.stage);
        v.stage = v.stage === n ? null : n;
        card.querySelectorAll('[data-stage]').forEach((x) => x.classList.toggle('on', Number(x.dataset.stage) === v.stage));
      } else return;
      save();
    });
    box.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.matches('[data-memo]')) return;
      const card = t.closest('[data-item]');
      form.items[card.dataset.item].memo = t.value;
      save();
    });

    const crit = root.querySelector('[data-act="crit"]');
    if (crit) {
      crit.onclick = () => {
        const d = root.querySelector('details.crit');
        if (!d) return;
        d.open = true;
        d.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
    }
    root.querySelector('[data-act="submit"]').onclick = submit;
  }

  async function submit(e) {
    const btn = e.currentTarget;
    const o = form.objective;
    if (!o) {
      cur.toast('학습목표를 먼저 골라 주세요.');
      root.querySelector('#objs').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    let objective = { id: o.id };
    if (o.id === 'custom') {
      const t = oneLine(o.text);
      if (len(t) < CUSTOM_MIN || len(t) > CUSTOM_MAX) {
        cur.toast(`직접 적은 학습목표는 ${CUSTOM_MIN}~${CUSTOM_MAX}자로 적어 주세요.`);
        return;
      }
      objective = { id: 'custom', text: t };
    }
    const out = {};
    for (const it of items) {
      const v = form.items[it.id];
      if (!filled(v)) continue;
      const memo = oneLine(v.memo);
      if (len(memo) > MEMO_MAX) { cur.toast(`메모는 ${MEMO_MAX}자 이내로 적어 주세요.`); return; }
      out[it.id] = { risk: v.risk || '', stage: v.stage || null, memo };
    }
    if (!Object.keys(out).length) { cur.toast('적어도 한 항목은 채워 주세요.'); return; }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '제출하는 중…';
    const ok = await cur.submit({ objective, items: out });
    if (!ok) { btn.disabled = false; btn.textContent = label; return; }
    draft.clear();
    cur.toast('제출했습니다.');
    mode = 'result';
    window.scrollTo(0, 0);
    drawResult();
  }

  /* ─── 제출 뒤 화면 ─── */

  function rowsHTML(payload) {
    const its = (payload && payload.items) || {};
    const lines = items.filter((it) => filled(its[it.id])).map((it) => {
      const v = its[it.id];
      const st = v.stage ? stages[v.stage - 1] : null;
      return '<div class="pline">' +
        `<span class="pact">${rich(it.name)}</span>` +
        `<span class="prisk r${esc(v.risk || '')}">${esc(v.risk || '·')}</span>` +
        (st ? `<span class="pstage" style="--c:${st.color}">${st.n}</span>` : '<span class="pstage none">·</span>') +
        (oneLine(v.memo) ? `<span class="pmemo">${esc(v.memo)}</span>` : '') +
        '</div>';
    });
    return lines.join('');
  }

  function objectiveLine(payload) {
    const ob = objectiveOf(a, payload && payload.objective);
    if (!ob) return '';
    return `<div class="pobj">${ob.group ? `<span class="obj-grp">${ob.custom ? esc(ob.group) : rich(ob.group)}</span>` : ''}` +
      `<span>${ob.custom ? esc(ob.text) : rich(ob.text)}</span></div>`;
  }

  function drawResult() {
    cur.need(['responses', 'participants']);
    const mine = cur.mine;
    const rows = (cur.rows || []).slice(0, 80);
    const names = cur.names;
    const count = (cur.rows || []).length;
    const k = mine ? Object.keys(mine.items || {}).filter((id) => filled(mine.items[id])).length : 0;

    const feed = rows.map((r) =>
      `<div class="detail${r.participant_id === cur.me.id ? ' mine' : ''}">` +
      `<div class="hd"><div class="nm">${esc((names && names.get(r.participant_id)) || (r.participant_id === cur.me.id ? cur.me.name : '…'))}</div></div>` +
      objectiveLine(r.payload) +
      rowsHTML(r.payload) +
      '</div>').join('');

    root.innerHTML =
      '<div class="card blue center">' +
      '<div class="done-mark">✓</div>' +
      '<div class="serif big-t">제출했습니다</div>' +
      `<div class="hint">${k}개 항목을 채웠습니다. 다시 내면 앞의 제출을 덮어씁니다.</div>` +
      '</div>' +
      (mine ? `<div class="card flat mine-box">${objectiveLine(mine)}${rowsHTML(mine)}</div>` : '') +
      (cur.isOpen ? '<button class="btn line" data-act="edit">고쳐서 다시 내기</button>' : '<div class="hint center">진행자가 활동을 닫아 더 고칠 수 없습니다.</div>') +
      `<div class="section-t">모두의 판단 · ${count}명 <span class="live-inline">${cur.liveBadge}</span></div>` +
      (feed || '<div class="empty">아직 낸 사람이 없습니다.</div>') +
      '<div class="sticky-b"><button class="btn" data-act="menu">메뉴로</button></div>';

    const edit = root.querySelector('[data-act="edit"]');
    if (edit) {
      edit.onclick = () => {
        form = normalize(draft.load() || clone(cur.mine));
        mode = 'form';
        window.scrollTo(0, 0);
        drawForm();
      };
    }
    root.querySelector('[data-act="menu"]').onclick = () => cur.goMenu();
  }

  if (mode === 'result') drawResult();
  else drawForm();

  return {
    update(next) {
      const wasOpen = cur.isOpen;
      cur = next;
      if (mode === 'result') { drawResult(); return; }
      // 고쳐 쓰던 중에 활동이 닫히면 제출 화면으로 돌아간다(적던 내용은 기기에 남는다)
      if (wasOpen && !next.isOpen && next.mine) {
        mode = 'result';
        next.toast('진행자가 활동을 닫았습니다. 적던 내용은 이 기기에 남아 있습니다.');
        drawResult();
      }
    },
    destroy() {}
  };
}

/* ───────────── 관리자 카드·응답 ───────────── */

function summary(activity) {
  const n = (activity.items || []).length;
  const o = (activity.objectives || []).length;
  return `항목 ${n}개 · 학습목표 보기 ${o}개${activity.allowCustom === true ? ' + 직접 적기' : ''}`;
}

function adminCard(ctx) {
  const rows = ctx.rows || [];
  if (!rows.length) return '';
  const custom = rows.filter((r) => r.payload && r.payload.objective && r.payload.objective.id === 'custom').length;
  let memos = 0;
  for (const r of rows) {
    for (const v of Object.values((r.payload && r.payload.items) || {})) if (oneLine(v && v.memo)) memos++;
  }
  return `메모 ${memos}개${custom ? ` · 직접 적은 목표 ${custom}명` : ''}`;
}

function adminResponse(ctx, row) {
  const a = ctx.activity;
  const stages = stagesOf(a);
  const p = row.payload || {};
  const ob = objectiveOf(a, p.objective);
  const its = p.items || {};
  return (ob ? `<div class="pobj">${ob.group ? `<span class="obj-grp">${ob.custom ? esc(ob.group) : rich(ob.group)}</span>` : ''}` +
      `<span>${ob.custom ? esc(ob.text) : rich(ob.text)}</span></div>` : '') +
    (a.items || []).filter((it) => filled(its[it.id])).map((it) => {
      const v = its[it.id];
      const st = v.stage ? stages[v.stage - 1] : null;
      return '<div class="pline">' +
        `<span class="pno">${(a.items || []).indexOf(it) + 1}</span>` +
        `<span class="pact">${rich(it.name)}</span>` +
        `<span class="prisk r${esc(v.risk || '')}">${esc(v.risk || '·')}</span>` +
        (st ? `<span class="pstage" style="--c:${st.color}">${st.n}</span>` : '<span class="pstage none">·</span>') +
        (oneLine(v.memo) ? `<span class="pmemo">${esc(v.memo)}</span>` : '') +
        '</div>';
    }).join('');
}

/* ───────────── 현황판 계산 (순수 함수) ───────────── */

/**
 * 현황판 보기 목록: 전체 → 학습목표 보기(설정 순서) → 직접 적은 목표(허용할 때 한 묶음)
 * key 는 'all' | 'o:<보기 id>' | 'custom'
 */
export function boardViews(activity) {
  const views = [{ key: 'all', kind: 'all', label: '전체' }];
  (activity.objectives || []).forEach((o, i) => {
    views.push({ key: `o:${o.id}`, kind: 'objective', label: o.group || `목표 ${i + 1}`, objective: o });
  });
  if (activity.allowCustom === true) views.push({ key: 'custom', kind: 'custom', label: '직접 적은 목표' });
  return views;
}

/** 보기 하나에 드는 응답만 고른다(view 는 보기 객체나 key) */
export function rowsInView(rows, view) {
  const key = typeof view === 'string' ? view : (view && view.key);
  const list = rows || [];
  if (!key || key === 'all') return list.slice();
  return list.filter((r) => {
    const o = r && r.payload && r.payload.objective;
    if (!o || typeof o.id !== 'string') return false;
    return key === 'custom' ? o.id === 'custom' : key === `o:${o.id}`;
  });
}

/**
 * 항목 × 단계 집계.
 * items: [{ id, stage:[1~5단계 인원], tot(단계를 고른 사람), risk:{상,중,하}, riskTot }]
 * memos: [{ item, pid, memo, at }] (응답 순서 = 최근 제출 순)
 */
export function heatmap(activity, rows) {
  const defs = activity.items || [];
  const items = defs.map((it) => ({ id: it.id, stage: [0, 0, 0, 0, 0], tot: 0, risk: { 상: 0, 중: 0, 하: 0 }, riskTot: 0 }));
  const byId = new Map(items.map((x) => [x.id, x]));
  const memos = [];
  for (const r of rows || []) {
    const its = (r && r.payload && r.payload.items) || {};
    for (const it of defs) {
      const v = its[it.id];
      if (!v || typeof v !== 'object') continue;
      const h = byId.get(it.id);
      if (Number.isInteger(v.stage) && v.stage >= 1 && v.stage <= 5) { h.stage[v.stage - 1]++; h.tot++; }
      if (RISKS.includes(v.risk)) { h.risk[v.risk]++; h.riskTot++; }
      const m = oneLine(v.memo);
      if (m) memos.push({ item: it.id, pid: r.participant_id, memo: m, at: r.updated_at || r.created_at || '' });
    }
  }
  return { items, memos };
}

/** 「판단 갈림」 규칙(지학사 판과 같다) */
export const SPLIT_RULE = Object.freeze({ minPeople: 5, maxShare: 0.45, minStages: 3, limit: 3 });

/**
 * 「판단 갈림」 항목: 단계를 고른 사람이 5명 이상이고, 최다 단계 비율이 0.45 미만이며,
 * 쓰인 단계가 3개 이상인 항목 가운데 가장 갈린 3개까지.
 * 정렬: 최다 비율 오름차순, 같으면 쓰인 단계 수 내림차순(그래도 같으면 항목 순서).
 * @param {{ id: string, stage: number[] }[]} counts  heatmap(...).items 처럼 항목별 단계 인원
 * @returns {{ id, tot, share, used }[]}
 */
export function splitItems(counts, rule = SPLIT_RULE) {
  return (counts || []).map((c) => {
    const st = Array.isArray(c.stage) ? c.stage : [];
    const tot = st.reduce((s, x) => s + x, 0);
    const max = st.reduce((s, x) => Math.max(s, x), 0);
    const used = st.filter((x) => x > 0).length;
    return { id: c.id, tot, share: tot ? max / tot : 1, used };
  })
    .filter((s) => s.tot >= rule.minPeople && s.share < rule.maxShare && s.used >= rule.minStages)
    .sort((p, q) => (p.share - q.share) || (q.used - p.used))
    .slice(0, rule.limit);
}

/** 보기 하나(전체 또는 학습목표 하나)의 응답만으로 판단 갈림을 계산한다 */
export function splitInView(activity, rows, view) {
  return splitItems(heatmap(activity, rowsInView(rows, view)).items);
}

/* ───────────── 현황판 화면 ───────────── */

function hexA(hex, a) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * 항목 × 단계 히트맵, 위험 분포, 판단 갈림, 메모(이름과 함께).
 * ↑ ↓(또는 위쪽 버튼)로 보기를 바꾼다: 전체 → 학습목표별 → 직접 적은 목표
 */
function board(ctx) {
  const a = ctx.activity;
  const items = a.items || [];
  const stages = stagesOf(a);
  const views = boardViews(a);
  const keep = ctx.keep || {};
  let vi = Math.max(0, views.findIndex((v) => v.key === keep.view));
  let cur = ctx;
  const root = ctx.root;

  root.innerHTML =
    '<div class="sc">' +
    '<div class="sc-views" role="tablist" aria-label="학습목표 보기"></div>' +
    '<div class="sc-obj"></div>' +
    '<div class="sc-body"><div class="sc-main"></div><aside class="sc-side"></aside></div>' +
    '</div>';
  const el = {
    sc: root.querySelector('.sc'),
    views: root.querySelector('.sc-views'),
    obj: root.querySelector('.sc-obj'),
    main: root.querySelector('.sc-main'),
    side: root.querySelector('.sc-side')
  };
  el.views.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    const i = views.findIndex((v) => v.key === b.dataset.view);
    if (i >= 0) select(i);
  });

  function select(i) {
    vi = (i + views.length) % views.length;
    keep.view = views[vi].key;
    draw();
  }

  const nameOf = (pid) => (cur.names && cur.names.get(pid)) || '…';

  function objHTML(v) {
    if (v.kind === 'all') {
      return '<span class="og">전체</span><span class="ot">학습목표 구분 없이 모든 응답을 합쳤습니다.</span>';
    }
    if (v.kind === 'custom') {
      return '<span class="og">직접 적은 목표</span><span class="ot">보기에 없는 목표를 직접 적은 응답만 모았습니다.</span>';
    }
    const o = v.objective;
    return `<span class="og">${rich(v.label)}</span><span class="ot">${rich(o.text)}</span>` +
      (o.code ? `<span class="oc">${esc(o.code)}</span>` : '');
  }

  function blankHTML(title, desc) {
    return `<div class="blank"><h2>${esc(title)}</h2><p>${desc}</p></div>`;
  }

  function tableHTML(heat, split) {
    const head =
      '<div class="hm-h it">항목</div>' +
      stages.map((s) =>
        `<div class="hm-h st"><span class="sn" style="background:${s.color}">${s.n}</span>` +
        `<span class="sl">${esc(s.name)}</span></div>`).join('') +
      '<div class="hm-h rk">외주화 위험</div>';
    const body = items.map((it, k) => {
      const h = heat.items[k];
      const max = Math.max(0, ...h.stage);
      const isSplit = split.has(it.id);
      const cells = stages.map((s, j) => {
        const c = h.stage[j];
        if (!c) return `<div class="cell zero" data-cell="${esc(it.id)}:${s.n}">·</div>`;
        const alpha = 0.18 + 0.82 * (max ? c / max : 0);
        return `<div class="cell" data-cell="${esc(it.id)}:${s.n}" style="background:${hexA(s.color, alpha)};` +
          `color:${alpha > 0.55 ? '#fff' : 'var(--ink)'}">${c}</div>`;
      }).join('');
      const rt = h.riskTot;
      const seg = (k2, cls) => {
        const n = h.risk[k2];
        if (!n) return '';
        const w = (n / rt) * 100;
        return `<i class="${cls}" style="width:${w.toFixed(2)}%">${w >= 16 ? n : ''}</i>`;
      };
      const risk = `<div class="risk" data-risk="${esc(it.id)}">` +
        (rt ? seg('상', 'h') + seg('중', 'm') + seg('하', 'l') : '<span class="none">·</span>') + '</div>';
      // 판단 갈림 표시는 둘째 줄 앞에 둔다(항목 이름이 두 줄로 밀리지 않게)
      return `<div class="hm-it${isSplit ? ' split' : ''}" data-item="${esc(it.id)}">` +
        `<div class="nm"><span class="no">${k + 1}</span><span class="tx">${rich(it.name)}</span></div>` +
        (isSplit || it.desc
          ? `<div class="ds">${isSplit ? '<span class="flag">판단 갈림</span> ' : ''}${it.desc ? `<span class="dtx">${rich(it.desc)}</span>` : ''}</div>`
          : '') +
        '</div>' + cells + risk;
    }).join('');
    return `<div class="hm" style="--rows:${items.length}">${head}${body}</div>` +
      '<div class="hm-legend">' +
      '<span>숫자 = 그 단계를 고른 사람 수 · 진할수록 몰림</span>' +
      '<span class="sw"><b style="background:var(--red)"></b>위험 상</span>' +
      '<span class="sw"><b style="background:var(--amber)"></b>중</span>' +
      '<span class="sw"><b style="background:var(--green)"></b>하</span>' +
      '<span class="sw"><b class="fl"></b>판단 갈림 = 5명 이상 고른 항목 가운데 가장 갈린 곳</span>' +
      '</div>';
  }

  function memosHTML(heat) {
    const nameOfItem = new Map(items.map((it) => [it.id, it.name]));
    const list = heat.memos;
    return `<div class="side-h">배움을 지키는 장치 <span>${list.length}개</span></div>` +
      (list.length
        ? '<div class="side-list">' + list.map((m) =>
          '<div class="memo">' +
          `<div class="mt">${esc(m.memo)}</div>` +
          `<div class="mw"><span class="mi">${rich(nameOfItem.get(m.item) || '')}</span>` +
          `<span class="mn">${esc(nameOf(m.pid))}</span></div>` +
          '</div>').join('') + '</div>'
        : '<div class="side-empty">아직 적은 장치가 없습니다.</div>');
  }

  function customHTML(vrows) {
    return `<div class="side-h">직접 적은 목표 <span>${vrows.length}명</span></div>` +
      '<div class="side-list cobjs">' + vrows.map((r) =>
        '<div class="cobj">' +
        `<div class="ct">${esc((r.payload && r.payload.objective && r.payload.objective.text) || '')}</div>` +
        `<div class="cn">${esc(nameOf(r.participant_id))}</div>` +
        '</div>').join('') + '</div>';
  }

  function draw() {
    const rows = cur.rows;
    const v = views[vi];
    el.sc.dataset.view = v.key;
    el.views.innerHTML = views.map((x, i) => {
      const n = rows ? rowsInView(rows, x).length : 0;
      return `<button type="button" class="vt${i === vi ? ' on' : ''}${n ? '' : ' empty'}" role="tab" ` +
        `aria-selected="${i === vi}" data-view="${esc(x.key)}">` +
        `<span class="vl">${x.kind === 'objective' ? rich(x.label) : esc(x.label)}</span><span class="vn">${n}</span></button>`;
    }).join('');
    if (!rows) {
      el.obj.innerHTML = '';
      el.main.innerHTML = blankHTML('불러오는 중…', '');
      el.side.innerHTML = '';
      el.side.hidden = true;
      return;
    }
    const vrows = rowsInView(rows, v);
    el.obj.innerHTML = objHTML(v);
    el.obj.className = `sc-obj ${v.kind}`;

    if (!rows.length) {
      el.main.innerHTML = blankHTML('아직 제출이 없습니다',
        cur.isOpen ? '제출이 들어오면 항목별 허용 단계 분포가 여기에 채워집니다.'
          : '관리자 화면에서 이 활동을 열어 주세요.');
      el.side.hidden = true;
      return;
    }
    if (!vrows.length) {
      el.main.innerHTML = blankHTML('이 보기에는 아직 응답이 없습니다',
        v.kind === 'custom' ? '학습목표를 직접 적은 사람이 아직 없습니다.' : '이 학습목표를 고른 사람이 아직 없습니다.');
      el.side.hidden = true;
      return;
    }
    const heat = heatmap(a, vrows);
    const split = new Set(splitItems(heat.items).map((s) => s.id));
    el.main.innerHTML = tableHTML(heat, split);
    fitDescs();
    requestAnimationFrame(fitDescs);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitDescs);
    el.side.hidden = false;
    el.side.innerHTML = (v.kind === 'custom' ? customHTML(vrows) : '') + memosHTML(heat);
  }

  // 항목 설명이 한 줄에 다 들어가지 않으면 말줄임표로 자르지 않고 숨긴다(프로젝터에서 잘린 글이 보이지 않게)
  function fitDescs() {
    for (const ds of el.main.querySelectorAll('.hm-it .ds')) {
      const dt = ds.querySelector('.dtx');
      if (!dt) continue;
      dt.hidden = false;
      ds.hidden = false;
      if (ds.scrollWidth > ds.clientWidth + 1) {
        dt.hidden = true;
        if (!ds.querySelector('.flag')) ds.hidden = true;
      }
    }
  }
  const onResize = () => fitDescs();
  window.addEventListener('resize', onResize);

  draw();

  return {
    update(next) {
      cur = next;
      draw();
    },
    onKey(key) {
      if (key === 'ArrowDown') { select(vi + 1); return true; }
      if (key === 'ArrowUp') { select(vi - 1); return true; }
      return false;
    },
    destroy() { window.removeEventListener('resize', onResize); }
  };
}

export default {
  type: 'stage_check',
  typeLabel: '단계 판단',
  boardKeys: '↑ ↓ 보기',
  summary,
  participant,
  adminCard,
  adminResponse,
  adminCell: () => '✓',
  board
};
