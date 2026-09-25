/**
 * live-worksheet 참가자·관리자 화면
 *
 * 주소: index.html?e=<연수 id>
 *   - e 가 없으면 목록 노출 연수를 고르는 화면
 *   - 없는 연수면 "연수를 찾을 수 없습니다"
 * 흐름: 이름 입장(이어하기/새로 시작) → 메뉴(설정 순서대로, 대기·진행·완료) → 활동 화면 / 자료
 *       이름 칸에 관리자 암호를 넣으면 관리자 화면(PC 대시보드)
 * 활동 화면은 부품(assets/activities/*)이 그린다. 이 파일에는 활동 이름이나 연수 이름을 두지 않는다.
 */
import {
  api, Live, esc, rich, len, local, session, keys, draftStore, statusLabel, eventIdFromUrl, fmtDate
} from './core.js';
import { moduleFor } from './activities/registry.js';

const S = {
  eventId: '',
  live: null,
  me: null,          // { id, name }
  passcode: '',      // 관리자 암호(이 탭의 sessionStorage에만 둔다)
  mine: {},          // 활동 id → 내가 낸 payload
  screen: { name: 'boot' },
  view: null,        // 지금 떠 있는 활동 화면(부품이 돌려준 것)
  prevOpen: {},      // 메뉴에서 '방금 열림'을 보이려고 기억해 둔 열림 상태
  peek: null         // 관리자 · 지금 들어온 응답에서 보고 있는 활동 id
};

const app = () => document.getElementById('app');
const ev = () => S.live.data.event;
const acts = () => (ev() && Array.isArray(ev().activities) ? ev().activities : []);
const findAct = (id) => acts().find((a) => a.id === id) || null;
const isOpen = (id) => S.live.isOpen(`open:${id}`);
const circ = (i) => (i < 20 ? String.fromCharCode(0x2460 + i) : String(i + 1));

/* ───────────── 공용 UI ───────────── */

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2800);
}

function liveBadge() {
  const st = S.live ? S.live.status : 'connecting';
  return `<span class="live${st === 'live' ? '' : ' off'}"><i></i>${esc(statusLabel(st))}</span>`;
}

function updateConn() {
  document.querySelectorAll('.conn').forEach((el) => { el.innerHTML = liveBadge(); });
}

function header(title, { back = false } = {}) {
  return '<div class="top">' +
    (back ? '<button class="back" data-nav="menu" aria-label="메뉴로">‹</button>' : '') +
    `<h2>${esc(title)}</h2>` +
    `<span class="conn">${liveBadge()}</span>` +
    (S.me ? `<div class="who">${esc(S.me.name)}</div>` : '') +
    '</div>';
}

function setScreen(name, extra = {}) {
  if (S.view) {
    try { S.view.destroy(); } catch (e) { console.error(e); }
    S.view = null;
  }
  S.screen = { name, ...extra };
  // 관리자 화면만 응답·참가자 변경을 실시간으로 받는다(참가자 화면은 진행 설정만)
  if (S.live) S.live.setRole(name === 'admin' ? 'admin' : 'participant');
  document.body.classList.toggle('adm-mode', name === 'admin');
  document.body.dataset.screen = name;
  window.scrollTo(0, 0);
}

/** 확인 창. 누른 쪽에 따라 true/false */
function confirmBox({ title, body, ok = '확인', cancel = '취소', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal');
    host.innerHTML =
      '<div class="modal-bg">' +
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">' +
      `<h3 id="mTitle">${esc(title)}</h3><p>${body}</p>` +
      '<div class="btn-row">' +
      `<button class="btn ghost" data-m="no">${esc(cancel)}</button>` +
      `<button class="btn${danger ? ' danger' : ''}" data-m="yes">${esc(ok)}</button>` +
      '</div></div></div>';
    const done = (v) => {
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    document.addEventListener('keydown', onKey);
    host.querySelector('[data-m="no"]').onclick = () => done(false);
    host.querySelector('[data-m="yes"]').onclick = () => done(true);
    host.querySelector('.modal-bg').onclick = (e) => { if (e.target === e.currentTarget) done(false); };
    host.querySelector('[data-m="no"]').focus();
  });
}

/* ───────────── 시작 ───────────── */

