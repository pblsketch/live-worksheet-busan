/**
 * 로컬 DB(PGlite) 검증 (명세 7): 원격 없이 마이그레이션과 서버 함수를 돌려 본다
 *   npm run test:pglite
 *
 *   - 반곡고 lw_ 판이 깔린 DB에 부산 lwb_ 마이그레이션을 두 번 돌려도 된다
 *   - 부산 마이그레이션 전후로 lwb_ 아닌 객체의 추가·삭제가 없고, 반곡고 lw_ 표·함수·예약 작업의 정의가 그대로다
 *   - 권한: anon 은 네 표를 읽기만, 비밀 표는 못 읽고, 서버 함수는 공개 목록만 실행
 *   - lwb_submit 의 rewrite 검사, 등록 SQL(tools/lib/register-sql.mjs)로 busan1019 등록
 *   - 반곡고 lw_ 함수는 부산 판과 섞이지 않고 그대로 돈다
 * Supabase 에만 있는 것(anon 역할·기본 권한·pgcrypto 스키마·실시간 발행·pg_cron)은 tests/local/pg.mjs 가 흉내 낸다.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, busanMigrations, runner, asAnon, ROOT } from './pg.mjs';
import { takeSnapshot, compareSnapshot } from '../../tools/lib/snapshot.mjs';
import { registerSql } from '../../tools/lib/register-sql.mjs';

const PUBLIC_RPC = ['lwb_admin_check', 'lwb_admin_reset', 'lwb_admin_set', 'lwb_get_event', 'lwb_join', 'lwb_ping', 'lwb_restore', 'lwb_submit'];
const BUSAN = JSON.parse(readFileSync(join(ROOT, 'events', 'busan1019.json'), 'utf8'));
const PASS = 'Local1234abcd';

describe('PGlite: 반곡고 판 위에 부산 판 마이그레이션', () => {
  let db;
  let base;
  let after1;
  let after2;

  before(async () => {
    db = await createDb({ bangok: true, busan: false });
    base = await takeSnapshot(runner(db));
    for (const m of busanMigrations()) await db.exec(m.sql);
    after1 = await takeSnapshot(runner(db));
    for (const m of busanMigrations()) await db.exec(m.sql); // 두 번째
    after2 = await takeSnapshot(runner(db));
  });

  it('반곡고 lw_ 판이 먼저 깔려 있다(비교할 기준에 lw_ 정의가 있다)', () => {
    const lw = Object.keys(base.defs).filter((k) => /^(table|function|cron):lw_/.test(k));
    assert.ok(lw.length >= 20, `lw_ 정의 ${lw.length}개`);
    assert.ok(base.defs['cron:lw_anonymize']);
    assert.ok(base.defs['table:lw_responses']);
    assert.ok(base.objects.every((x) => !x.includes('lwb_')));
  });

  it('부산 마이그레이션 뒤: 새 객체는 모두 lwb_ 이고, lw_ 표·함수·예약 작업의 정의가 그대로다', () => {
    const c = compareSnapshot(base, after1);
    assert.deepEqual({ badAdded: c.badAdded, badRemoved: c.badRemoved, changed: c.changed, legacy: c.legacy },
      { badAdded: [], badRemoved: [], changed: [], legacy: false });
    assert.equal(c.ok, true);
    assert.deepEqual(c.removed, []);
    assert.ok(c.added.length > 30, `추가 ${c.added.length}개`);
    assert.deepEqual(after1.defs, base.defs); // lwb_ 아닌 정의 해시가 한 글자도 같다
  });

  it('두 번 돌려도 오류 없이 같은 상태다', () => {
    assert.deepEqual(after2, after1);
  });

  it('표 다섯 개, 공개 서버 함수, 실시간 발행, 예약 작업(lwb_anonymize 18:27, 반곡고 18:17 그대로)', async () => {
    for (const t of ['lwb_events', 'lwb_event_secrets', 'lwb_participants', 'lwb_responses', 'lwb_settings']) {
      assert.ok(after1.objects.includes(`table:${t}`), t);
    }
    for (const t of ['lwb_participants', 'lwb_responses', 'lwb_settings', 'lw_participants', 'lw_responses', 'lw_settings']) {
      assert.ok(after1.objects.includes(`publication:supabase_realtime:${t}`), t);
    }
    const jobs = (await db.query(`select jobname, schedule, command from cron.job order by jobname`)).rows;
    assert.deepEqual(jobs, [
      { jobname: 'lw_anonymize', schedule: '17 18 * * *', command: 'select public.lw_anonymize_expired()' },
      { jobname: 'lwb_anonymize', schedule: '27 18 * * *', command: 'select public.lwb_anonymize_expired()' }
    ]);
    const rep = (await db.query(`select relname, relreplident, relrowsecurity from pg_class
                                  where relname like 'lwb\\_%' and relkind = 'r' order by 1`)).rows;
    assert.ok(rep.every((r) => r.relrowsecurity), 'RLS');
    assert.deepEqual(rep.filter((r) => r.relreplident === 'f').map((r) => r.relname), ['lwb_participants', 'lwb_responses', 'lwb_settings']);
  });

  it('anon 권한: 네 표는 읽기만, 비밀 표는 아무것도, 서버 함수는 공개 목록만', async () => {
    const t = (await db.query(`
      select t as tbl, has_table_privilege('anon', 'public.' || t, 'select') as sel,
             has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('anon', 'public.' || t, 'update')
             or has_table_privilege('anon', 'public.' || t, 'delete') or has_table_privilege('anon', 'public.' || t, 'truncate') as write
        from unnest(array['lwb_events','lwb_event_secrets','lwb_participants','lwb_responses','lwb_settings']) as t`)).rows;
    for (const r of t) {
      assert.equal(r.sel, r.tbl !== 'lwb_event_secrets', `${r.tbl} select`);
      assert.equal(r.write, false, `${r.tbl} 쓰기`);
    }
    const fns = (await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'lwb\\_%' and has_function_privilege('anon', p.oid, 'execute')
       order by 1`)).rows.map((r) => r.proname);
    assert.deepEqual(fns, PUBLIC_RPC);
    await assert.rejects(asAnon(db, `select * from public.lwb_event_secrets`), /permission denied/);
    await assert.rejects(asAnon(db, `select public.lwb_validate_rewrite('{}'::jsonb, '{}'::jsonb)`), /permission denied/);
  });

  describe('서버 함수 (anon 으로 부른다)', () => {
    let pid;
    const rpc = async (fn, args) => {
      const names = Object.keys(args);
      const sql = `select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}${k === 'p_payload' ? '::jsonb' : '::text'}`).join(', ')}) as r`;
      const rows = await asAnon(db, sql, names.map((k) => (k === 'p_payload' ? JSON.stringify(args[k]) : args[k])));
      return rows[0].r;
    };
    const submit = (activity, payload) => rpc('lwb_submit', { p_event_id: 'busan1019', p_participant_id: pid, p_activity_id: activity, p_payload: payload });

    before(async () => {
      const secret = JSON.parse(JSON.stringify({ reveal: { ox: { answers: ['O', 'X', 'O'] } } }));
      const r = (await db.query(registerSql('busan1019', BUSAN, secret, PASS))).rows[0];
      assert.equal(r.secrets, 1);
      assert.deepEqual(r.inserted, ['materials_open', 'open:grow', 'open:ox', 'open:pledge', 'open:rewrite1', 'open:rewrite2', 'reveal:ox']);
      for (const k of ['open:rewrite1', 'open:rewrite2']) {
        assert.deepEqual(await rpc('lwb_admin_set', { p_event_id: 'busan1019', p_key: k, p_value: 'Y', p_passcode: PASS }),
          { ok: true, key: k, value: 'Y' });
      }
      const j = await rpc('lwb_join', { p_event_id: 'busan1019', p_name: '로컬 참가자', p_mode: 'new' });
      assert.equal(j.ok, true);
      pid = j.participant.id;
    });

    it('등록한 연수를 불러온다(정답은 공개 전이라 없다)', async () => {
      const g = await rpc('lwb_get_event', { p_event_id: 'busan1019' });
      assert.equal(g.ok, true);
      assert.deepEqual(g.event.activities.map((a) => a.id), ['grow', 'ox', 'rewrite1', 'rewrite2', 'pledge']);
      assert.deepEqual(g.reveal, {});
      assert.equal(g.settings['open:rewrite1'], 'Y');
      assert.equal((await rpc('lwb_admin_check', { p_event_id: 'busan1019', p_passcode: PASS })).ok, true);
      assert.equal((await rpc('lwb_admin_check', { p_event_id: 'busan1019', p_passcode: PASS.toLowerCase() })).ok, false);
    });

    it('rewrite: 정리해서 저장(앞뒤 공백, 줄 바꿈·연속 공백 → 공백 하나, 모르는 칸 버림)', async () => {
      assert.deepEqual(await submit('rewrite1', { prompt: 'a', text: '  학생이\n\n예상 독자의   질문을 미리 적고 답함.  ', x: 1 }), { ok: true });
      const rows = await asAnon(db, `select payload from public.lwb_responses where activity_id = 'rewrite1' and participant_id = $1`, [pid]);
      assert.deepEqual(rows[0].payload, { prompt: 'a', text: '학생이 예상 독자의 질문을 미리 적고 답함.' });
    });

    it('rewrite: 5자 미만·200자 초과(코드 포인트)·모르는 문장·글이 아닌 값은 거부', async () => {
      const bad = async (payload, msg) => assert.deepEqual(await submit('rewrite1', payload), { ok: false, code: 'invalid', msg }, JSON.stringify(payload));
      await bad({ prompt: 'a', text: '네글자다' }, '5자 이상 적어 주세요.');
      await bad({ prompt: 'a', text: ' \n\t ' }, '5자 이상 적어 주세요.');
      await bad({ prompt: 'a', text: '가'.repeat(201) }, '200자 이내로 적어 주세요.');
      await bad({ prompt: 'z', text: '충분히 긴 문장입니다' }, '고쳐 쓸 문장을 골라 주세요.');
      await bad({ text: '충분히 긴 문장입니다' }, '고쳐 쓸 문장을 골라 주세요.');
      await bad({ prompt: 'a', text: 12345 }, '고쳐 쓴 문장을 적어 주세요.');
      assert.deepEqual(await submit('rewrite1', { prompt: 'b', text: '가'.repeat(200) }), { ok: true });
      assert.deepEqual(await submit('rewrite1', { prompt: 'b', text: '😀'.repeat(200) }), { ok: true }); // 이모지 하나 = 한 글자
    });

    it('rewrite: 다시 내면 덮어쓴다((연수, 활동, 참가자)마다 1건), 2차도 같은 규칙', async () => {
      assert.deepEqual(await submit('rewrite1', { prompt: 'a', text: '고쳐서 다시 낸 1차 문장' }), { ok: true });
      assert.deepEqual(await submit('rewrite2', { prompt: 'a', text: '고쳐서 낸 2차 문장입니다' }), { ok: true });
      const rows = await asAnon(db, `select activity_id, payload from public.lwb_responses where participant_id = $1 order by activity_id`, [pid]);
      assert.deepEqual(rows, [
        { activity_id: 'rewrite1', payload: { prompt: 'a', text: '고쳐서 다시 낸 1차 문장' } },
        { activity_id: 'rewrite2', payload: { prompt: 'a', text: '고쳐서 낸 2차 문장입니다' } }
      ]);
      const r = await rpc('lwb_restore', { p_event_id: 'busan1019', p_participant_id: pid });
      assert.deepEqual(Object.keys(r.responses).sort(), ['rewrite1', 'rewrite2']);
    });

    it('닫힌 활동·다른 종류의 규칙', async () => {
      assert.equal((await submit('grow', { template: 'grow', blank: '스스로 질문하는' })).code, 'closed');
      await rpc('lwb_admin_set', { p_event_id: 'busan1019', p_key: 'open:grow', p_value: 'Y', p_passcode: PASS });
      assert.deepEqual(await submit('grow', { template: 'grow', blank: '스스로 질문하는' }), { ok: true });
      await rpc('lwb_admin_set', { p_event_id: 'busan1019', p_key: 'open:ox', p_value: 'Y', p_passcode: PASS });
      assert.deepEqual(await submit('ox', { answers: ['O', 'X', 'O'] }), { ok: true });
      assert.equal((await submit('ox', { answers: ['O', 'X'] })).code, 'invalid');
    });

    it('정답 공개를 켜면 ox 정답이 내려온다', async () => {
      await rpc('lwb_admin_set', { p_event_id: 'busan1019', p_key: 'reveal:ox', p_value: 'Y', p_passcode: PASS });
      const g = await rpc('lwb_get_event', { p_event_id: 'busan1019' });
      assert.deepEqual(g.reveal.ox.answers, ['O', 'X', 'O']);
    });

    it('반곡고 lw_ 함수는 부산 연수를 모르고, 제 종류 목록(rewrite 없음) 그대로 돈다', async () => {
      assert.equal((await rpc('lw_get_event', { p_event_id: 'busan1019' })).code, 'no_event');
      assert.equal((await rpc('lw_ping', {})).ok, true);
      const v = (await db.query(`select public.lw_validate_payload('{"type":"rewrite"}'::jsonb, '{"prompt":"a","text":"충분히 긴 문장"}'::jsonb) as r`)).rows[0].r;
      assert.deepEqual(v, { ok: false, msg: '지원하지 않는 활동 종류입니다.' });
      const n = (await db.query(`select (select count(*) from public.lw_events)::int as ev, (select count(*) from public.lw_responses)::int as rs`)).rows[0];
      assert.deepEqual(n, { ev: 0, rs: 0 });
    });

    it('응답 모두 비우기는 그 연수의 부산 기록만 지운다', async () => {
      const r = await rpc('lwb_admin_reset', { p_event_id: 'busan1019', p_passcode: PASS });
      assert.equal(r.ok, true);
      assert.equal(r.participants, 1);
      assert.equal(r.responses, 4);
    });
  });
});

describe('PGlite: 반곡고 판 없이 빈 DB에도 부산 판만 깔린다', () => {
  it('빈 Supabase 흉내 DB에 두 번', async () => {
    const db = await createDb({ bangok: false, busan: true });
    for (const m of busanMigrations()) await db.exec(m.sql);
    const s = await takeSnapshot(runner(db));
    assert.ok(s.objects.includes('table:lwb_events'));
    assert.deepEqual(Object.keys(s.defs).filter((k) => k.startsWith('table:') || k.startsWith('cron:')), []);
  });
});

describe('PGlite: 점검(snapshot)이 반곡고 lw_ 변경을 잡는다', () => {
  it('lw_ 함수 본문·표 열·예약 작업이 바뀌거나 lwb_ 아닌 객체가 생기면 실패', async () => {
    const db = await createDb({ bangok: true, busan: false });
    const base = await takeSnapshot(runner(db));
    await db.exec(`
      create or replace function public.lw_ping() returns jsonb language sql stable set search_path = public, pg_temp as $$
        select jsonb_build_object('ok', true, 'at', now(), 'x', 1);
      $$;
      alter table public.lw_settings add column note text;
      select cron.schedule('lw_anonymize', '0 0 * * *', 'select public.lw_anonymize_expired()');
      create table public.stray (id int);`);
    const c = compareSnapshot(base, await takeSnapshot(runner(db)));
    assert.equal(c.ok, false);
    assert.deepEqual(c.changed.sort(), ['cron:lw_anonymize', 'function:lw_ping()', 'table:lw_settings']);
    assert.deepEqual(c.badAdded, ['table:stray']);
  });
});
