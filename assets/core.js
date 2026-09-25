/**
 * live-worksheet 공용 코어 (참가자·관리자 화면과 현황판이 함께 쓴다)
 *
 * - api      : 서버 함수(RPC)와 공개 표 읽기. publishable key만 쓴다.
 * - Live     : 연수 하나의 데이터(설정·진행 설정·공개 내용·참가자·응답)를 들고
 *              실시간 방송(event_id 필터)으로 갱신한다. 실시간이 안 되면 20초마다 다시 불러온다.
 *              참가자 기기는 진행 설정만 구독하고, 다른 사람 결과는 제출 직후와 15~25초마다 다시 불러온다.
 *              응답·참가자 변경은 관리자 화면과 현황판만 구독한다(subscribedTables).
 * - 저장소   : 기기에 남기는 참가자 id·관리자 암호·입력 중 내용.
 * - 글 도우미: esc(모든 글 이스케이프), rich(설정 문구의 <b>만 살림), len(코드 포인트 글자 수)
 *
 * 부산 판: DB 이름(표·서버 함수)·실시간 채널·기기 저장소 키의 접두어는 NS 한 곳에서 정한다.
 * 반곡고 판(lw_, 저장소 키 lw:)과 같은 Supabase 프로젝트·같은 출처(pblsketch.github.io)를 쓰므로 섞이지 않게 한다.
 */
import { CONFIG } from './config.js';

/** 이름 접두어: 표 lwb_events…, 서버 함수 lwb_join…, 채널 lwb-…, 저장소 키 lwb:… */
export const NS = 'lwb';
/** 표·서버 함수의 전체 이름 ('join' → 'lwb_join') */
export const dbName = (name) => `${NS}_${name}`;

/* ───────────── 글 도우미 ───────────── */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 참가자가 입력한 글을 포함해 모든 글은 이것으로 이스케이프해서 그린다 */
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** 연수 설정 문구: 이스케이프한 뒤 <b>, </b> 만 되살린다 */
export function rich(s) {
  return esc(s).replace(/&lt;(\/?)b&gt;/g, '<$1b>');
}

/** 글자 수(코드 포인트). 서버와 같은 방식으로 센다 */
export function len(s) {
  return [...String(s == null ? '' : s)].length;
}

/** 앞뒤 공백을 떼고 연속 공백을 하나로 (서버의 정리 방식과 같다) */
export function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/* ───────────── 서버 호출 ───────────── */