async function boot() {
  S.eventId = eventIdFromUrl();
  if (!S.eventId) { showPicker(); return; }

  if (!S.live) {
    S.live = new Live(S.eventId);
    S.live.on(onLive);
  }
  let r;
  try {
    r = await S.live.load();
  } catch (e) {
    showError(boot);
    return;
  }
  if (!r || !r.ok) {
    if (r && r.code === 'no_event') showNotFound();
    else showError(boot);
    return;
  }
  document.title = `${ev().title} · 활동지`;
  S.live.start();

  // 관리자로 들어와 있던 탭이면 암호를 다시 확인한다
  const pc = session.get(keys.admin(S.eventId));
  if (pc) {
    try {
      const c = await api.rpc('admin_check', { p_event_id: S.eventId, p_passcode: pc }, { retry: true });
      if (c && c.ok === true) { S.passcode = pc; showAdmin(); return; }
      session.del(keys.admin(S.eventId));
    } catch (e) {
      showError(boot);
      return;
    }
  }

  // 이 기기에 남은 참가자로 이어서 들어간다
  const pid = local.get(keys.participant(S.eventId));
  if (pid) {
    try {
      const x = await api.rpc('restore', { p_event_id: S.eventId, p_participant_id: pid }, { retry: true });
      if (x && x.ok) { setMe(x.participant, x.responses); showMenu(); return; }
      local.del(keys.participant(S.eventId));
    } catch (e) {
      showError(boot);
      return;
    }
  }
  showJoin();
}

function setMe(p, responses) {
  S.me = { id: p.id, name: p.name };
  S.mine = { ...(responses || {}) };
  local.set(keys.participant(S.eventId), p.id);
}

function forgetMe() {
  local.del(keys.participant(S.eventId));
  S.me = null;
  S.mine = {};
}

/** 서버에 내 참가자 기록이 없어졌을 때(관리자가 응답을 비운 경우 등) */
function lostMe() {
  forgetMe();
  toast('참가자 정보를 찾을 수 없습니다. 이름을 다시 적고 들어와 주세요.');
  showJoin();
}

/* ───────────── 연수 고르기 · 없음 · 오류 ───────────── */

async function showPicker() {
  setScreen('picker');
  document.title = '라이브 활동지';
  app().innerHTML =
    '<div class="screen">' +
    '<div class="hero"><div class="eyebrow">라이브 활동지</div><h1>연수 고르기</h1>' +
    '<div class="sub">참여할 연수를 고르세요.</div><div class="rule"></div></div>' +
    '<div class="pick" id="pick"><div class="empty">불러오는 중…</div></div>' +
    '</div>';
  const box = document.getElementById('pick');
  let list;
  try {
    list = await api.listedEvents();
  } catch (e) {
    box.innerHTML = '<div class="empty">목록을 불러오지 못했습니다.</div>' +
      '<button class="btn ghost" id="retry">다시 시도</button>';
    document.getElementById('retry').onclick = showPicker;
    return;
  }
  box.innerHTML = Array.isArray(list) && list.length
    ? list.map((e) =>
      `<a class="pick-card" href="?e=${encodeURIComponent(e.id)}">` +
      `<div class="bk">${esc(fmtDate(e.date))}</div><div class="tt">${esc(e.title)}</div></a>`).join('')
    : '<div class="empty">지금 고를 수 있는 연수가 없습니다.<br>안내받은 주소로 들어와 주세요.</div>';
}

function showNotFound() {
  setScreen('notfound');
  document.title = '연수를 찾을 수 없습니다';
  app().innerHTML =
    '<div class="screen">' +
    '<div class="hero"><div class="eyebrow">라이브 활동지</div><h1>연수를 찾을 수 없습니다</h1>' +
    '<div class="sub">받은 주소를 그대로 입력했는지 확인해 주세요.</div><div class="rule"></div></div>' +
    '<a class="btn ghost" href="./">연수 목록 보기</a>' +
    '</div>';
}

function showError(retry) {
  setScreen('error');
  app().innerHTML =
    '<div class="screen"><div class="wait">' +
    '<div class="ic">📡</div><h3>연결하지 못했습니다</h3>' +
    '<p>와이파이나 데이터 연결을 확인하고 다시 시도해 주세요.</p>' +
    '<button class="btn" id="retry">다시 시도</button>' +
    '</div></div>';
  document.getElementById('retry').onclick = () => {
    app().innerHTML = '<div class="boot"><div class="spinner"></div></div>';
    retry();
  };
}

/* ───────────── 입장 ───────────── */

