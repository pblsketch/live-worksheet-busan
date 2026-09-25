/**
 * live-worksheet 현황판 (프로젝터 한 화면, 1920×1080 기준으로 그리고 창 크기에 맞춰 늘고 준다)
 *
 * 주소: board.html?e=<연수 id>[&v=<화면 번호>]
 *   화면 순서: 활동마다 부품의 현황판 화면(설정 순서, 1…N) → 마지막 제출 현황(N+1)
 * 키: ← → (또는 발표용 리모컨의 PageUp·PageDown) 화면 넘기기 · F 전체화면
 *     키는 지금 화면의 부품이 먼저 받는다(stage_check ↑ ↓ 보기 바꾸기, sentence·rewrite ↑ ↓ PageUp PageDown 쪽 넘기기,
 *     rewrite Enter·Esc·N 등). 부품이 쓰지 않은 키만 위의 틀 동작을 한다.
 * 오른쪽 위에 연결 상태(실시간 / 재조회 / 끊김)를 보인다.
 * 이 파일에는 활동 이름이나 연수 이름을 두지 않는다. 활동 화면은 부품(assets/activities/*)이 그린다.
 */
import { Live, esc, statusLabel, eventIdFromUrl, fmtDate } from './core.js';
import { moduleFor } from './activities/registry.js';

/* ───────────── 순수 함수 (tests/unit 에서 검사) ───────────── */

/** 화면 목록: 활동 순서대로, 마지막에 제출 현황 */
export function screenList(event) {
  const acts = event && Array.isArray(event.activities) ? event.activities : [];
  return acts.map((a, i) => ({ kind: 'activity', key: `a:${a.id}`, activity: a, index: i }))
    .concat({ kind: 'status', key: 'status' });
}

/** 주소의 v(1부터 센 화면 번호) → 0부터 센 위치. 없거나 범위 밖이면 첫 화면 */
export function startIndex(v, count) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s)) return 0;
  const n = Number(s);
  return n >= 1 && n <= count ? n - 1 : 0;
}

/**
 * 제출 현황: 활동별 낸 사람 수, 사람별 완료 표시, 모두 완료한 사람 수.
 * 참가자 목록에 없는 응답(지워지는 중인 기록 등)은 세지 않는다.
 */
export function completion(activities, participants, responses) {
  const acts = activities || [];
  const people = participants || [];
  const known = new Set(people.map((p) => p.id));
  const done = new Map(acts.map((a) => [a.id, new Set()]));
  for (const r of responses || []) {
    const s = done.get(r.activity_id);
    if (s && known.has(r.participant_id)) s.add(r.participant_id);
  }
  const rows = people.map((p) => {
    const marks = acts.map((a) => done.get(a.id).has(p.id));
    return { id: p.id, name: p.name, marks, all: marks.length > 0 && marks.every(Boolean) };
  });
  return {
    total: people.length,
    perActivity: acts.map((a) => ({ id: a.id, count: done.get(a.id).size })),
    people: rows,
    allDone: rows.filter((x) => x.all).length
  };
}

/* ───────────── 화면 ───────────── */

const B = {
  eventId: '',
  live: null,
  screens: [],
  idx: 0,
  view: null,        // 지금 떠 있는 부품 화면 { update, destroy, onKey? }
  mountedKey: '',
  keep: new Map(),   // 활동 id → 부품이 남겨 두는 기억(보기 선택 등)
  started: false
};

const $ = (id) => document.getElementById(id);
const circ = (i) => (i < 20 ? String.fromCharCode(0x2460 + i) : String(i + 1));
const plain = (s) => String(s == null ? '' : s).replace(/<\/?b>/g, '');
const ev = () => B.live.data.event;
const cur = () => B.screens[B.idx];

function connHTML() {
  const st = B.live ? B.live.connection : 'connecting';
  return `<span class="conn-st ${esc(st)}" data-conn="${esc(st)}"><i></i>${esc(statusLabel(st))}</span>`;
}

function keepFor(id) {
  if (!B.keep.has(id)) B.keep.set(id, {});
  return B.keep.get(id);
}

function ctxFor(s) {
  const d = B.live.data;
  const a = s.activity;
  return {
    root: $('stage'),
    event: d.event,
    activity: a,
    index: s.index,
    isOpen: B.live.isOpen(`open:${a.id}`),
    reveal: (d.reveal && d.reveal[a.id]) || null,
    rows: B.live.rowsFor(a.id),
    rowsOf: (id) => B.live.rowsFor(id) || [],
    names: B.live.names(),
    participants: d.participants,
    keep: keepFor(a.id)
  };
}

/* ─── 위 · 아래 막대 ─── */

