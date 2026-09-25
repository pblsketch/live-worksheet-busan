/**
 * 활동 부품: sentence (문장 틀을 고르고 빈칸을 채운다)
 *
 * 공개 설정: templates[{ id, label, before, after, placeholder? }] — 틀이 둘 이상이면 참가자가 하나를 고른다.
 *           placeholder 는 글상자 안내 문구(60자 이내, 없으면 '빈칸에 들어갈 말')
 * payload: { template: '<틀 id>', blank: '2~60자' }
 */
import { esc, rich, len, oneLine } from '../core.js';
import {
  freshKeys, FRESH_MS, byFirst, paginate, clampPage, measureHeights, columnBox, pagerHTML
} from '../paging.js';

export { freshKeys, FRESH_MS };

const MIN = 2;
const MAX = 60;

export function templateOf(activity, id) {
  return (activity.templates || []).find((t) => t.id === id) || null;
}

export const DEFAULT_PLACEHOLDER = '빈칸에 들어갈 말';

/** 글상자 안내 문구: 고른 틀의 placeholder, 없으면 기본 문구 */
export function placeholderOf(tpl) {
  return tpl && typeof tpl.placeholder === 'string' && tpl.placeholder.trim() ? tpl.placeholder : DEFAULT_PLACEHOLDER;
}

/** 틀 + 빈칸 → 문장 HTML (빈칸은 <b>로 감싼다. 참가자 글은 이스케이프) */
export function sentenceHTML(tpl, blank) {
  if (!tpl) return esc(blank);
  return `${tpl.before ? `${rich(tpl.before)} ` : ''}<b>${esc(blank)}</b>${tpl.after ? ` ${rich(tpl.after)}` : ''}`;
}

/* ───────────── 참가자 화면 ───────────── */