function showJoin() {
  setScreen('join');
  const e = ev();
  app().innerHTML =
    '<div class="screen">' +
    '<div class="hero">' +
    `<div class="eyebrow">${esc(fmtDate(e.date))}</div>` +
    `<h1>${esc(e.title)}</h1>` +
    (e.description ? `<div class="sub">${rich(e.description)}</div>` : '') +
    '<div class="rule"></div></div>' +
    '<div class="field">' +
    '<label class="label" for="nick">이름 또는 별칭</label>' +
    '<input type="text" id="nick" placeholder="예) 김하늘" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    '<div class="hint">나갔다가 같은 이름으로 다시 들어오면 이어서 할 수 있습니다.</div>' +
    '</div>' +
    '<button class="btn" id="joinBtn">들어가기</button>' +
    '</div>';
  const nick = document.getElementById('nick');
  nick.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !k.isComposing) doJoin(); });
  document.getElementById('joinBtn').onclick = () => doJoin();
}

async function doJoin(mode, typed) {
  const name = String(typed != null ? typed : (document.getElementById('nick') || {}).value || '').trim();
  if (!name) { toast('이름을 적어 주세요.'); return; }
  if (len(name) > 20) { toast('이름은 20자 이내로 적어 주세요.'); return; }
  const btns = [...document.querySelectorAll('#joinBtn, [data-join]')];
  btns.forEach((b) => { b.disabled = true; });
  const idle = () => btns.forEach((b) => { b.disabled = false; });

  let r;
  try {
    r = await api.rpc('join', { p_event_id: S.eventId, p_name: name, p_mode: mode || 'check' });
  } catch (e) {
    toast('연결이 불안정합니다. 다시 시도해 주세요.');
    idle();
    return;
  }
  if (!r || !r.ok) { toast((r && r.msg) || '들어가지 못했습니다.'); idle(); return; }

  if (r.admin) {
    S.passcode = name;
    session.set(keys.admin(S.eventId), name);
    showAdmin();
    return;
  }
  if (r.exists) { showResume(r.name, name); return; }
  setMe(r.participant, r.responses);
  if (r.resumed) toast('이전 기록을 불러왔습니다.');
  showMenu();
}

function showResume(shown, typed) {
  setScreen('resume');
  app().innerHTML =
    '<div class="screen">' +
    `<div class="hero"><h1>‘${esc(shown)}’<br>이름으로 들어온 기록이 있습니다</h1>` +
    '<div class="sub">본인이라면 이어하기를,<br>같은 이름의 다른 분이라면 새로 시작을 누르세요.</div></div>' +
    '<button class="btn" data-join="resume">내 기록 이어하기</button>' +
    '<div class="gap-s"></div>' +
    '<button class="btn line" data-join="new">새로 시작</button>' +
    '<div class="gap-s"></div>' +
    '<button class="btn ghost" data-act="rename">다른 이름 쓰기</button>' +
    '</div>';
  app().querySelectorAll('[data-join]').forEach((b) => {
    b.onclick = () => doJoin(b.dataset.join, typed);
  });
  app().querySelector('[data-act="rename"]').onclick = showJoin;
}

/* ───────────── 메뉴 ───────────── */

function doneCount() {
  return acts().filter((a) => S.mine[a.id]).length;
}

function materialsUnlocked() {
  return S.live.isOpen('materials_open') || (acts().length > 0 && doneCount() === acts().length);
}

function showMenu() {
  if (!S.me) { showJoin(); return; }
  setScreen('menu');
  S.live.need([]);
  app().innerHTML = header(ev().title) + '<div class="screen" id="menuBody"></div>';
  drawMenu();
}