function drawBar() {
  const s = cur();
  const e = ev();
  const sub = `${esc(e.title)}${e.date ? ` · ${esc(fmtDate(e.date))}` : ''}`;
  let lead;
  let pills = '';
  let count;
  if (s.kind === 'activity') {
    const a = s.activity;
    const open = B.live.isOpen(`open:${a.id}`);
    const rows = B.live.rowsFor(a.id);
    lead = `<div class="t-no">${s.index + 1}</div><div class="t-tx"><div class="ttl">${esc(a.title)}</div><div class="sub">${sub}</div></div>`;
    pills = `<span class="pill ${open ? 'on' : 'shut'}">${open ? '열림' : '닫힘'}</span>` +
      (a.type === 'ox' && B.live.data.reveal && B.live.data.reveal[a.id] ? '<span class="pill rv">정답 공개</span>' : '');
    count = `<b>${rows ? rows.length : '…'}</b><small>명 제출</small>`;
  } else {
    const ps = B.live.data.participants;
    lead = `<div class="t-tx"><div class="ttl">제출 현황</div><div class="sub">${sub}</div></div>`;
    count = `<b>${ps ? ps.length : '…'}</b><small>명 접속</small>`;
  }
  $('bar').innerHTML = `${lead}<div class="sp"></div>${pills}<div class="cnt" id="barCount">${count}</div>` +
    `<div class="conn" id="conn">${connHTML()}</div>`;
}

function drawConn() {
  const c = $('conn');
  if (c) c.innerHTML = connHTML();
}

function drawNav() {
  const s = cur();
  const mod = s.kind === 'activity' ? moduleFor(s.activity.type) : null;
  const more = mod && mod.boardKeys ? ` · ${esc(mod.boardKeys)}` : '';
  $('nav').innerHTML =
    '<div class="nav-list">' +
    B.screens.map((x, i) =>
      `<button type="button" class="${i === B.idx ? 'on' : ''}" data-go="${i}"` +
      `${i === B.idx ? ' aria-current="page"' : ''}>` +
      (x.kind === 'activity' ? `<span class="nn">${circ(x.index)}</span>${esc(x.activity.title)}` : '제출 현황') +
      '</button>').join('') +
    '</div>' +
    `<div class="tip">← → 화면${more} · F 전체화면</div>` +
    '<button type="button" class="fs" data-act="fs" aria-label="전체화면">⛶</button>';
}

/* ─── 가운데 ─── */

function mount() {
  if (B.view) {
    try { B.view.destroy(); } catch (e) { console.error(e); }
    B.view = null;
  }
  const s = cur();
  const stage = $('stage');
  stage.innerHTML = '';
  stage.className = 'stage';
  B.mountedKey = s.key;
  document.body.dataset.screen = s.kind === 'activity' ? s.activity.type : 'status';
  document.body.dataset.screenNo = String(B.idx + 1);
  document.title = `${plain(s.kind === 'activity' ? s.activity.title : '제출 현황')} · 현황판`;
  if (s.kind === 'status') {
    drawStatus();
    return;
  }
  const mod = moduleFor(s.activity.type);
  if (!mod || typeof mod.board !== 'function') {
    stage.innerHTML = '<div class="blank"><h2>현황판 화면이 없는 활동입니다</h2>' +
      `<p>종류: ${esc(s.activity.type)}</p></div>`;
    return;
  }
  try {
    B.view = mod.board(ctxFor(s));
  } catch (e) {
    console.error(e);
    stage.innerHTML = '<div class="blank"><h2>이 화면을 그리지 못했습니다</h2></div>';
  }
}

function refreshView() {
  const s = cur();
  if (s.kind === 'status') { drawStatus(); return; }
  if (B.view) {
    try { B.view.update(ctxFor(s)); } catch (e) { console.error(e); }
  }
}

function drawStatus() {
  const d = B.live.data;
  const acts = (ev().activities || []);
  const stage = $('stage');
  if (!d.participants || !d.responses) {
    stage.innerHTML = '<div class="blank"><h2>불러오는 중…</h2></div>';
    return;
  }
  const c = completion(acts, d.participants, d.responses);
  const N = c.total;
  const gauges = acts.map((a, i) => {
    const open = B.live.isOpen(`open:${a.id}`);
    const v = c.perActivity[i].count;
    const pct = N ? Math.round((v / N) * 100) : 0;
    return `<div class="gauge${open ? '' : ' shut'}" data-gauge="${esc(a.id)}">` +
      `<div class="k"><span class="nn">${circ(i)}</span><span class="kt">${esc(a.title)}</span>` +
      `${open ? '' : '<span class="kc">닫힘</span>'}</div>` +
      `<div class="v"><b>${v}</b><small>/ ${N}명</small></div>` +
      `<div class="track"><i style="width:${pct}%"></i></div></div>`;
  }).join('');
  const mo = B.live.isOpen('materials_open');
  stage.innerHTML =
    '<div class="st">' +
    `<div class="gauges" style="--n:${Math.min(Math.max(acts.length, 1), 4)}">${gauges}</div>` +
    '<div class="st-line">' +
    `<span>모두 완료 <b class="done">${c.allDone}명</b></span>` +
    `<span>자료 ${mo ? '<b class="done">모두에게 열림</b>' : '<b>다 낸 사람에게만 열림</b>'}</span>` +
    `<span class="st-key">이름 옆 점 = 활동 순서대로 낸 것(${acts.map((_, i) => circ(i)).join(' ')})</span>` +
    '</div>' +
    '<div class="chips">' +
    (c.people.length
      ? c.people.map((p) =>
        `<div class="chip${p.all ? ' all' : ''}" data-person="${esc(p.id)}">` +
        `<span class="cn">${esc(p.name)}</span><span class="dots">` +
        p.marks.map((m) => `<i class="${m ? 'on' : ''}"></i>`).join('') + '</span></div>').join('')
      : '<div class="side-empty">아직 들어온 사람이 없습니다.</div>') +
    '</div></div>';
}

