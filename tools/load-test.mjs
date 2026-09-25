#!/usr/bin/env node
/**
 * 부하 시험 (명세 6) — 실제 DB에 요청을 보낸다.
 * --confirm-remote 가 없으면 아무 요청도 보내지 않고(.env.local 도 읽지 않고) 사용법만 출력한다.
 *
 *   node tools/load-test.mjs --confirm-remote [--n 100] [--spread 2000] [--only rewrite1,pledge]
 *
 * 하는 일
 *   1. 시험 연수 t-load-<시각>을 만든다: events/busan1019.json 과 같은 활동, 목록 노출 안 함, 암호는 새로 만듦.
 *      관리 토큰(SUPABASE_ACCESS_TOKEN)은 이 만들기(등록 명령)와 마지막 지우기에만 쓴다.
 *   2. 참가자 N명(기본 100)을 흉내 낸다: lwb_join → 실제 참가자 기기와 같이 진행 설정만 실시간 구독.
 *      현황판 1대·관리자 1대는 진행 설정·참가자·응답을 구독하고, 알림이 오면 600ms 묶어 응답을 다시 불러온다.
 *   3. 활동마다: 관리자가 연다 → 참가자는 열림 알림을 받고 0~spread ms 사이에 흩어져 낸다
 *      → 현황판 재조회에 모든 제출이 보일 때까지 잰다 → 닫는다.
 *      (열림 알림을 10초 안에 못 받은 참가자는 그 수를 세고, 재조회로 알았다 치고 그때 낸다)
 *   4. 잰 것: 제출 성공률·지연(중앙값·p95)·실패 코드, 열림 알림 도착 지연, 현황판·관리자·참가자 기기가 받은 알림 수,
 *      모든 제출이 현황판 재조회에 보이기까지 걸린 시간.
 *   5. 끝나면(실패해도 finally) 연결을 닫고 시험 연수를 지운다.
 *
 * 접속 정보: .env.local 의 SUPABASE_URL · SUPABASE_PUBLISHABLE_KEY(참가자·현황판 흉내),
 *            SUPABASE_PROJECT_REF · SUPABASE_ACCESS_TOKEN(시험 연수 만들기·지우기). 토큰은 출력하지 않는다.
 * 종료 코드: 0 끝까지 돎(성공률은 출력으로 본다) · 1 준비·진행 실패 · 2 사용법
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `부하 시험: 실제 DB에 시험 연수(t-load-…)를 만들어 참가자 여럿을 흉내 내고, 끝나면 지웁니다.
사용법: node tools/load-test.mjs --confirm-remote [--n 100] [--spread 2000] [--only <활동 id,…>]
  --confirm-remote  실제 DB(Supabase)에 요청을 보내도 된다는 확인. 없으면 아무것도 하지 않습니다.
  --n <수>          흉내 낼 참가자 수(기본 100, 1~200)
  --spread <ms>     열림 알림을 받은 뒤 제출을 흩어 놓을 시간(기본 2000)
  --only <id,…>     이 활동만 돌린다(기본: busan1019 의 모든 활동 순서대로)`;

/* ───────────── 인자 ───────────── */

function parseArgs(argv) {
  const o = { confirm: false, n: 100, spread: 2000, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (argv[i + 1] === undefined) throw new Error(`${a} 뒤에 값이 필요합니다.`); return argv[++i]; };
    if (a === '--confirm-remote') o.confirm = true;
    else if (a === '--n') o.n = Number(val());
    else if (a === '--spread') o.spread = Number(val());
    else if (a === '--only') o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > 200) throw new Error('--n 은 1~200 사이의 정수여야 합니다.');
  if (!Number.isFinite(o.spread) || o.spread < 0 || o.spread > 60000) throw new Error('--spread 는 0~60000(ms)이어야 합니다.');
  return o;
}

/* ───────────── 계산 도우미 (원격 없이 쓸 수 있다) ───────────── */

/** 정렬한 뒤 p 분위(0~1) 값. 없으면 null */
export function quantile(values, p) {
  const xs = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return xs[i];
}