export class ApiError extends Error {
  constructor(message, { network = false, status = 0 } = {}) {
    super(message);
    this.network = network;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(CONFIG.supabaseUrl + path, {
        method,
        cache: 'no-store',
        signal: ctrl.signal,
        headers: {
          apikey: CONFIG.supabaseKey,
          Authorization: `Bearer ${CONFIG.supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new ApiError('연결이 불안정합니다.', { network: true });
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* 본문 그대로 */ }
    if (!res.ok) throw new ApiError(`서버 오류 (${res.status})`, { status: res.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** 읽기 전용 호출은 연결 오류일 때 한 번 더 해 본다 */
async function withRetry(fn) {
  try { return await fn(); } catch (e) {
    if (!(e instanceof ApiError) || !e.network) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return fn();
  }
}

export const api = {
  /** 서버 함수. fn 은 접두어 뺀 이름('join' → lwb_join). 실패도 {ok:false, code, msg} 로 돌아온다(연결 오류만 예외) */
  rpc(fn, args = {}, { retry = false } = {}) {
    const go = () => request(`/rest/v1/rpc/${dbName(fn)}`, { method: 'POST', body: args });
    return retry ? withRetry(go) : go();
  },
  /** 공개 표 읽기. table 은 접두어 뺀 이름, query 예: 'select=key,value&event_id=eq.x' */
  get(table, query) {
    return withRetry(() => request(`/rest/v1/${dbName(table)}?${query}`));
  },
  getEvent(eventId) {
    return this.rpc('get_event', { p_event_id: eventId }, { retry: true });
  },
  listedEvents() {
    return this.get('events', 'select=id,title,date&listed=is.true&order=date.desc');
  }
};

/* ───────────── 기기 저장소 ───────────── */

function safe(storageName) {
  return {
    get(k) { try { return window[storageName].getItem(k); } catch { return null; } },
    set(k, v) { try { window[storageName].setItem(k, v); } catch { /* 저장 불가(사생활 보호 모드 등) */ } },
    del(k) { try { window[storageName].removeItem(k); } catch { /* 무시 */ } }
  };
}
export const local = safe('localStorage');
export const session = safe('sessionStorage');

/** 기기 저장소 키. 반곡고 판(lw:)과 같은 출처라 접두어로 나눈다 */
export const keys = {
  participant: (eventId) => `${NS}:${eventId}:pid`,
  admin: (eventId) => `${NS}:${eventId}:admin`,
  draft: (eventId, activityId) => `${NS}:${eventId}:draft:${activityId}`,
  peek: (eventId) => `${NS}:${eventId}:peek`
};

/** 활동별 입력 중 내용(자동 저장) */
export function draftStore(eventId, activityId) {
  const k = keys.draft(eventId, activityId);
  return {
    load() {
      const raw = local.get(k);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    save(obj) { local.set(k, JSON.stringify(obj)); },
    clear() { local.del(k); }
  };
}

/* ───────────── 연수 데이터와 실시간 ───────────── */

const KIND_TABLE = { settings: dbName('settings'), participants: dbName('participants'), responses: dbName('responses') };
const TABLE_KIND = Object.fromEntries(Object.entries(KIND_TABLE).map(([k, t]) => [t, k]));
const SAFETY_POLL_MS = 60000; // 실시간이 붙어 있어도 가끔 진행 설정을 다시 확인한다

/** 참가자 기기가 다른 사람 결과(OX 분포·문장 목록 등)를 다시 불러오는 간격: 15~25초 사이 무작위 */
export const PEEK_MS = Object.freeze([15000, 25000]);
/** 관리자·현황판: 응답·참가자 변경 알림은 첫 알림부터 이만큼 모았다가 한 번에 다시 불러온다 */
export const BATCH_MS = 600;

/**
 * 역할별로 실시간 구독할 표.
 *   participant  진행 설정만. 응답·참가자 변경은 받지 않는다(100명이 한꺼번에 내도 알림이 참가자 기기로 퍼지지 않게)
 *   admin, board 진행 설정 + 지금 화면에 필요한 것(need)
 */
export function subscribedTables(role, needs = []) {
  const want = new Set(needs);
  const kinds = ['settings'];
  if (role === 'admin' || role === 'board') {
    for (const k of ['participants', 'responses']) if (want.has(k)) kinds.push(k);
  }
  return kinds.map((k) => KIND_TABLE[k]);
}

/** 다음 재조회까지 기다릴 시간(참가자 기기). r 은 0~1 */
export function peekDelay(r = Math.random()) {
  return Math.round(PEEK_MS[0] + r * (PEEK_MS[1] - PEEK_MS[0]));
}

/**
 * 표 읽기 주소(접두어 뺀 표 이름, 조건). 참가자 기기는 보고 있는 활동의 응답만, 이름은 id·이름만 받는다.
 * @returns {{ table: string, query: string }}
 */
export function rowsQuery(kind, { eventId, role = 'participant', activity = null }) {
  const ev = `event_id=eq.${encodeURIComponent(eventId)}`;
  const mine = role === 'participant';
  if (kind === 'participants') {
    return { table: 'participants', query: `select=${mine ? 'id,name' : 'id,name,created_at,last_seen'}&${ev}&order=created_at.asc` };
  }
  return {
    table: 'responses',
    query: `select=activity_id,participant_id,payload,created_at,updated_at&${ev}` +
      `${mine && activity ? `&activity_id=eq.${encodeURIComponent(activity)}` : ''}&order=updated_at.desc`
  };
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * 연수 하나의 데이터.
 *   data.event        공개 설정(id, title, date, description, activities, materials)
 *   data.settings     { '<key>': 'Y'|'N' }
 *   data.reveal       { '<ox 활동 id>': { answers, labels?, notes?, panel? } } (공개된 것만)
 *   data.participants [{ id, name, created_at?, last_seen? }] | null (필요할 때만 불러온다)
 *   data.responses    [{ activity_id, participant_id, payload, created_at, updated_at }] | null
 *                     (참가자 기기는 보고 있는 활동의 것만)
 * 바뀌면 on() 으로 등록한 함수를 부른다: fn(changed:Set<'settings'|'event'|'participants'|'responses'|'status'>)
 *
 * role: 'participant'(기본) | 'admin' | 'board'. 구독할 표와 재조회 방식이 다르다(subscribedTables).
 */
export class Live {
  constructor(eventId, { role = 'participant' } = {}) {
    this.eventId = eventId;
    this.role = role;
    this.data = { event: null, settings: {}, reveal: {}, participants: null, responses: null };
    this.status = 'connecting'; // 'live' | 'poll' | 'connecting'
    this.netFail = false;       // 마지막 불러오기가 연결 오류로 실패했는가
    this.needs = new Set();
    this.scope = null;          // 참가자 기기: 응답을 받을 활동 id
    this.listeners = new Set();
    this.timers = {};
    this.fetchedAt = {};        // 종류 → 마지막으로 불러오기 시작한 시각
    this.lastSettingsAt = 0;
    this.channel = null;
    this.tables = '';           // 지금 채널이 구독하는 표(쉼표로 이음)
    this.client = null;
    this.started = false;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(changed) {
    if (!changed.size) return;
    for (const fn of [...this.listeners]) {
      try { fn(changed); } catch (e) { console.error(e); }
    }
  }

  /** 처음 불러오기. lwb_get_event 결과를 그대로 돌려준다(ok:false 포함) */
  async load() {
    const r = await api.getEvent(this.eventId);
    if (r && r.ok) this.applyEvent(r);
    return r;
  }

  applyEvent(r) {
    const changed = new Set();
    const ev = JSON.stringify(r.event);
    if (ev !== JSON.stringify(this.data.event)) { this.data.event = r.event; changed.add('event'); }
    const st = JSON.stringify([r.settings || {}, r.reveal || {}]);
    if (st !== JSON.stringify([this.data.settings, this.data.reveal])) {
      this.data.settings = r.settings || {};
      this.data.reveal = r.reveal || {};
      changed.add('settings');
    }
    this.lastSettingsAt = Date.now();
    return changed;
  }

  isOpen(key) { return this.data.settings[key] === 'Y'; }

  /**
   * 이 화면에 필요한 데이터 종류. 새로 필요해진 것은 바로 불러온다.
   * activity: 참가자 기기에서 응답을 받을 활동(그 활동 것만 받는다)
   */
  need(kinds, { activity = null } = {}) {
    const next = new Set(kinds);
    const scope = this.role === 'participant' ? activity : null;
    const moved = scope !== this.scope;
    if (moved) {
      this.scope = scope;
      this.data.responses = null; // 다른 활동의 응답만 들고 있을 수 있다
    }
    const same = next.size === this.needs.size && [...next].every((k) => this.needs.has(k));
    const fresh = [...next].filter((k) => !this.needs.has(k) || this.data[k] === null);
    this.needs = next;
    if (fresh.length) this.refresh(fresh);
    if (!same || moved) {
      this.syncChannel();
      this.schedulePeek();
    }
  }

  /** 역할을 바꾼다(참가자 화면에서 관리자로 들어갈 때 등). 구독할 표를 다시 고른다 */
  setRole(role) {
    if (this.role === role) return;
    this.role = role;
    this.scope = null;
    this.data.participants = null;
    this.data.responses = null;
    this.syncChannel();
    this.schedulePeek();
  }

  /** 참가자가 막 냈다: 다른 사람 결과가 필요한 화면이면 한 번 바로 다시 불러오고, 간격을 새로 잡는다 */
  submitted() {
    // 화면이 결과로 바뀌며 need() 를 부른 뒤에 본다. 방금(1초 안) 불러온 것은 건너뛴다
    setTimeout(() => {
      const now = Date.now();
      const kinds = [...this.needs].filter((k) => k !== 'settings' && now - (this.fetchedAt[k] || 0) > 1000);
      if (kinds.length) this.refresh(kinds);
      this.schedulePeek();
    }, 0);
  }

  /** 실시간 연결과 재조회 타이머를 켠다 */
  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    this.schedulePeek();
    this.timers.poll = setInterval(() => this.tick(), CONFIG.pollMs);
    this.onVisible = () => { if (document.visibilityState === 'visible') this.refreshAll(); };
    this.onOnline = () => { this.emit(new Set(['status'])); this.refreshAll(); };
    this.onOffline = () => this.emit(new Set(['status']));
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }

  stop() {
    this.started = false;
    clearInterval(this.timers.poll);
    for (const k of Object.keys(this.timers)) clearTimeout(this.timers[k]);
    this.timers = {};
    if (this.onVisible) document.removeEventListener('visibilitychange', this.onVisible);
    if (this.onOnline) window.removeEventListener('online', this.onOnline);
    if (this.onOffline) window.removeEventListener('offline', this.onOffline);
    this.dropChannel();
  }

  dropChannel() {
    const old = this.channel;
    this.channel = null;
    this.tables = '';
    if (old && this.client) {
      try { this.client.removeChannel(old); } catch { /* 무시 */ }
    }
  }

  /** 역할·필요한 데이터가 바뀌어 구독할 표가 달라졌으면 채널을 다시 단다 */
  syncChannel() {
    if (!this.started) return;
    if (this.channel && subscribedTables(this.role, [...this.needs]).join(',') === this.tables) return;
    this.connect();
  }

  connect() {
    const lib = typeof window !== 'undefined' ? window.supabase : null;
    if (!lib || typeof lib.createClient !== 'function') {
      this.setStatus('poll'); // 실시간 라이브러리를 못 받았으면 재조회로만 간다
      return;
    }
    let again = !!this.channel;
    this.dropChannel();
    try {
      this.client = this.client || lib.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 10 } }
      });
      const filter = `event_id=eq.${this.eventId}`;
      const tables = subscribedTables(this.role, [...this.needs]);
      const ch = this.client.channel(`${NS}-${this.eventId}-${Math.random().toString(36).slice(2, 8)}`);
      for (const table of tables) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table, filter }, (msg) => this.onChange(table, msg));
      }
      this.channel = ch;
      this.tables = tables.join(',');
      ch.subscribe((status) => {
        if (this.channel !== ch) return; // 바꿔 단 옛 채널
        if (status === 'SUBSCRIBED') {
          const was = this.status;
          this.setStatus('live');
          // 붙기 전(또는 채널을 바꿔 다는 사이)에 지나간 변경이 있을 수 있으니 한 번 다시 불러온다
          if (was !== 'live' || again) this.refreshAll();
          again = false;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.setStatus('poll');
        }
      });
    } catch (e) {
      console.error(e);
      this.setStatus('poll');
    }
  }

  onChange(table, msg) {
    const kind = TABLE_KIND[table];
    // 참가자 행 UPDATE는 입장·복원 때 last_seen 만 바뀐 것이다(제출은 참가자 행을 고치지 않는다, 0004). 이름이 그대로면 다시 받지 않는다
    if (kind === 'participants' && msg && msg.eventType === 'UPDATE' && msg.new && this.data.participants) {
      const known = this.data.participants.find((p) => p.id === msg.new.id);
      if (known && known.name === msg.new.name) return;
    }
    if (kind === 'settings' && this.applySetting(msg)) return;
    this.poke(kind);
  }

  /**
   * 참가자 기기: 진행 설정 알림에 실린 값을 다시 불러오지 않고 바로 반영한다(100대가 한꺼번에 부르지 않게).
   * 정답 공개(reveal:)는 공개 내용을 받아야 하고, 지워진 행은 알 수 없으므로 다시 불러온다.
   */
  applySetting(msg) {
    if (this.role !== 'participant') return false;
    const row = msg && msg.new;
    if (!row || row.event_id !== this.eventId || typeof row.key !== 'string') return false;
    if (row.value !== 'Y' && row.value !== 'N') return false;
    if (row.key.startsWith('reveal:')) return false;
    if (this.data.settings[row.key] !== row.value) {
      this.data.settings = { ...this.data.settings, [row.key]: row.value };
      this.emit(new Set(['settings']));
    }
    return true;
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    try { document.body.dataset.live = s; } catch { /* 무시 */ }
    this.emit(new Set(['status']));
  }

  /**
   * 화면에 보일 연결 상태: 'live'(실시간) | 'poll'(재조회) | 'offline'(끊김) | 'connecting'
   * 실시간이 붙어 있으면 실시간이다. 아니면 마지막 불러오기가 연결 오류였을 때 끊김으로 본다.
   */
  get connection() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    if (this.status === 'live') return 'live';
    return this.netFail ? 'offline' : this.status;
  }

  markNet(ok) {
    if (this.netFail === !ok) return;
    this.netFail = !ok;
    this.emit(new Set(['status']));
  }

  tick() {
    // 실시간이 안 되면 매번, 붙어 있어도 가끔은 다시 불러와 빠진 알림을 메운다.
    // 참가자 기기의 다른 사람 결과는 따로(schedulePeek) 다시 불러온다
    if (this.status !== 'live' || Date.now() - this.lastSettingsAt > SAFETY_POLL_MS) {
      this.refresh(this.role === 'participant' ? ['settings'] : ['settings', ...this.needs]);
    }
  }

  refreshAll() {
    this.refresh(['settings', ...this.needs]);
  }

  /**
   * 참가자 기기: 다른 사람 결과가 필요한 화면이면 15~25초마다(무작위) 다시 불러온다.
   * 화면이 가려져 있으면 건너뛴다(다시 보이면 visibilitychange 가 바로 불러온다).
   */
  schedulePeek() {
    clearTimeout(this.timers.peek);
    this.timers.peek = null;
    if (!this.started || this.role !== 'participant') return;
    if (![...this.needs].some((k) => k !== 'settings')) return;
    this.timers.peek = setTimeout(() => {
      const kinds = [...this.needs].filter((k) => k !== 'settings');
      if (kinds.length && !hidden()) this.refresh(kinds);
      this.schedulePeek();
    }, peekDelay());
  }

  /**
   * 실시간 알림: 모았다가 다시 불러온다. 첫 알림부터 잰 창 안에 온 알림은 한 번의 재조회로 묶는다.
   *   응답·참가자(관리자·현황판) BATCH_MS · 진행 설정 250ms(참가자 기기는 0.2~1.5초 사이 무작위)
   */
  poke(kind) {
    if (kind !== 'settings' && !this.needs.has(kind)) {
      this.data[kind] = null; // 지금 안 쓰는 데이터는 버려 두고, 다시 필요할 때 새로 받는다
      return;
    }
    if (this.timers[kind]) return; // 이미 모으는 중
    let ms = BATCH_MS;
    if (kind === 'settings') ms = this.role === 'participant' ? 200 + Math.round(Math.random() * 1300) : 250;
    this.timers[kind] = setTimeout(() => {
      this.timers[kind] = null;
      this.refresh([kind]);
    }, ms);
  }

  /** 다시 불러온다. 같은 종류를 받는 중이면 끝난 뒤에 한 번 더 받는다(겹쳐 부르지 않는다) */
  async refresh(kinds) {
    const changed = new Set();
    await Promise.all([...new Set(kinds)].map((kind) => this.fetchKind(kind, changed)));
    this.emit(changed);
  }

  fetchKind(kind, changed) {
    this.inflight = this.inflight || {};
    this.again = this.again || {};
    if (this.inflight[kind]) {
      this.again[kind] = true;
      return this.inflight[kind];
    }
    const run = async () => {
      do {
        this.again[kind] = false;
        await this.fetchOnce(kind, changed);
      } while (this.again[kind]);
    };
    this.inflight[kind] = run().finally(() => { this.inflight[kind] = null; });
    return this.inflight[kind];
  }

  async fetchOnce(kind, changed) {
    this.fetchedAt[kind] = Date.now();
    try {
      await this.fetchKindRows(kind, changed);
      this.markNet(true);
    } catch (e) {
      // 연결 오류는 다음 재조회 때 다시 해 본다
      if (e instanceof ApiError) this.markNet(false);
      else console.error(e);
    }
  }

  /** 한 종류를 불러와 바뀌었으면 changed 에 적는다(연결 오류는 ApiError 로 던진다) */
  async fetchKindRows(kind, changed) {
    if (kind === 'settings') {
      const r = await api.getEvent(this.eventId);
      if (r && r.ok) for (const c of this.applyEvent(r)) changed.add(c);
    } else if (kind === 'participants') {
      const q = rowsQuery('participants', { eventId: this.eventId, role: this.role });
      const rows = await api.get(q.table, q.query);
      if (Array.isArray(rows) && JSON.stringify(rows) !== JSON.stringify(this.data.participants)) {
        this.data.participants = rows;
        changed.add('participants');
      }
    } else if (kind === 'responses') {
      const scope = this.scope;
      const q = rowsQuery('responses', { eventId: this.eventId, role: this.role, activity: scope });
      const rows = await api.get(q.table, q.query);
      if (scope !== this.scope) return; // 받는 사이에 다른 활동으로 옮겼다
      if (Array.isArray(rows) && JSON.stringify(rows) !== JSON.stringify(this.data.responses)) {
        this.data.responses = rows;
        changed.add('responses');
      }
    }
  }

  /* ─── 계산 도우미 ─── */

  /** 활동 하나의 응답들(최근 제출 순) */
  rowsFor(activityId) {
    const rows = this.data.responses;
    return rows ? rows.filter((r) => r.activity_id === activityId) : null;
  }

  /** 참가자 id → 이름 */
  names() {
    const m = new Map();
    for (const p of this.data.participants || []) m.set(p.id, p.name);
    return m;
  }
}

/** 연결 상태 한 줄 */
export function statusLabel(status) {
  if (status === 'live') return '실시간';
  if (status === 'poll') return `${Math.round(CONFIG.pollMs / 1000)}초마다 새로 고침`;
  if (status === 'offline') return '연결 끊김';
  return '연결 중';
}

/** 주소의 ?e= 값 */
export function eventIdFromUrl() {
  const v = new URLSearchParams(location.search).get('e');
  return v ? v.trim() : '';
}

/** 날짜 'YYYY-MM-DD' → 'YYYY. M. D.' */
export function fmtDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${m[1]}. ${Number(m[2])}. ${Number(m[3])}.` : '';
}

export { CONFIG };