function drawMenu() {
  const body = document.getElementById('menuBody');
  if (!body) return;
  const list = acts();
  const mats = Array.isArray(ev().materials) ? ev().materials : [];
  const unlocked = materialsUnlocked();
  const k = doneCount();

  const justOpened = [];
  const items = list.map((a, i) => {
    const mod = moduleFor(a.type);
    const open = isOpen(a.id);
    const done = !!S.mine[a.id];
    if (open && S.prevOpen[a.id] === false) justOpened.push(a);
    const st = done ? '완료' : (open ? '진행' : '대기');
    const stc = done ? ' done' : (open ? ' open' : '');
    let ds;
    if (!mod) ds = '이 화면에서 열 수 없는 활동입니다';
    else if (open || done) ds = mod.summary(a);
    else ds = '진행자가 열면 시작합니다';
    const cls = 'menu-item' + (open || done ? '' : ' shut') + (open && S.prevOpen[a.id] === false ? ' just-opened' : '');
    return `<button class="${cls}" data-open="${esc(a.id)}"${mod ? '' : ' disabled'}>` +
      `<div class="n">${open || done ? i + 1 : '🔒'}</div>` +
      `<div class="tx"><div class="tt">${esc(a.title)}</div><div class="ds">${esc(ds)}</div></div>` +
      `<div class="st${stc}">${st}</div></button>`;
  }).join('');

  const matItem = mats.length
    ? `<button class="menu-item${unlocked ? '' : ' locked'}" data-open-materials>` +
      `<div class="n">${unlocked ? '★' : '🔒'}</div>` +
      '<div class="tx"><div class="tt">자료</div>' +
      `<div class="ds">${unlocked ? `자료 ${mats.length}개` : `활동을 모두 내면 열립니다 (${k}/${list.length})`}</div></div>` +
      `<div class="st${unlocked ? ' done' : ''}">${unlocked ? '열림' : `${k}/${list.length}`}</div></button>`
    : '';

  body.innerHTML =
    `<div class="progress-bar">${list.map((a) => `<i class="${S.mine[a.id] ? 'on' : ''}"></i>`).join('')}</div>` +
    `<div class="menu">${items}${matItem}</div>` +
    '<div class="menu-foot"><button class="btn ghost sm" data-act="logout">다른 이름으로 들어가기</button></div>';

  body.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => showActivity(b.dataset.open); });
  const m = body.querySelector('[data-open-materials]');
  if (m) m.onclick = showMaterials;
  body.querySelector('[data-act="logout"]').onclick = () => { forgetMe(); showJoin(); };

  if (justOpened.length === 1) toast(`‘${justOpened[0].title}’ 활동이 열렸습니다.`);
  else if (justOpened.length > 1) toast('활동이 열렸습니다.');
  for (const a of list) S.prevOpen[a.id] = isOpen(a.id);
}

/* ───────────── 활동 화면 ───────────── */

function ctxFor(a, root) {
  const d = S.live.data;
  const mine = S.mine[a.id] || null;
  let rows = S.live.rowsFor(a.id);
  // 방금 낸 내 응답이 아직 목록에 없으면 앞에 넣어 둔다(곧 실시간으로 바뀐다)
  if (mine && S.me && !(rows || []).some((r) => r.participant_id === S.me.id)) {
    const now = new Date().toISOString();
    rows = [{ activity_id: a.id, participant_id: S.me.id, payload: mine, created_at: now, updated_at: now }, ...(rows || [])];
  }
  return {
    root,
    event: d.event,
    activity: a,
    index: acts().indexOf(a),
    isOpen: isOpen(a.id),
    reveal: (d.reveal && d.reveal[a.id]) || null,
    me: S.me,
    mine,
    rows,
    names: d.participants ? S.live.names() : null,
    liveBadge: liveBadge(),
    submit: (payload) => submitFor(a, payload),
    draft: draftStore(S.eventId, a.id),
    need: (kinds) => S.live.need(kinds, { activity: a.id }),
    mineOf: (id) => S.mine[id] || null,
    toast,
    goMenu: showMenu
  };
}

async function submitFor(a, payload) {
  let r;
  try {
    r = await api.rpc('submit', {
      p_event_id: S.eventId, p_participant_id: S.me.id, p_activity_id: a.id, p_payload: payload
    });
  } catch (e) {
    toast('제출하지 못했습니다. 연결을 확인하고 다시 눌러 주세요.');
    return false;
  }
  if (!r || !r.ok) {
    if (r && r.code === 'no_participant') { lostMe(); return false; }
    toast((r && r.msg) || '제출하지 못했습니다.');
    if (r && r.code === 'closed') S.live.refresh(['settings']);
    return false;
  }
  S.mine[a.id] = payload;
  S.live.submitted();
  return true;
}

function showActivity(id) {
  const a = findAct(id);
  if (!a || !S.me) { showMenu(); return; }
  const mod = moduleFor(a.type);
  setScreen('activity', { id, mode: 'view' });
  S.live.need([]);
  if (!mod) {
    app().innerHTML = header(a.title, { back: true }) +
      '<div class="screen"><div class="empty">이 화면에서 열 수 없는 활동입니다.</div></div>';
    return;
  }
  if (!isOpen(a.id) && !S.mine[a.id]) {
    S.screen.mode = 'wait';
    drawWait(a);
    return;
  }
  app().innerHTML = header(a.title, { back: true }) + '<div class="screen act" id="actRoot"></div>';
  S.view = mod.participant(ctxFor(a, document.getElementById('actRoot')));
}