/** 활동 종류에 맞는 흉내 payload (i 번째 참가자) */
export function fakePayload(activity, i, rand = Math.random) {
  if (activity.type === 'ox') return { answers: activity.questions.map(() => (rand() < 0.5 ? 'O' : 'X')) };
  if (activity.type === 'sentence') {
    const t = activity.templates[Math.floor(rand() * activity.templates.length)];
    return { template: t.id, blank: `부하 시험 ${i + 1}` };
  }
  if (activity.type === 'rewrite') {
    const p = activity.prompts[Math.floor(rand() * activity.prompts.length)];
    return { prompt: p.id, text: `부하 시험 ${i + 1}: 학생이 예상 독자가 물을 질문을 두 가지 적고 건의문에서 답함.` };
  }
  return null;
}

const ms = (x) => (x == null ? '-' : `${Math.round(x)}ms`);
const sleep = (t) => new Promise((r) => setTimeout(r, t));

/* ───────────── 본 시험 ───────────── */

async function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 2;
  }
  if (opt.help || !opt.confirm) {
    console.log(USAGE);
    if (!opt.help) console.log('\n--confirm-remote 가 없어 아무 요청도 보내지 않았습니다.');
    return 0;
  }

  // 여기부터 원격. 필요한 모듈은 확인 뒤에 불러온다
  const { ROOT, runSql, rpc, restGet, loadEnv, lit } = await import('./lib/env.mjs');
  const { generatePasscode } = await import('./lib/event-config.mjs');
  const { subscribedTables, BATCH_MS, NS } = await import('../assets/core.js');
  const { createClient } = await import('@supabase/supabase-js');

  const env = loadEnv();
  for (const k of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_PROJECT_REF', 'SUPABASE_ACCESS_TOKEN']) {
    if (!env[k]) { console.error(`.env.local 에 ${k} 가 없습니다.`); return 1; }
  }

  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  const id = `t-load-${stamp}`;
  if (!/^t-load-[0-9]{12}$/.test(id)) throw new Error('시험 연수 id 를 만들지 못했습니다.');
  const base = JSON.parse(readFileSync(join(ROOT, 'events', 'busan1019.json'), 'utf8'));
  const acts = base.activities.filter((a) => !opt.only || opt.only.includes(a.id));
  if (!acts.length) { console.error('돌릴 활동이 없습니다(--only 확인).'); return 2; }
  const passcode = generatePasscode(12);
  const dir = mkdtempSync(join(tmpdir(), 'lwb-load-'));
  const clients = [];
  let created = false;
  const fn = (name) => `${NS}_${name}`;
  const call = async (name, args) => {
    const r = await rpc(fn(name), args);
    if (r.status !== 200) throw new Error(`${fn(name)} HTTP ${r.status}`);
    return r.body;
  };

  console.log(`시험 연수 ${id} · 참가자 ${opt.n}명 · 흩어 내기 ${opt.spread}ms · 활동 ${acts.map((a) => a.id).join(', ')}`);
  try {
    /* 1. 시험 연수 만들기(등록 명령 그대로) */
    const today = new Date().toISOString().slice(0, 10);
    const pub = { ...base, id, title: '부하 시험 (자동으로 지워짐)', date: today, listed: false, activities: base.activities };
    const reveal = {};
    for (const a of base.activities) if (a.type === 'ox') reveal[a.id] = { answers: a.questions.map(() => 'O') };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(pub));
    writeFileSync(join(dir, `${id}.secret.json`), JSON.stringify({ admin_passcode: passcode, reveal }));
    created = true; // 등록 중간에 실패해도 지우러 간다
    const reg = spawnSync(process.execPath, [join(ROOT, 'tools', 'register-event.mjs'), id, '--dir', dir], { encoding: 'utf8', cwd: ROOT });
    if (reg.status !== 0) throw new Error(`시험 연수 등록 실패(종료 코드 ${reg.status}): ${(reg.stderr || '').slice(0, 400)}`);
    const setKey = async (key, value) => {
      const r = await call('admin_set', { p_event_id: id, p_key: key, p_value: value, p_passcode: passcode });
      if (!r || r.ok !== true) throw new Error(`${key}=${value} 실패: ${JSON.stringify(r)}`);
    };

    const newClient = () => {
      const c = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 10 } }
      });
      clients.push(c);
      return c;
    };
    const subscribe = (client, tables, onMsg) => new Promise((resolve) => {
      const ch = client.channel(`${NS}-${id}-${Math.random().toString(36).slice(2, 8)}`);
      for (const table of tables) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `event_id=eq.${id}` }, (m) => onMsg(table, m));
      }
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      ch.subscribe((st) => {
        if (st === 'SUBSCRIBED') finish(true);
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') finish(false);
      });
      setTimeout(() => finish(false), 30000);
    });

    /* 2. 현황판·관리자: 진행 설정·참가자·응답 구독, 알림을 묶어 응답 다시 불러오기 */
    const watchers = ['board', 'admin'].map((role) => ({ role, msgs: 0, fetches: 0, rows: [], timer: null, fetchedAt: 0 }));
    const fetchRows = async (w) => {
      w.fetches++;
      const r = await restGet(`${fn('responses')}?select=activity_id,participant_id,updated_at&event_id=eq.${id}`);
      if (r.status === 200 && Array.isArray(r.body)) { w.rows = r.body; w.fetchedAt = Date.now(); }
    };
    for (const w of watchers) {
      const ok = await subscribe(newClient(), subscribedTables(w.role, ['participants', 'responses']), (table) => {
        w.msgs++;
        if (table === fn('settings') || w.timer) return;
        w.timer = setTimeout(() => { w.timer = null; fetchRows(w).catch(() => {}); }, BATCH_MS);
      });
      if (!ok) throw new Error(`${w.role} 실시간 구독 실패`);
    }

    /* 3. 참가자 입장·구독(진행 설정만) */
    const people = [];
    const tJoin = Date.now();
    await Promise.all(Array.from({ length: opt.n }, async (_, i) => {
      await sleep(Math.random() * 3000); // 입장도 조금 흩어 둔다
      const j = await call('join', { p_event_id: id, p_name: `부하-${String(i + 1).padStart(3, '0')}`, p_mode: 'new' });
      if (!j || !j.ok) throw new Error(`입장 실패: ${JSON.stringify(j)}`);
      const p = { i, pid: j.participant.id, msgs: 0, onOpen: null };
      p.subscribed = await subscribe(newClient(), subscribedTables('participant'), (table, m) => {
        p.msgs++;
        const row = m && m.new;
        if (row && row.value === 'Y' && typeof row.key === 'string' && row.key.startsWith('open:') && p.onOpen) p.onOpen(row.key.slice(5));
      });
      people.push(p);
    }));
    const subs = people.filter((p) => p.subscribed).length;
    console.log(`입장 ${people.length}명(${ms(Date.now() - tJoin)}), 실시간 구독 ${subs}명`);

    /* 4. 활동마다 열기 → 흩어져 제출 → 현황판에 다 보일 때까지 */
    const results = [];
    for (const a of acts) {
      for (const w of watchers) w.msgs = 0;
      for (const p of people) p.msgs = 0;
      const lat = [];
      const arrive = [];
      const codes = {};
      let ok = 0;
      let missed = 0;
      let lastOk = 0;
      const submitOne = async (p) => {
        const payload = fakePayload(a, p.i);
        const t = Date.now();
        try {
          const r = await call('submit', { p_event_id: id, p_participant_id: p.pid, p_activity_id: a.id, p_payload: payload });
          lat.push(Date.now() - t);
          if (r && r.ok) { ok++; lastOk = Date.now(); } else codes[(r && r.code) || '?'] = (codes[(r && r.code) || '?'] || 0) + 1;
        } catch (e) {
          lat.push(Date.now() - t);
          codes.network = (codes.network || 0) + 1;
        }
      };
      const t0 = Date.now();
      const all = Promise.all(people.map((p) => new Promise((resolve) => {
        let started = false;
        const go = () => {
          if (started) return;
          started = true;
          setTimeout(() => submitOne(p).then(resolve), Math.random() * opt.spread);
        };
        p.onOpen = (actId) => { if (actId === a.id) { arrive.push(Date.now() - t0); go(); } };
        setTimeout(() => { if (!started) { missed++; go(); } }, 10000);
      })));
      await setKey(`open:${a.id}`, 'Y');
      await all;
      for (const p of people) p.onOpen = null;
      // 현황판 재조회에 모든 성공 제출이 보일 때까지(최대 30초)
      const board = watchers[0];
      let seenAt = null;
      for (const until = Date.now() + 30000; Date.now() < until;) {
        const n = board.rows.filter((r) => r.activity_id === a.id).length;
        if (n >= ok) { seenAt = board.fetchedAt; break; }
        await sleep(200);
      }
      await setKey(`open:${a.id}`, 'N');
      await sleep(1500); // 닫힘 알림까지 받고 센다
      results.push({
        id: a.id, n: people.length, ok, codes, lat, arrive, missed,
        seen: seenAt ? seenAt - t0 : null, seenAfterLast: seenAt && lastOk ? seenAt - lastOk : null,
        boardMsgs: watchers[0].msgs, adminMsgs: watchers[1].msgs, boardFetches: watchers[0].fetches,
        peopleMsgs: people.reduce((s, p) => s + p.msgs, 0)
      });
      watchers[0].fetches = 0;
      const r = results[results.length - 1];
      console.log(`\n■ ${a.id} (${a.type})`);
      console.log(`  제출 성공 ${r.ok}/${r.n} (${((r.ok / r.n) * 100).toFixed(1)}%)` +
        `${Object.keys(r.codes).length ? ` · 실패 ${JSON.stringify(r.codes)}` : ''}`);
      console.log(`  제출 지연 중앙값 ${ms(quantile(r.lat, 0.5))} · p95 ${ms(quantile(r.lat, 0.95))} · 최대 ${ms(quantile(r.lat, 1))}`);
      console.log(`  열림 알림 도착 중앙값 ${ms(quantile(r.arrive, 0.5))} · p95 ${ms(quantile(r.arrive, 0.95))} · 10초 안에 못 받음 ${r.missed}명`);
      console.log(`  현황판에 모두 보임: 열고 나서 ${ms(r.seen)} (마지막 제출 뒤 ${ms(r.seenAfterLast)})`);
      console.log(`  받은 알림: 현황판 ${r.boardMsgs} · 관리자 ${r.adminMsgs} · 참가자 기기 합계 ${r.peopleMsgs}` +
        ` (현황판 응답 재조회 ${r.boardFetches}번)`);
      await sleep(1000);
    }

    const tot = results.reduce((s, r) => ({ n: s.n + r.n, ok: s.ok + r.ok, lat: s.lat.concat(r.lat) }), { n: 0, ok: 0, lat: [] });
    console.log(`\n합계: 제출 성공 ${tot.ok}/${tot.n} (${((tot.ok / tot.n) * 100).toFixed(1)}%)` +
      ` · 지연 중앙값 ${ms(quantile(tot.lat, 0.5))} · p95 ${ms(quantile(tot.lat, 0.95))}`);
    return 0;
  } finally {
    for (const c of clients) {
      try { await c.removeAllChannels(); } catch { /* 무시 */ }
    }
    if (created) {
      try {
        await runSql(`delete from public.${fn('events')} where id = ${lit(id)}`);
        console.log(`\n시험 연수 ${id} 를 지웠습니다.`);
      } catch (e) {
        console.error(`시험 연수 ${id} 를 지우지 못했습니다: ${e.message}`);
        console.error(`직접 지우기: delete from public.${fn('events')} where id = '${id}';`);
      }
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
}

// 명령으로 돌렸을 때만 시작한다(단위 검사는 계산 도우미만 불러 쓴다)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.message || e, e && e.cause ? `(${e.cause.code || e.cause.message})` : ''); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200).unref());
}