/* ─── 넘기기 ─── */

function go(i) {
  const n = B.screens.length;
  B.idx = ((i % n) + n) % n;
  try {
    const u = new URL(location.href);
    u.searchParams.set('v', String(B.idx + 1));
    history.replaceState(null, '', u.pathname + u.search);
  } catch { /* 주소는 못 바꿔도 화면은 넘긴다 */ }
  mount();
  drawBar();
  drawNav();
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  } catch { /* 전체화면을 못 쓰는 브라우저 */ }
}

function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!B.screens.length) return;
  const k = e.key;
  // 지금 화면의 부품이 먼저 받는다(쪽 넘기기·보기 바꾸기·골라 띄우기)
  if (B.view && typeof B.view.onKey === 'function') {
    let used = false;
    try { used = B.view.onKey(k, e); } catch (err) { console.error(err); }
    if (used) { e.preventDefault(); return; }
  }
  if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); go(B.idx + 1); return; }
  if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(B.idx - 1); return; }
  // 한글 입력 상태에서도 F 자리 키면 된다
  if (e.code === 'KeyF' || k === 'f' || k === 'F') { e.preventDefault(); toggleFullscreen(); }
}

function onClick(e) {
  const g = e.target.closest('[data-go]');
  if (g) { go(Number(g.dataset.go)); return; }
  if (e.target.closest('[data-act="fs"]')) toggleFullscreen();
}

/* ─── 데이터가 바뀌었을 때 ─── */

function onLive(changed) {
  if (!B.started) return;
  if (changed.has('status')) drawConn();
  if (changed.has('event')) {
    // 설정을 다시 등록했다: 화면 목록을 새로 만들고, 보던 화면이 남아 있으면 그대로 둔다
    const key = B.mountedKey;
    B.screens = screenList(ev());
    const i = B.screens.findIndex((s) => s.key === key);
    B.idx = i >= 0 ? i : Math.min(B.idx, B.screens.length - 1);
    mount();
    drawBar();
    drawNav();
    return;
  }
  if (['settings', 'participants', 'responses'].some((k) => changed.has(k))) {
    drawBar();
    refreshView();
  }
}

/* ─── 시작 ─── */

function showMessage(title, desc, { retry = false } = {}) {
  $('bar').innerHTML = '<div class="t-tx"><div class="ttl">현황판</div></div><div class="sp"></div>';
  $('nav').innerHTML = '';
  $('stage').innerHTML = `<div class="blank big"><h2>${esc(title)}</h2><p>${desc}</p>` +
    (retry ? '<button type="button" class="retry" id="retry">다시 시도</button>' : '') + '</div>';
  if (retry) $('retry').onclick = () => boot();
}

let retryTimer = null;

async function boot() {
  clearTimeout(retryTimer);
  B.eventId = eventIdFromUrl();
  if (!B.eventId) {
    document.title = '연수를 찾을 수 없습니다 · 현황판';
    showMessage('연수를 찾을 수 없습니다', '주소 끝에 <b>?e=연수 id</b>를 붙여 열어 주세요.');
    return;
  }
  if (!B.live) {
    B.live = new Live(B.eventId, { role: 'board' });
    B.live.on(onLive);
  }
  let r;
  try {
    r = await B.live.load();
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    if (r && r.code === 'no_event') {
      document.title = '연수를 찾을 수 없습니다 · 현황판';
      showMessage('연수를 찾을 수 없습니다', `받은 주소의 연수 id(<b>${esc(B.eventId)}</b>)가 맞는지 확인해 주세요.`);
      return;
    }
    showMessage('연결하지 못했습니다', '인터넷 연결을 확인해 주세요. 10초 뒤에 다시 시도합니다.', { retry: true });
    retryTimer = setTimeout(boot, 10000);
    return;
  }
  B.screens = screenList(ev());
  B.idx = startIndex(new URLSearchParams(location.search).get('v'), B.screens.length);
  B.started = true;
  B.live.need(['participants', 'responses']);
  B.live.start();
  mount();
  drawBar();
  drawNav();
}

function bindOnce() {
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  // 창 크기가 바뀌면 다시 그린다(글자 크기가 창에 맞춰 바뀌므로 넘치는 카드를 다시 잰다)
  let rz = null;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (B.started) refreshView(); }, 200);
  });
  // 가만히 있으면 마우스 포인터를 숨긴다(프로젝터 화면에 남지 않게)
  let idle = null;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => document.body.classList.add('idle'), 3000);
  };
  document.addEventListener('mousemove', wake);
  wake();
}

if (typeof document !== 'undefined' && document.getElementById('board')) {
  bindOnce();
  boot();
}