/** 닫힌 활동의 대기 화면. closed: 하던 중에 진행자가 닫은 경우 */
function drawWait(a, { closed = false } = {}) {
  app().innerHTML = header(a.title, { back: true }) +
    '<div class="screen"><div class="wait" data-wait>' +
    `<div class="ic">⏳</div><h3>${closed ? '진행자가 활동을 닫았습니다' : '아직 열리지 않았습니다'}</h3>` +
    '<div class="dotline"><i></i><i></i><i></i></div>' +
    (closed
      ? '<p>적던 내용은 이 기기에 남아 있습니다.<br>다시 열리면 이 화면이 바로 바뀝니다.</p>'
      : `<p>${a.description ? `${rich(a.description)}<br><br>` : ''}` +
        '진행자가 열면 이 화면이 바로 바뀝니다.<br>새로고침하지 않아도 됩니다.</p>') +
    '<button class="btn ghost" data-nav="menu">메뉴로</button>' +
    '</div></div>';
}

function refreshActivity(changed) {
  const a = findAct(S.screen.id);
  if (!a) { showMenu(); return; }
  const open = isOpen(a.id);
  const mine = S.mine[a.id];
  if (S.screen.mode === 'wait') {
    if (open || mine) {
      showActivity(a.id);
      if (open) toast('활동이 열렸습니다.');
    }
    return;
  }
  if (!S.view) return;
  if (!open && !mine) {
    setScreen('activity', { id: a.id, mode: 'wait' });
    drawWait(a, { closed: true });
    return;
  }
  if (['settings', 'event', 'responses', 'participants', 'status'].some((k) => changed.has(k))) {
    S.view.update(ctxFor(a, document.getElementById('actRoot')));
  }
}

/* ───────────── 자료 ───────────── */

function showMaterials() {
  setScreen('materials');
  S.live.need([]);
  app().innerHTML = header('자료', { back: true }) + '<div class="screen" id="matBody"></div>';
  drawMaterials();
}

/** http(s) 주소나 저장소 안의 상대 경로만 연다 */
function safeUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return '';
  return s;
}

