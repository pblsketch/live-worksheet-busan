/**
 * 활동 부품: rewrite (수행 특성 문장 고쳐 쓰기. 1차·2차를 활동 두 개로 두고 참가자별로 짝짓는다)
 *
 * 공개 설정: round(1|2, 기본 1), pairOf?(2차의 짝 1차 활동 id), level?('잘함'), prompts[{id,text}],
 *           checks?[점검 질문], maxLength?(기본 200, 최대 300)
 * payload: { prompt: '<prompts 의 id>', text: '5자~maxLength' } — 앞뒤 공백을 떼고 연속 공백·줄 바꿈은 공백 하나(서버와 같다)
 * 참가자: 문장을 하나 골라 고쳐 쓴다. 2차는 1차에서 고른 문장과 내 1차 문장을 위에 두고, 글상자를 1차 문장으로 채워 둔다.
 * 현황판: 모아 보기(카드 벽 · 고른 문장별 나눠 보기 · 쪽 넘김) · 골라 띄우기(한 장을 크게) · 나란히 보기(1차 | 2차)
 *         이름은 기본으로 숨긴다(N). 현황판 안의 기능이라 DB에 상태를 쓰지 않는다.
 * 설정 문구는 <b>만 살려 그린다(rich). 참가자가 적은 글은 모두 이스케이프한다(esc).
 */
import { esc, rich, len, oneLine } from '../core.js';
import {
  freshKeys, FRESH_MS, paginate, clampPage, measureHeights, columnBox, pagerHTML, byFirst
} from '../paging.js';

export { byFirst };

export const MIN = 5;
export const MAX_DEFAULT = 200;
export const MAX_LIMIT = 300;

/** 글자 수 한도(설정의 maxLength, 없거나 틀리면 200) */
export function maxOf(activity) {
  const m = activity && activity.maxLength;
  return Number.isInteger(m) && m >= MIN && m <= MAX_LIMIT ? m : MAX_DEFAULT;
}

export function promptOf(activity, id) {
  return ((activity && activity.prompts) || []).find((p) => p.id === id) || null;
}

/** 고른 문장 표시(id 를 대문자로: a → A) */
export function promptLabel(id) {
  return String(id == null ? '' : id).toUpperCase();
}

/**
 * 제출 전 정리와 검사(서버 lwb_validate_rewrite 와 같은 규칙·문구)
 * @returns {{ ok: true, payload: { prompt, text } } | { ok: false, msg: string }}
 */
export function tidy(activity, payload) {
  const p = payload || {};
  if (typeof p.prompt !== 'string' || !promptOf(activity, p.prompt)) return { ok: false, msg: '고쳐 쓸 문장을 골라 주세요.' };
  if (typeof p.text !== 'string') return { ok: false, msg: '고쳐 쓴 문장을 적어 주세요.' };
  const text = oneLine(p.text);
  const max = maxOf(activity);
  if (len(text) < MIN) return { ok: false, msg: `${MIN}자 이상 적어 주세요.` };
  if (len(text) > max) return { ok: false, msg: `${max}자 이내로 적어 주세요.` };
  return { ok: true, payload: { prompt: p.prompt, text } };
}

/**
 * 짝이 되는 1차 활동. pairOf 가 있으면 그것, 없고 2차면 앞쪽에서 가장 가까운 1차 rewrite.
 * 짝이 없으면 null (나란히 보기를 하지 않는다)
 */
export function pairOf(event, activity) {
  const acts = (event && Array.isArray(event.activities)) ? event.activities : [];
  const isFirst = (x) => x && x.type === 'rewrite' && x.id !== activity.id && (x.round || 1) !== 2;
  if (activity.pairOf) return acts.find((x) => x.id === activity.pairOf && isFirst(x)) || null;
  if (activity.round !== 2) return null;
  const i = acts.findIndex((x) => x.id === activity.id);
  for (let k = i - 1; k >= 0; k--) if (isFirst(acts[k])) return acts[k];
  return null;
}

/**
 * 1차·2차 짝: 두 번 다 낸 사람만, 2차를 처음 낸 순서대로.
 * @returns {{ pid, first, second, key }[]} first·second 는 payload. key 는 둘 중 하나를 다시 내면 바뀐다
 */