function participant(ctx) {
  const a = ctx.activity;
  const tpls = a.templates || [];
  const multi = tpls.length > 1;
  const root = ctx.root;
  const draft = ctx.draft;
  let cur = ctx;

  const saved = draft.load();
  const base = saved || ctx.mine || {};
  const form = {
    template: templateOf(a, base.template) ? base.template : (multi ? null : (tpls[0] && tpls[0].id)),
    blank: typeof base.blank === 'string' ? base.blank : ''
  };
  let mode = ctx.mine && (!saved || !ctx.isOpen) ? 'result' : 'form';

  const save = () => draft.save(form);

  function previewHTML() {
    const t = templateOf(a, form.template);
    if (!t) return '<div class="fill muted-fill">하나를 고르면 여기에 문장이 나옵니다.</div>';
    const b = oneLine(form.blank);
    return '<div class="fill">' +
      (t.before ? `${rich(t.before)} ` : '') +
      `<span class="blank${b ? '' : ' empty'}">${esc(b)}</span>` +
      (t.after ? ` ${rich(t.after)}` : '') + '</div>';
  }

  function drawForm() {
    root.innerHTML =
      (a.description ? `<div class="hint lead">${rich(a.description)}</div>` : '') +
      (multi
        ? `<div class="step"><span>1</span>${tpls.length === 2 ? '둘 중 하나를 고르세요' : `${tpls.length}개 가운데 하나를 고르세요`}</div>` +
          '<div class="tpls" id="tpls">' +
          tpls.map((t) =>
            `<label class="tpl${form.template === t.id ? ' on' : (form.template ? ' off' : '')}">` +
            `<input type="radio" name="tpl" value="${esc(t.id)}"${form.template === t.id ? ' checked' : ''}>` +
            `<span class="tpl-lb">${rich(t.label || '')}</span>` +
            `<span class="tpl-tx">${t.before ? rich(t.before) : ''} <i>____</i> ${t.after ? rich(t.after) : ''}</span>` +
            '</label>').join('') +
          '</div>' +
          '<div class="step"><span>2</span>고른 문장의 빈칸 채우기</div>'
        : '') +
      `<div id="pv">${previewHTML()}</div>` +
      '<div class="field">' +
      `<textarea id="blank" rows="2" maxlength="${MAX}" placeholder="${esc(placeholderOf(templateOf(a, form.template)))}"${form.template ? '' : ' disabled'}>${esc(form.blank)}</textarea>` +
      `<div class="hint">앞뒤 말과 이어지게 적어 주세요. ${MIN}~${MAX}자</div>` +
      '</div>' +
      `<div class="sticky-b"><button class="btn" data-act="submit">${cur.mine ? '고쳐서 다시 내기' : '제출하기'}</button></div>`;

    const ta = root.querySelector('#blank');
    ta.addEventListener('input', () => {
      form.blank = ta.value;
      save();
      root.querySelector('#pv').innerHTML = previewHTML();
    });
    const tp = root.querySelector('#tpls');
    if (tp) {
      tp.addEventListener('change', (e) => {
        if (e.target.name !== 'tpl') return;
        form.template = e.target.value;
        tp.querySelectorAll('.tpl').forEach((l) => {
          const on = l.querySelector('input').checked;
          l.classList.toggle('on', on);
          l.classList.toggle('off', !on);   // 고르지 않은 쪽은 흐리게: 한 문장만 낸다는 것이 보이게
        });
        ta.disabled = false;
        ta.placeholder = placeholderOf(templateOf(a, form.template));
        save();
        root.querySelector('#pv').innerHTML = previewHTML();
        ta.focus();
      });
    }
    root.querySelector('[data-act="submit"]').onclick = submit;
  }

  async function submit(e) {
    const btn = e.currentTarget;
    if (!templateOf(a, form.template)) { cur.toast('문장을 하나 먼저 골라 주세요.'); return; }
    const b = oneLine(form.blank);
    if (!b) { cur.toast('빈칸을 채워 주세요.'); return; }
    if (len(b) < MIN) { cur.toast('조금만 더 구체적으로 적어 주세요.'); return; }
    if (len(b) > MAX) { cur.toast(`${MAX}자 이내로 적어 주세요.`); return; }
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '제출하는 중…';
    const ok = await cur.submit({ template: form.template, blank: b });
    if (!ok) { btn.disabled = false; btn.textContent = label; return; }
    draft.clear();
    cur.toast('제출했습니다.');
    mode = 'result';
    window.scrollTo(0, 0);
    drawResult();
  }

  function drawResult() {
    cur.need(['responses', 'participants']);
    const rows = cur.rows || [];
    const names = cur.names;
    const list = rows.slice(0, 200).map((r) => {
      const p = r.payload || {};
      const t = templateOf(a, p.template);
      const who = (names && names.get(r.participant_id)) || (r.participant_id === cur.me.id ? cur.me.name : '…');
      return `<div class="stream-item${r.participant_id === cur.me.id ? ' mine' : ''}">` +
        `<div class="nm">${esc(who)}${multi && t ? `<span class="tag">${rich(t.label || '')}</span>` : ''}</div>` +
        `<div class="tx">${sentenceHTML(t, p.blank)}</div></div>`;
    }).join('');

    root.innerHTML =
      '<div class="card blue center">' +
      `<div class="big-num">${rows.length}<span>개</span></div>` +
      `<div class="hint">문장 · ${cur.liveBadge}</div>` +
      '</div>' +
      (cur.isOpen ? '<button class="btn line" data-act="edit">고쳐서 다시 내기</button>' : '') +
      `<div class="stream">${list || '<div class="empty">아직 낸 사람이 없습니다.</div>'}</div>` +
      '<div class="sticky-b"><button class="btn" data-act="menu">메뉴로</button></div>';

    const edit = root.querySelector('[data-act="edit"]');
    if (edit) {
      edit.onclick = () => {
        const d = draft.load() || cur.mine || {};
        if (templateOf(a, d.template)) form.template = d.template;
        form.blank = typeof d.blank === 'string' ? d.blank : '';
        mode = 'form';
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
  const n = (activity.templates || []).length;
  return n > 1 ? `문장 틀 ${n}개` : '빈칸 한 곳';
}

function adminCard(ctx) {
  const a = ctx.activity;
  const tpls = a.templates || [];
  const rows = ctx.rows || [];
  if (tpls.length < 2 || !rows.length) return '';
  return tpls.map((t) => {
    const n = rows.filter((r) => r.payload && r.payload.template === t.id).length;
    return `${rich(t.label || t.id)} <b>${n}</b>`;
  }).join(' · ');
}

function adminResponse(ctx, row) {
  const a = ctx.activity;
  const p = row.payload || {};
  const t = templateOf(a, p.template);
  return `<div class="ptx">${(a.templates || []).length > 1 && t ? `<span class="tag">${rich(t.label || '')}</span> ` : ''}` +
    `${sentenceHTML(t, p.blank)}</div>`;
}

/* ───────────── 현황판 ───────────── */

/**
 * 현황판 카드 목록: 처음 낸 순서(새 카드는 끝에 붙고, 다시 내도 자리가 그대로다).
 * key 는 다시 내면 바뀐다(다시 낸 문장도 잠깐 강조한다)
 */
export function sentenceCards(activity, rows) {
  return byFirst(rows).map((r) => {
    const p = (r && r.payload) || {};
    return {
      key: `${r.participant_id}|${r.updated_at || r.created_at || ''}`,
      pid: r.participant_id,
      template: templateOf(activity, p.template),
      blank: typeof p.blank === 'string' ? p.blank : ''
    };
  });
}

const COLS = 3;

/**
 * 문장 카드 3열. 처음 낸 순서로 쌓고, 화면에 들어가는 만큼 한 쪽에 둔다(↓ ↑ · PageDown PageUp 로 넘긴다).
 * 새 문장은 노란 테두리로 끝에 붙고, 카드마다 틀 라벨과 이름을 붙인다(이름은 보인다, 결정 11).
 */
function board(ctx) {
  const a = ctx.activity;
  const tpls = a.templates || [];
  const root = ctx.root;
  const keep = ctx.keep || {};
  if (!keep.seen) keep.seen = new Map();
  if (typeof keep.page !== 'number') keep.page = 0;
  let cur = ctx;
  let timer = null;
  let pages = [];
  let alive = true;

  const nameOf = (pid) => (cur.names && cur.names.get(pid)) || '…';

  function cardHTML(c, fresh) {
    const lb = c.template && c.template.label ? `<span class="tag">${rich(c.template.label)}</span>` : '';
    return `<div class="sncard${fresh ? ' fresh' : ''}" data-pid="${esc(c.pid)}">` +
      `<div class="sh">${lb}<span class="nm">${esc(nameOf(c.pid))}</span></div>` +
      `<div class="tx">${sentenceHTML(c.template, c.blank)}</div></div>`;
  }

  function draw() {
    clearTimeout(timer);
    const rows = cur.rows;
    if (!rows) {
      root.innerHTML = '<div class="blank"><h2>불러오는 중…</h2></div>';
      return;
    }
    const cards = sentenceCards(a, rows);
    const now = Date.now();
    const fresh = freshKeys(keep.seen, cards.map((c) => c.key), now, { first: !keep.ready });
    keep.ready = true;

    if (!cards.length) {
      pages = [];
      root.innerHTML = '<div class="blank"><h2>아직 문장이 없습니다</h2>' +
        `<p>${cur.isOpen ? '문장이 들어오면 여기에 한 장씩 쌓입니다.' : '관리자 화면에서 이 활동을 열어 주세요.'}</p></div>`;
      return;
    }
    const counts = tpls.length > 1
      ? '<div class="sn-top">' + tpls.map((t) => {
        const n = cards.filter((c) => c.template && c.template.id === t.id).length;
        return `<span class="sn-t"><span class="tag">${rich(t.label || t.id)}</span><b>${n}</b></span>`;
      }).join('') + '<span class="sn-pg"></span></div>'
      : '<div class="sn-top solo"><span class="sn-pg"></span></div>';
    root.innerHTML = `<div class="sn">${counts}<div class="sn-cols">` +
      Array.from({ length: COLS }, () => '<div class="sn-col"></div>').join('') + '</div></div>';

    // 실제 칸 크기로 카드 높이를 재서 한 쪽에 들어가는 만큼 둔다(잘린 카드가 보이지 않게)
    const colEls = [...root.querySelectorAll('.sn-col')];
    const box = columnBox(colEls[0]);
    const htmls = cards.map((c) => cardHTML(c, fresh.has(c.key)));
    const heights = measureHeights(root.querySelector('.sn'), htmls, box.width, 'sn-col sn-measure');
    pages = paginate(heights, { cols: COLS, height: box.height, gap: box.gap });
    keep.page = clampPage(keep.page, pages.length);
    pages[keep.page].forEach((idxs, c) => { colEls[c].innerHTML = idxs.map((i) => htmls[i]).join(''); });

    const later = cards.filter((c, i) => fresh.has(c.key) && !pages[keep.page].some((col) => col.includes(i))).length;
    root.querySelector('.sn-pg').innerHTML = pagerHTML(keep.page, pages.length, cards.length) +
      (later ? `<span class="pg-new">다른 쪽에 새 문장 ${later}</span>` : '');

    if (fresh.size) timer = setTimeout(draw, FRESH_MS + 200); // 강조가 저절로 걷히게 한 번 더 그린다
  }

  function turn(d) {
    const next = clampPage(keep.page + d, pages.length);
    if (next === keep.page) return;
    keep.page = next;
    draw();
  }

  const onClick = (e) => {
    const t = e.target.closest('[data-turn]');
    if (t) turn(Number(t.dataset.turn));
  };
  root.addEventListener('click', onClick);
  // 글꼴을 다 받으면 카드 높이가 바뀌므로 다시 잰다
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (alive) draw(); });
  }

  draw();

  return {
    update(next) {
      cur = next;
      draw();
    },
    onKey(k) {
      if (k === 'PageDown' || k === 'ArrowDown') { turn(1); return true; }
      if (k === 'PageUp' || k === 'ArrowUp') { turn(-1); return true; }
      return false;
    },
    destroy() {
      alive = false;
      clearTimeout(timer);
      root.removeEventListener('click', onClick);
    }
  };
}

export default {
  type: 'sentence',
  typeLabel: '문장',
  boardKeys: '↑ ↓ 쪽',
  summary,
  participant,
  adminCard,
  adminResponse,
  adminCell: () => '✓',
  board
};