function matCard(m) {
  const url = safeUrl(m.url);
  const title = rich(m.title);
  if (!url) {
    return '<div class="mat soon" aria-disabled="true"><div class="ic">⏳</div><div class="tx">' +
      `<div class="tt">${title}</div><div class="ds">${m.desc ? `${rich(m.desc)} · ` : ''}준비 중</div></div></div>`;
  }
  let host = '';
  if (/^https?:\/\//i.test(url)) host = url.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  return `<a class="mat" href="${esc(url)}" target="_blank" rel="noopener">` +
    `<div class="ic">${m.kind === '도구' ? '🧰' : '📁'}</div><div class="tx">` +
    `<div class="tt">${title}</div>${m.desc ? `<div class="ds">${rich(m.desc)}</div>` : ''}` +
    (host && m.kind === '도구' ? `<div class="host">${esc(host)}</div>` : '') +
    '</div><div class="go">›</div></a>';
}

function drawMaterials() {
  const body = document.getElementById('matBody');
  if (!body) return;
  const list = acts();
  if (!materialsUnlocked()) {
    body.innerHTML =
      '<div class="lock"><div class="ic">🔒</div><h3>활동을 모두 내면 열립니다</h3>' +
      '<p>남은 활동을 마치면 자료를 볼 수 있습니다.</p>' +
      '<div class="check-list">' +
      list.map((a) => `<div><span class="c${S.mine[a.id] ? ' on' : ''}">✓</span>${esc(a.title)}</div>`).join('') +
      '</div><div class="gap"></div>' +
      '<button class="btn" data-nav="menu">활동으로 돌아가기</button></div>';
    return;
  }
  const mats = Array.isArray(ev().materials) ? ev().materials : [];
  const docs = mats.filter((m) => m.kind !== '도구');
  const tools = mats.filter((m) => m.kind === '도구');
  body.innerHTML =
    '<div class="card blue center"><div class="serif big-t">수고하셨습니다</div>' +
    '<div class="hint">연수에서 쓴 자료입니다. 누르면 새 창으로 열립니다.</div></div>' +
    (docs.length ? `<div class="section-t">자료</div>${docs.map(matCard).join('')}` : '') +
    (tools.length ? `<div class="section-t">도구</div>${tools.map(matCard).join('')}` : '') +
    (mats.length ? '' : '<div class="empty">아직 올린 자료가 없습니다.</div>');
}

/* ───────────── 관리자 · PC 대시보드 ───────────── */

function showAdmin() {
  S.me = null;
  setScreen('admin');
  S.live.need(['participants', 'responses']);
  const e = ev();
  const q = `board.html?e=${encodeURIComponent(S.eventId)}`;
  const list = acts();
  app().innerHTML =
    '<div class="adm">' +
    '<div class="adm-bar">' +
    `<div class="tt">${esc(e.title)}</div>` +
    `<div class="sb">관리자 · ${esc(fmtDate(e.date))}</div>` +
    '<div class="kpi" id="admKpi"></div>' +
    '<div class="sp"></div>' +
    `<span class="conn">${liveBadge()}</span>` +
    '<div class="bl"><span class="bl-lb">모니터에 띄우기</span>' +
    list.map((a, i) => `<a href="${q}&v=${i + 1}" target="_blank" rel="noopener" title="${esc(a.title)}">${circ(i)} ${esc(a.title)}</a>`).join('') +
    `<a href="${q}&v=${list.length + 1}" target="_blank" rel="noopener" class="alt">제출 현황</a>` +
    '</div>' +
    '<button class="btn ghost sm" data-act="adm-exit">나가기</button>' +
    '</div>' +
    '<div class="adm-lead">카드의 스위치를 켜면 참가자 화면이 <b>새로고침 없이</b> 바뀝니다.</div>' +
    `<div class="adm-gates" id="admGates" style="--n:${Math.min(Math.max(list.length, 1), 4)}"></div>` +
    '<div class="adm-grid">' +
    '<section class="pan"><div class="pan-h">공개 제어</div><div id="admCtrl"></div></section>' +
    '<section class="pan"><div class="pan-h">참가자 <span id="admPeopleN"></span></div>' +
    '<div class="pan-scroll" id="admPeople"></div></section>' +
    '<section class="pan"><div class="pan-h">지금 들어온 응답</div>' +
    '<div class="peek-tabs" id="admPeekTabs"></div><div class="pan-scroll" id="admPeek"></div></section>' +
    '</div></div>';

  const root = app().querySelector('.adm');
  root.addEventListener('click', onAdminClick);
  drawAdmin();
}

function adminCtx(a) {
  const d = S.live.data;
  return {
    event: d.event,
    activity: a,
    index: acts().indexOf(a),
    isOpen: isOpen(a.id),
    reveal: (d.reveal && d.reveal[a.id]) || null,
    rows: S.live.rowsFor(a.id) || [],
    names: S.live.names()
  };
}

function drawAdmin() {
  if (S.screen.name !== 'admin') return;
  const d = S.live.data;
  const list = acts();
  // 최근에 들어온 사람이 위에 온다
  const people = (d.participants || []).slice().sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  const N = people.length;
  const byAct = new Map(list.map((a) => [a.id, new Map()]));
  for (const r of d.responses || []) {
    const m = byAct.get(r.activity_id);
    if (m) m.set(r.participant_id, r);
  }
  const allDone = people.filter((p) => list.every((a) => byAct.get(a.id).has(p.id))).length;
  const loaded = d.participants !== null && d.responses !== null;

  document.getElementById('admKpi').innerHTML =
    `<span class="v">${loaded ? N : '…'}</span><span class="k">명 접속</span><span class="dot"></span>` +
    `<span class="v done">${loaded ? allDone : '…'}</span><span class="k">명 모두 완료</span>`;

  // ── 활동 카드
  const q = `board.html?e=${encodeURIComponent(S.eventId)}`;
  document.getElementById('admGates').innerHTML = list.map((a, i) => {
    const mod = moduleFor(a.type);
    const on = isOpen(a.id);
    const c = byAct.get(a.id).size;
    const pct = N ? Math.round((c / N) * 100) : 0;
    const ctx = adminCtx(a);
    const extra = mod ? mod.adminCard(ctx) : '';
    const rv = a.type === 'ox' ? S.live.isOpen(`reveal:${a.id}`) : false;
    return `<div class="gcard${on ? ' on' : ''}" data-card="${esc(a.id)}">` +
      `<div class="gh"><span class="gn">${circ(i)}</span><span class="gt">${esc(a.title)}</span>` +
      `<span class="gstate">${on ? '열림' : '닫힘'}</span></div>` +
      `<div class="gd">${esc(mod ? (mod.summary(a).startsWith(mod.typeLabel) ? mod.summary(a) : `${mod.typeLabel} · ${mod.summary(a)}`) : `알 수 없는 종류 ${a.type}`)}</div>` +
      `<div class="gnum">${c}<small> / ${N}명</small></div>` +
      `<div class="gtrack"><i style="width:${pct}%"></i></div>` +
      (extra ? `<div class="gextra">${extra}</div>` : '') +
      '<div class="gfoot">' +
      switchHTML(`open:${a.id}`, on, `열기: ${a.title}`) +
      `<span class="glb">${on ? '켜짐 · 누르면 닫힘' : '꺼짐 · 누르면 열림'}</span>` +
      `<a class="gboard" href="${q}&v=${i + 1}" target="_blank" rel="noopener">현황판 ↗</a>` +
      '</div>' +
      (a.type === 'ox'
        ? '<div class="gfoot sub">' + switchHTML(`reveal:${a.id}`, rv, `정답 공개: ${a.title}`) +
          `<span class="glb">정답 공개 · ${rv ? '켜짐' : '꺼짐'}</span></div>`
        : '') +
      '</div>';
  }).join('');

  // ── 공개 제어
  const mo = S.live.isOpen('materials_open');
  document.getElementById('admCtrl').innerHTML =
    `<div class="toggle gate${mo ? ' on' : ''}">` +
    '<div class="tx"><div class="tt">자료 전체 공개</div>' +
    '<div class="ds">켜면 활동을 다 내지 않아도 모두에게 자료가 열립니다.</div></div>' +
    switchHTML('materials_open', mo, '자료 전체 공개') + '</div>' +
    '<div class="pan-h gap-t">기록 정리</div>' +
    '<button class="btn danger" data-act="reset">응답 모두 비우기</button>' +
    '<div class="hint center">리허설 기록을 지울 때 씁니다.<br>연수 설정과 스위치 상태는 그대로 둡니다.</div>';

  // ── 참가자 표
  document.getElementById('admPeopleN').textContent = loaded ? `${N}명` : '';
  const peopleEl = document.getElementById('admPeople');
  const st1 = peopleEl.scrollTop;
  peopleEl.innerHTML = !loaded
    ? '<div class="empty">불러오는 중…</div>'
    : !N ? '<div class="empty">아직 들어온 사람이 없습니다.</div>'
      : '<table class="ptable"><thead><tr><th>이름</th>' +
        list.map((a, i) => `<th title="${esc(a.title)}">${circ(i)}</th>`).join('') +
        '</tr></thead><tbody>' +
        people.map((p) => {
          const all = list.every((a) => byAct.get(a.id).has(p.id));
          return `<tr class="${all ? 'all' : ''}"><td class="nm">${esc(p.name)}</td>` +
            list.map((a) => {
              const r = byAct.get(a.id).get(p.id);
              const mod = moduleFor(a.type);
              if (!r) return '<td class="n">·</td>';
              return `<td class="y">${mod && mod.adminCell ? mod.adminCell(adminCtx(a), r) : '✓'}</td>`;
            }).join('') + '</tr>';
        }).join('') + '</tbody></table>';
  peopleEl.scrollTop = st1;

  // ── 지금 들어온 응답
  if (!S.peek || !findAct(S.peek)) {
    const saved = session.get(keys.peek(S.eventId));
    const lastOpen = [...list].reverse().find((a) => isOpen(a.id));
    S.peek = (saved && findAct(saved) ? saved : null) || (lastOpen && lastOpen.id) || (list[0] && list[0].id);
  }
  document.getElementById('admPeekTabs').innerHTML = list.map((a, i) =>
    `<button class="${S.peek === a.id ? 'on' : ''}" data-peek="${esc(a.id)}" title="${esc(a.title)}">` +
    `<span class="pk-t">${circ(i)} ${esc(a.title)}</span><em>${byAct.get(a.id).size}</em></button>`).join('');
  drawPeek();
}

function drawPeek() {
  const el = document.getElementById('admPeek');
  if (!el) return;
  const a = findAct(S.peek);
  const d = S.live.data;
  if (!a) { el.innerHTML = ''; return; }
  if (d.responses === null) { el.innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
  const mod = moduleFor(a.type);
  const ctx = adminCtx(a);
  const rows = ctx.rows; // 최근 제출 순
  const st = el.scrollTop;
  el.innerHTML = !rows.length
    ? '<div class="empty">아직 낸 사람이 없습니다.</div>'
    : rows.map((r) => {
      const t = new Date(r.updated_at);
      const hm = Number.isNaN(t.getTime()) ? '' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      return '<div class="peek-item">' +
        `<div class="pnm">${esc(ctx.names.get(r.participant_id) || '…')}<span class="ptime">${hm}</span></div>` +
        (mod ? mod.adminResponse(ctx, r) : `<pre>${esc(JSON.stringify(r.payload))}</pre>`) +
        '</div>';
    }).join('');
  el.scrollTop = st;
}

function switchHTML(key, on, label) {
  return `<button class="sw${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}"` +
    ` data-key="${esc(key)}" data-val="${on ? 'N' : 'Y'}"></button>`;
}

async function onAdminClick(e) {
  const sw = e.target.closest('[data-key]');
  if (sw) { setKey(sw.dataset.key, sw.dataset.val, sw); return; }
  const pk = e.target.closest('[data-peek]');
  if (pk) {
    S.peek = pk.dataset.peek;
    session.set(keys.peek(S.eventId), S.peek);
    document.querySelectorAll('#admPeekTabs [data-peek]').forEach((b) => b.classList.toggle('on', b.dataset.peek === S.peek));
    document.getElementById('admPeek').scrollTop = 0;
    drawPeek();
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'reset') doReset();
  else if (act.dataset.act === 'adm-exit') {
    session.del(keys.admin(S.eventId));
    S.passcode = '';
    showJoin();
  }
}

function keyToast(key, value) {
  if (key.startsWith('open:')) return value === 'Y' ? '열었습니다.' : '닫았습니다.';
  if (key.startsWith('reveal:')) return value === 'Y' ? '정답을 공개했습니다.' : '정답을 다시 가렸습니다.';
  if (key === 'materials_open') return value === 'Y' ? '모두에게 자료를 열었습니다.' : '자료 전체 공개를 껐습니다.';
  return '바꿨습니다.';
}

async function setKey(key, value, btn) {
  if (btn) btn.disabled = true;
  let r;
  try {
    r = await api.rpc('admin_set', { p_event_id: S.eventId, p_key: key, p_value: value, p_passcode: S.passcode });
  } catch (e) {
    toast('바꾸지 못했습니다. 연결을 확인해 주세요.');
    if (btn) btn.disabled = false;
    return;
  }
  if (!r || !r.ok) {
    toast((r && r.msg) || '바꾸지 못했습니다.');
    if (r && r.code === 'auth') { session.del(keys.admin(S.eventId)); S.passcode = ''; showJoin(); return; }
    if (btn) btn.disabled = false;
    return;
  }
  S.live.data.settings = { ...S.live.data.settings, [key]: value };
  toast(keyToast(key, value));
  drawAdmin();
  S.live.refresh(['settings']);
}

async function doReset() {
  const d = S.live.data;
  const np = (d.participants || []).length;
  const nr = (d.responses || []).length;
  const yes = await confirmBox({
    title: '응답을 모두 비울까요?',
    body: `참가자 ${np}명과 응답 ${nr}건을 지웁니다. 되돌릴 수 없습니다.<br>연수 중이라면 누르지 마세요.`,
    ok: '모두 비우기',
    danger: true
  });
  if (!yes) return;
  let r;
  try {
    r = await api.rpc('admin_reset', { p_event_id: S.eventId, p_passcode: S.passcode });
  } catch (e) {
    toast('비우지 못했습니다. 연결을 확인해 주세요.');
    return;
  }
  if (!r || !r.ok) { toast((r && r.msg) || '비우지 못했습니다.'); return; }
  toast(`참가자 ${r.participants}명, 응답 ${r.responses}건을 지웠습니다.`);
  S.live.refresh(['participants', 'responses']);
}

/* ───────────── 데이터가 바뀌었을 때 ───────────── */

function onLive(changed) {
  if (changed.has('status')) updateConn();
  const d = S.live.data;

  // 내 응답을 서버 기록과 맞춘다(서버가 정리한 글로 바꾼다)
  if (changed.has('responses') && S.me && d.responses) {
    for (const r of d.responses) if (r.participant_id === S.me.id) S.mine[r.activity_id] = r.payload;
  }
  // 관리자가 응답을 비워 내 참가자 기록이 없어졌다
  if (changed.has('participants') && S.me && d.participants && !d.participants.some((p) => p.id === S.me.id)) {
    lostMe();
    return;
  }

  const name = S.screen.name;
  if (name === 'menu' && (changed.has('settings') || changed.has('event'))) drawMenu();
  else if (name === 'materials' && (changed.has('settings') || changed.has('event'))) drawMaterials();
  else if (name === 'admin' && ['settings', 'event', 'participants', 'responses'].some((k) => changed.has(k))) drawAdmin();
  else if (name === 'activity') refreshActivity(changed);
}

/* 헤더의 '‹' 와 '메뉴로' 버튼 */
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav="menu"]');
  if (nav) { e.preventDefault(); showMenu(); }
});

boot();