export function pairRows(firstRows, secondRows) {
  const first = new Map((firstRows || []).map((r) => [r.participant_id, r]));
  return byFirst(secondRows).filter((r) => first.has(r.participant_id)).map((r) => {
    const f = first.get(r.participant_id);
    return {
      pid: r.participant_id,
      first: f.payload || {},
      second: r.payload || {},
      key: `${r.participant_id}|${f.updated_at || f.created_at || ''}|${r.updated_at || r.created_at || ''}`
    };
  });
}

/**
 * 어절(띄어쓰기 단위) 비교. 2차의 어절마다 1차에 없던 것이면 added.
 * 가장 긴 공통 부분 열(LCS)로 맞추므로 같은 어절이 자리를 옮겨도 순서가 맞는 것만 그대로로 본다.
 * @returns {{ w: string, added: boolean }[]} 2차 어절 순서대로
 */
export function wordDiff(before, after) {
  const a = oneLine(before).split(' ').filter(Boolean);
  const b = oneLine(after).split(' ').filter(Boolean);
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && a[i] === b[j]) { out.push({ w: b[j], added: false }); i++; j++; } else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
    else { out.push({ w: b[j], added: true }); j++; }
  }
  return out;
}

/** 2차 문장 HTML: 새로 생긴 어절을 <mark>로 감싼다(붙어 있는 새 어절은 한 덩어리로) */
export function diffHTML(before, after) {
  const parts = [];
  let run = [];
  const flush = () => { if (run.length) { parts.push(`<mark>${esc(run.join(' '))}</mark>`); run = []; } };
  for (const t of wordDiff(before, after)) {
    if (t.added) run.push(t.w);
    else { flush(); parts.push(esc(t.w)); }
  }
  flush();
  return parts.join(' ');
}

const clip = (s, n) => {
  const cs = [...oneLine(s)];
  return cs.length > n ? `${cs.slice(0, n).join('')}…` : cs.join('');
};

const tagHTML = (id) => (id ? `<span class="tag">${esc(promptLabel(id))}</span>` : '');

function levelText(a) {
  return a.level ? `‘${esc(a.level)}’ 수준` : '';
}

/* ───────────── 참가자 화면 ───────────── */

function participant(ctx) {
  const a = ctx.activity;
  const prompts = a.prompts || [];
  const checks = Array.isArray(a.checks) ? a.checks : [];
  const max = maxOf(a);
  const root = ctx.root;
  const draft = ctx.draft;
  let cur = ctx;

  // 2차: 1차에서 낸 것(짝 활동에 낸 payload). 고른 문장이 이 활동에 없으면 없는 것으로 본다
  const partner = pairOf(ctx.event, a);
  const firstOf = () => {
    const f = partner && cur.mineOf ? cur.mineOf(partner.id) : null;
    return f && promptOf(a, f.prompt) && typeof f.text === 'string' ? f : null;
  };

  const saved = draft.load();
  const base = saved || ctx.mine || {};
  const first0 = firstOf();
  const form = {
    prompt: promptOf(a, base.prompt) ? base.prompt
      : (first0 ? first0.prompt : (prompts.length === 1 ? prompts[0].id : null)),
    text: typeof base.text === 'string' ? base.text : (first0 ? first0.text : '')
  };
  let mode = ctx.mine && (!saved || !ctx.isOpen) ? 'result' : 'form';

  const save = () => draft.save(form);
  const lockedPrompt = () => {
    const f = firstOf();
    return f ? f.prompt : null; // 2차는 1차에서 고른 문장을 그대로 고쳐 쓴다
  };

  function checksHTML() {
    if (!checks.length) return '';
    return '<aside class="rw-checks"><div class="rw-checks-h">점검 질문</div>' +
      `<ol>${checks.map((c) => `<li>${rich(c)}</li>`).join('')}</ol></aside>`;
  }

  function leftHTML() {
    const n = max - len(oneLine(form.text));
    return `<span class="${n < 0 ? 'over' : ''}">남은 글자 <b>${n}</b>자</span> · ${MIN}자 이상`;
  }

  function drawForm() {
    const f = firstOf();
    const lock = lockedPrompt();
    if (lock) form.prompt = lock;
    const p = promptOf(a, form.prompt);
    let head = a.description ? `<div class="hint lead">${rich(a.description)}</div>` : '';

    if (f) {
      head += '<div class="rw-ref">' +
        '<div class="rw-ref-h">1차에서 고른 문장</div>' +
        `<div class="rw-q">${tagHTML(f.prompt)}<span class="rw-qt">${rich(p ? p.text : '')}</span></div>` +
        '<div class="rw-ref-h">내 1차 문장</div>' +
        `<div class="rw-first">${esc(f.text)}</div></div>`;
    } else if (!p) {
      head += (partner ? '<div class="hint rw-note">1차에 낸 문장이 없습니다. 문장을 골라 바로 써 주세요.</div>' : '') +
        `<div class="step"><span>1</span>${prompts.length === 2 ? '두 문장 가운데 하나를 고르세요' : `${prompts.length}개 가운데 하나를 고르세요`}</div>` +
        '<div class="rw-picks" id="rwPicks">' +
        prompts.map((x) =>
          `<label class="rw-pick"><input type="radio" name="rwp" value="${esc(x.id)}">` +
          `${tagHTML(x.id)}<span class="rw-qt">${rich(x.text)}</span></label>`).join('') +
        '</div>';
      root.innerHTML = head + checksHTML();
      root.querySelector('#rwPicks').addEventListener('change', (e) => {
        if (e.target.name !== 'rwp') return;
        form.prompt = e.target.value;
        save();
        drawForm();
        const ta = root.querySelector('#rwText');
        if (ta) ta.focus();
      });
      return;
    } else {
      head += `<div class="rw-q on">${tagHTML(p.id)}<span class="rw-qt">${rich(p.text)}</span>` +
        (prompts.length > 1 ? '<button type="button" class="link-btn rw-repick" data-act="repick">다른 문장 고르기</button>' : '') +
        '</div>';
    }

    const lv = levelText(a);
    root.innerHTML = head +
      '<div class="rw-work rw-wide">' +
      '<div class="rw-write">' +
      `<div class="step">${f ? '' : `<span>${prompts.length > 1 ? 2 : 1}</span>`}${lv ? `${lv}으로 ` : ''}${f ? '다시 ' : ''}고쳐 쓰기</div>` +
      `<textarea id="rwText" rows="5" maxlength="${max}" placeholder="${f ? '1차 문장을 고쳐 써 주세요' : '고쳐 쓴 문장을 적어 주세요'}">${esc(form.text)}</textarea>` +
      `<div class="rw-count" id="rwLeft">${leftHTML()}</div>` +
      '</div>' +
      checksHTML() +
      '</div>' +
      `<div class="sticky-b"><button class="btn" data-act="submit">${cur.mine ? '고쳐서 다시 내기' : '제출하기'}</button></div>`;

    const ta = root.querySelector('#rwText');
    ta.addEventListener('input', () => {
      form.text = ta.value;
      save();
      root.querySelector('#rwLeft').innerHTML = leftHTML();
    });
    const re = root.querySelector('[data-act="repick"]');
    if (re) re.onclick = () => { form.prompt = null; save(); drawForm(); };
    root.querySelector('[data-act="submit"]').onclick = submit;
  }

  async function submit(e) {
    const btn = e.currentTarget;
    const t = tidy(a, { prompt: form.prompt, text: form.text });
    if (!t.ok) { cur.toast(t.msg); return; }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '제출하는 중…';
    const ok = await cur.submit(t.payload);
    if (!ok) { btn.disabled = false; btn.textContent = label; return; }
    draft.clear();
    cur.toast('제출했습니다.');
    mode = 'result';
    window.scrollTo(0, 0);
    drawResult();
  }

  function drawResult() {
    const mine = cur.mine || {};
    const p = promptOf(a, mine.prompt);
    const f = firstOf();
    const cmp = f && f.prompt === mine.prompt;
    root.innerHTML =
      '<div class="card blue center">' +
      '<div class="done-mark">✓</div>' +
      '<div class="serif big-t">제출했습니다</div>' +
      `<div class="hint">${cur.isOpen ? '열려 있는 동안은 다시 내서 고칠 수 있습니다.' : '진행자가 활동을 닫아 더 고칠 수 없습니다.'}</div>` +
      '</div>' +
      '<div class="card flat rw-done">' +
      (p ? `<div class="rw-q">${tagHTML(p.id)}<span class="rw-qt">${rich(p.text)}</span></div>` : '') +
      (cmp
        ? '<div class="rw-cmp">' +
          `<div class="c1"><span class="lb">1차</span>${esc(f.text)}</div>` +
          `<div class="c2"><span class="lb">2차</span>${diffHTML(f.text, mine.text)}</div></div>` +
          '<div class="hint">2차에서 새로 넣은 말은 형광펜으로 표시했습니다.</div>'
        : `<div class="rw-mine">${esc(mine.text || '')}</div>`) +
      '</div>' +
      (cur.isOpen ? '<button class="btn line" data-act="edit">고쳐서 다시 내기</button>' : '') +
      '<div class="sticky-b"><button class="btn" data-act="menu">메뉴로</button></div>';

    const edit = root.querySelector('[data-act="edit"]');
    if (edit) {
      edit.onclick = () => {
        const d = draft.load() || cur.mine || {};
        if (promptOf(a, d.prompt)) form.prompt = d.prompt;
        form.text = typeof d.text === 'string' ? d.text : '';
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
  const n = (activity.prompts || []).length;
  return `${activity.round === 2 ? '2차' : '1차'} · ${n > 1 ? `문장 ${n}개 가운데 하나` : '문장 하나'}`;
}

function adminCard(ctx) {
  const a = ctx.activity;
  const rows = ctx.rows || [];
  if (!rows.length) return '';
  const prompts = a.prompts || [];
  const parts = [];
  if (prompts.length > 1) {
    parts.push(prompts.map((p) => {
      const n = rows.filter((r) => r.payload && r.payload.prompt === p.id).length;
      return `${esc(promptLabel(p.id))} <b>${n}</b>(${Math.round((n / rows.length) * 100)}%)`;
    }).join(' · '));
  }
  const partner = pairOf(ctx.event, a);
  if (partner && ctx.rowsOf) parts.push(`1·2차 모두 <b>${pairRows(ctx.rowsOf(partner.id), rows).length}</b>명`);
  // rows 는 최근 제출 순
  const recent = rows.slice(0, 2).map((r) =>
    `<div class="rw-recent">${tagHTML(r.payload && r.payload.prompt)} ${esc(clip(r.payload && r.payload.text, 40))}</div>`).join('');
  return `${parts.join(' · ')}${recent}`;
}

function adminResponse(ctx, row) {
  const a = ctx.activity;
  const p = row.payload || {};
  const partner = pairOf(ctx.event, a);
  let first = null;
  if (partner && ctx.rowsOf) {
    const f = (ctx.rowsOf(partner.id) || []).find((r) => r.participant_id === row.participant_id);
    if (f && f.payload && f.payload.prompt === p.prompt) first = f.payload.text;
  }
  return `<div class="ptx">${(a.prompts || []).length > 1 ? `${tagHTML(p.prompt)} ` : ''}` +
    `${first != null ? diffHTML(first, p.text) : esc(p.text || '')}</div>`;
}

function adminCell(ctx, row) {
  const p = row.payload && row.payload.prompt;
  return (ctx.activity.prompts || []).length > 1 && p ? esc(promptLabel(p)) : '✓';
}

/* ───────────── 현황판 ───────────── */

/**
 * 모아 보기(카드 벽) · 골라 띄우기 · 나란히 보기(짝이 있을 때).
 * 키: ↓ ↑ · PageDown PageUp 쪽 넘기기 / Enter 카드 고르기 → 방향키로 옮기고 Enter 로 띄우기 / Esc 돌아가기
 *     N 이름 보이기·숨기기 / 0·1·2 전체·문장별 / V 모아 보기 ↔ 나란히 보기
 * 띄운 동안에는 ← → (↑ ↓ · PageUp PageDown)가 앞뒤 카드로 넘긴다.
 */
function board(ctx) {
  const a = ctx.activity;
  const prompts = a.prompts || [];
  const checks = Array.isArray(a.checks) ? a.checks : [];
  const root = ctx.root;
  const keep = ctx.keep || {};
  if (!keep.seen) keep.seen = new Map();
  let cur = ctx;
  let timer = null;
  let drawing = false;
  let list = [];     // 지금 보기의 카드(순서대로)
  let pages = [];

  const partner = () => pairOf(cur.event, a);
  if (!keep.mode) keep.mode = partner() && a.round === 2 ? 'pairs' : 'wall';
  if (!keep.filter) keep.filter = 'all';
  if (typeof keep.page !== 'number') keep.page = 0;

  root.innerHTML = '<div class="rw">' +
    '<div class="rw-top"></div><div class="rw-prompt"></div><div class="rw-body"></div>' +
    '<div class="rw-spot" hidden></div></div>';
  const el = {
    rw: root.querySelector('.rw'),
    top: root.querySelector('.rw-top'),
    prompt: root.querySelector('.rw-prompt'),
    body: root.querySelector('.rw-body'),
    spot: root.querySelector('.rw-spot')
  };

  const nameOf = (pid) => (cur.names && cur.names.get(pid)) || '…';

  /** 지금 방식(모아 보기·나란히 보기)의 카드 전체 */
  function cardsAll() {
    if (keep.mode === 'pairs') {
      const p = partner();
      if (!p) return [];
      return pairRows(cur.rowsOf ? cur.rowsOf(p.id) : [], cur.rows).map((x) => ({
        key: x.key, pid: x.pid, prompt: x.second.prompt, first: String(x.first.text || ''), text: String(x.second.text || '')
      }));
    }
    return byFirst(cur.rows).map((r) => {
      const p = r.payload || {};
      return { key: `${r.participant_id}|${r.updated_at || r.created_at || ''}`, pid: r.participant_id, prompt: p.prompt, text: String(p.text || '') };
    });
  }
  const inFilter = (xs) => (keep.filter === 'all' ? xs : xs.filter((x) => x.prompt === keep.filter));

  function cardHTML(x, fresh) {
    const nm = keep.names ? `<span class="nm">${esc(nameOf(x.pid))}</span>` : '';
    const cls = `${fresh ? ' fresh' : ''}${keep.cursor === x.pid ? ' cursor' : ''}`;
    if (keep.mode === 'pairs') {
      return `<button type="button" class="rwpair${cls}" data-pid="${esc(x.pid)}">` +
        `<span class="rh">${tagHTML(x.prompt)}${nm}</span>` +
        `<span class="pp"><span class="p1"><span class="lb">1차</span><span class="tx">${esc(x.first)}</span></span>` +
        `<span class="p2"><span class="lb">2차</span><span class="tx">${diffHTML(x.first, x.text)}</span></span></span></button>`;
    }
    return `<button type="button" class="rwcard${cls}" data-pid="${esc(x.pid)}">` +
      `<span class="rh">${tagHTML(x.prompt)}${nm}</span><span class="tx">${esc(x.text)}</span></button>`;
  }

  function topHTML(all) {
    const p = partner();
    const pairsN = p ? pairRows(cur.rowsOf ? cur.rowsOf(p.id) : [], cur.rows).length : 0;
    const modes = p
      ? '<span class="rw-tabs" role="tablist" aria-label="보기 방식">' +
        [['wall', '모아 보기', (cur.rows || []).length], ['pairs', '나란히 보기', pairsN]].map(([k, t, n]) =>
          `<button type="button" class="vt${keep.mode === k ? ' on' : ''}" role="tab" aria-selected="${keep.mode === k}" data-mode="${k}">` +
          `<span class="vl">${t}</span><span class="vn">${n}</span></button>`).join('') + '</span>'
      : '';
    const filters = prompts.length > 1
      ? '<span class="rw-tabs" role="tablist" aria-label="고른 문장">' +
        [{ id: 'all', t: '전체' }, ...prompts.map((x) => ({ id: x.id, t: `문장 ${promptLabel(x.id)}` }))].map((f) => {
          const n = f.id === 'all' ? all.length : all.filter((x) => x.prompt === f.id).length;
          return `<button type="button" class="vt${keep.filter === f.id ? ' on' : ''}${n ? '' : ' empty'}" role="tab" ` +
            `aria-selected="${keep.filter === f.id}" data-filter="${esc(f.id)}"><span class="vl">${esc(f.t)}</span><span class="vn">${n}</span></button>`;
        }).join('') + '</span>'
      : '';
    return modes + filters + '<span class="sp"></span>' +
      `<button type="button" class="rw-names${keep.names ? ' on' : ''}" data-act="names">${keep.names ? '이름 보임' : '이름 숨김'} <small>N</small></button>` +
      '<span class="rw-pg"></span>';
  }

  function promptLineHTML() {
    const shown = keep.filter === 'all' ? prompts : prompts.filter((x) => x.id === keep.filter);
    return shown.map((x) => `<span class="rq">${tagHTML(x.id)}<span class="rqt">${rich(x.text)}</span></span>`).join('');
  }

  function blank(title, desc) {
    el.body.innerHTML = `<div class="blank"><h2>${esc(title)}</h2><p>${desc}</p></div>`;
    el.top.querySelector('.rw-pg').innerHTML = '';
  }

  function draw() {
    drawing = true;
    try { render(); } finally { drawing = false; }
  }

  function render() {
    clearTimeout(timer);
    if (keep.mode === 'pairs' && !partner()) keep.mode = 'wall';
    const rows = cur.rows;
    if (!rows) {
      el.top.innerHTML = '';
      el.prompt.innerHTML = '';
      el.body.innerHTML = '<div class="blank"><h2>불러오는 중…</h2></div>';
      return;
    }
    const all = cardsAll();
    const fresh = freshKeys(keep.seen, all.map((x) => x.key), Date.now(), { first: !keep.ready });
    keep.ready = true;
    list = inFilter(all);
    el.rw.dataset.mode = keep.mode;
    el.rw.dataset.names = keep.names ? 'on' : 'off';
    el.top.innerHTML = topHTML(all);
    el.prompt.innerHTML = promptLineHTML();

    if (!list.length) {
      pages = [];
      if (keep.mode === 'pairs') {
        blank('아직 나란히 볼 문장이 없습니다', '1차와 2차를 모두 낸 사람의 문장이 여기에 짝지어 나옵니다.');
      } else if (!rows.length) {
        blank('아직 문장이 없습니다', cur.isOpen ? '문장이 들어오면 여기에 한 장씩 쌓입니다.' : '관리자 화면에서 이 활동을 열어 주세요.');
      } else {
        blank('이 문장을 고른 사람이 아직 없습니다', '0 을 누르면 전체를 봅니다.');
      }
      drawSpot();
      return;
    }

    // 쪽 나누기: 실제 칸 크기로 카드 높이를 재서 한 쪽에 들어가는 만큼 둔다
    const cols = keep.mode === 'pairs' ? 1 : 3;
    el.body.innerHTML = `<div class="rw-cols" style="--cols:${cols}">` +
      Array.from({ length: cols }, () => '<div class="rw-col"></div>').join('') + '</div>';
    const colEls = [...el.body.querySelectorAll('.rw-col')];
    const box = columnBox(colEls[0]);
    const htmls = list.map((x) => cardHTML(x, fresh.has(x.key)));
    const heights = measureHeights(el.body, htmls, box.width, 'rw-col rw-measure');
    pages = paginate(heights, { cols, height: box.height, gap: box.gap });
    keep.page = clampPage(keep.page, pages.length);
    pages[keep.page].forEach((idxs, c) => { colEls[c].innerHTML = idxs.map((i) => htmls[i]).join(''); });

    const later = list.filter((x, i) => fresh.has(x.key) && !pages[keep.page].some((col) => col.includes(i))).length;
    el.top.querySelector('.rw-pg').innerHTML = pagerHTML(keep.page, pages.length, list.length, keep.mode === 'pairs' ? '쌍' : '장') +
      (later ? `<span class="pg-new">다른 쪽에 새 카드 ${later}</span>` : '');

    // 고른 카드(커서)가 이 쪽에 있으면 다시 초점을 둔다
    if (keep.cursor && !keep.spot) {
      const c = cardEl(keep.cursor);
      if (c) c.focus({ preventScroll: true });
      else keep.cursor = null;
    }
    drawSpot();
    if (fresh.size) timer = setTimeout(draw, FRESH_MS + 200); // 강조가 저절로 걷히게 한 번 더 그린다
  }

  const cardEl = (pid) => [...el.body.querySelectorAll('[data-pid]')].find((b) => b.dataset.pid === pid) || null;
  const indexOf = (pid) => list.findIndex((x) => x.pid === pid);
  const pageHas = (i) => pages[keep.page] && pages[keep.page].some((col) => col.includes(i));
  const firstOnPage = () => {
    const p = pages[keep.page];
    if (!p) return -1;
    const all = p.flat();
    return all.length ? Math.min(...all) : -1;
  };

  /* ─── 골라 띄우기 ─── */

  function drawSpot() {
    const x = keep.spot ? list.find((y) => y.pid === keep.spot) : null;
    if (keep.spot && !x) keep.spot = null; // 지운 응답이거나 다른 문장 보기
    el.spot.hidden = !x;
    el.rw.classList.toggle('spotting', !!x);
    if (!x) { el.spot.innerHTML = ''; return; }
    const p = promptOf(a, x.prompt);
    const i = indexOf(x.pid);
    el.spot.innerHTML =
      `<div class="sp-q">${tagHTML(x.prompt)}<span class="sp-ql">원래 문장</span><span class="sp-qt">${p ? rich(p.text) : ''}</span></div>` +
      '<div class="sp-body"><div class="sp-main">' +
      (keep.mode === 'pairs'
        ? `<div class="sp-pair${Math.max(len(x.first), len(x.text)) > 110 ? ' s' : ''}">` +
          `<div class="sp-1"><span class="lb">1차</span><span class="tx">${esc(x.first)}</span></div>` +
          `<div class="sp-2"><span class="lb">2차</span><span class="tx">${diffHTML(x.first, x.text)}</span></div></div>`
        : `<div class="sp-text ${len(x.text) > 140 ? 's' : (len(x.text) > 70 ? 'm' : '')}">${esc(x.text)}</div>`) +
      (keep.names ? `<div class="sp-nm">${esc(nameOf(x.pid))}</div>` : '') +
      '</div>' +
      (checks.length
        ? `<aside class="sp-checks"><div class="side-h">점검 질문</div><ol>${checks.map((c) => `<li>${rich(c)}</li>`).join('')}</ol></aside>`
        : '') +
      '</div>' +
      `<div class="sp-foot"><span class="sp-n">${i + 1} / ${list.length}</span>` +
      '<span class="sp-keys">← → 앞뒤 카드 · N 이름 · Esc 돌아가기</span>' +
      '<button type="button" class="sp-close" data-act="close">돌아가기</button></div>';
  }

  function openSpot(pid) {
    keep.spot = pid;
    keep.cursor = pid;
    drawSpot();
  }

  function closeSpot() {
    const pid = keep.spot;
    keep.spot = null;
    drawSpot();
    const i = indexOf(pid);
    if (i >= 0 && !pageHas(i)) { keep.page = Math.max(0, pages.findIndex((pg) => pg.some((col) => col.includes(i)))); draw(); }
    const c = cardEl(pid);
    if (c) c.focus({ preventScroll: true });
  }

  function stepSpot(d) {
    const i = indexOf(keep.spot);
    if (i < 0 || !list.length) return;
    const j = Math.min(Math.max(0, i + d), list.length - 1);
    keep.spot = list[j].pid;
    keep.cursor = keep.spot;
    drawSpot();
  }

  /* ─── 모아 보기 조작 ─── */

  function turn(d) {
    if (!pages.length) return;
    const next = clampPage(keep.page + d, pages.length);
    if (next === keep.page) return;
    keep.page = next;
    if (keep.cursor) {
      const i = firstOnPage();
      keep.cursor = i >= 0 ? list[i].pid : null;
    }
    draw();
  }

  function moveCursor(d) {
    const i = indexOf(keep.cursor);
    const j = Math.min(Math.max(0, (i < 0 ? firstOnPage() : i + d)), list.length - 1);
    if (j < 0) return;
    keep.cursor = list[j].pid;
    if (!pageHas(j)) {
      keep.page = pages.findIndex((pg) => pg.some((col) => col.includes(j)));
      draw();
      return;
    }
    const c = cardEl(keep.cursor);
    if (c) c.focus({ preventScroll: true });
  }

  function setMode(m) {
    if (m === keep.mode || (m === 'pairs' && !partner())) return;
    keep.mode = m;
    keep.page = 0;
    keep.cursor = null;
    keep.spot = null;
    draw();
  }

  function setFilter(f) {
    if (f === keep.filter) return;
    keep.filter = f;
    keep.page = 0;
    keep.cursor = null;
    keep.spot = null;
    draw();
  }

  function toggleNames() {
    keep.names = !keep.names;
    draw();
  }

  function onClick(e) {
    const m = e.target.closest('[data-mode]');
    if (m) { setMode(m.dataset.mode); return; }
    const f = e.target.closest('[data-filter]');
    if (f) { setFilter(f.dataset.filter); return; }
    const t = e.target.closest('[data-turn]');
    if (t) { turn(Number(t.dataset.turn)); return; }
    if (e.target.closest('[data-act="close"]')) { closeSpot(); return; }
    if (e.target.closest('[data-act="names"]')) { toggleNames(); return; }
    const c = e.target.closest('.rw-body [data-pid]');
    if (c) openSpot(c.dataset.pid);
  }
  // Tab 으로 카드에 초점이 가면 그 카드를 고른 것으로 본다
  function onFocusIn(e) {
    const c = e.target.closest && e.target.closest('.rw-body [data-pid]');
    if (c) keep.cursor = c.dataset.pid;
  }
  function onFocusOut(e) {
    if (drawing) return;
    if (!e.relatedTarget || !root.contains(e.relatedTarget)) keep.cursor = keep.spot ? keep.cursor : null;
  }
  root.addEventListener('click', onClick);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);

  // 글꼴을 다 받으면 카드 높이가 바뀌므로 다시 잰다
  let alive = true;
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (alive) draw(); });
  }

  draw();

  return {
    update(next) {
      cur = next;
      draw();
    },
    onKey(k, e) {
      const code = e && e.code;
      if (code === 'KeyN' || k === 'n' || k === 'N') { toggleNames(); return true; }
      if (keep.spot) {
        if (k === 'Escape') { closeSpot(); return true; }
        if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown') { stepSpot(1); return true; }
        if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') { stepSpot(-1); return true; }
        if (k === 'Enter' || k === ' ') return true;
        return false;
      }
      if (partner() && (code === 'KeyV' || k === 'v' || k === 'V')) { setMode(keep.mode === 'pairs' ? 'wall' : 'pairs'); return true; }
      if (/^[0-9]$/.test(k) && prompts.length > 1) {
        const n = Number(k);
        if (n === 0) { setFilter('all'); return true; }
        if (prompts[n - 1]) { setFilter(prompts[n - 1].id); return true; }
        return false;
      }
      if (keep.cursor) {
        if (k === 'Enter') { openSpot(keep.cursor); return true; }
        if (k === 'Escape') {
          keep.cursor = null;
          if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
          draw();
          return true;
        }
        if (k === 'ArrowRight' || k === 'ArrowDown') { moveCursor(1); return true; }
        if (k === 'ArrowLeft' || k === 'ArrowUp') { moveCursor(-1); return true; }
      } else if (k === 'Enter') {
        const i = firstOnPage();
        if (i >= 0) { keep.cursor = list[i].pid; draw(); }
        return true;
      }
      if (k === 'PageDown' || k === 'ArrowDown') { turn(1); return true; }
      if (k === 'PageUp' || k === 'ArrowUp') { turn(-1); return true; }
      return false;
    },
    destroy() {
      alive = false;
      clearTimeout(timer);
      root.removeEventListener('click', onClick);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    }
  };
}

export default {
  type: 'rewrite',
  typeLabel: '고쳐 쓰기',
  summary,
  participant,
  adminCard,
  adminResponse,
  adminCell,
  board,
  boardKeys: '↑ ↓ 쪽 · Enter 고르기·띄우기 · N 이름'
};
