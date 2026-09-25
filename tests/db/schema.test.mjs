/**
 * 스키마 검사 (spec 4.2, 4.4, 7-B7)
 *   - 적용 전 기준 목록(supabase/baseline-snapshot.json)과 비교해 lwb_ 아닌 객체가 생기거나 사라지지 않았고,
 *     lwb_ 아닌 표·함수·예약 작업(반곡고 lw_)은 정의까지 그대로다(기준 파일이 없으면 이 검사는 건너뛴다)
 *   - 표·서버 함수·실시간 발행·RLS·권한이 계약대로다
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runSql } from './helpers.mjs';
import { takeSnapshot, compareSnapshot } from '../../tools/lib/snapshot.mjs';

const TABLES = ['lwb_events', 'lwb_event_secrets', 'lwb_participants', 'lwb_responses', 'lwb_settings'];
const PUBLIC_RPC = ['lwb_get_event', 'lwb_join', 'lwb_restore', 'lwb_submit', 'lwb_admin_set', 'lwb_admin_reset',
  'lwb_admin_check', 'lwb_ping'];

describe('스키마', () => {
  let snap;

  it('기준 목록 대비 lwb_ 아닌 객체의 추가·삭제가 없고, 반곡고 lw_ 정의가 그대로다', async (t) => {
    snap = await takeSnapshot();
    const file = join(ROOT, 'supabase', 'baseline-snapshot.json');
    if (!existsSync(file)) { t.skip('기준 파일이 없음(npm run snapshot -- --write supabase/baseline-snapshot.json)'); return; }
    const cmp = compareSnapshot(JSON.parse(readFileSync(file, 'utf8')), snap);
    assert.equal(cmp.legacy, false, '기준 파일이 옛 형식');
    assert.deepEqual(cmp.badAdded, []);
    assert.deepEqual(cmp.badRemoved, []);
    assert.deepEqual(cmp.changed, []);
  });

  it('표 다섯 개, 공개 서버 함수, 발행, 예약 작업이 있다', async () => {
    snap = snap || await takeSnapshot();
    const objs = snap.objects;
    for (const t of TABLES) assert.ok(objs.includes(`table:${t}`), t);
    for (const f of PUBLIC_RPC) assert.ok(objs.some((x) => x.startsWith(`function:${f}(`)), f);
    for (const t of ['lwb_participants', 'lwb_responses', 'lwb_settings']) {
      assert.ok(objs.includes(`publication:supabase_realtime:${t}`), `실시간 ${t}`);
    }
    assert.ok(objs.includes('cron:lwb_anonymize'));
  });

  it('RLS 가 켜져 있고, 실시간 표는 replica identity full 이다', async () => {
    const rows = await runSql(`
      select c.relname, c.relrowsecurity, c.relreplident
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 'lwb\\_%' and c.relkind = 'r'`);
    const m = Object.fromEntries(rows.map((r) => [r.relname, r]));
    for (const t of TABLES) assert.equal(m[t].relrowsecurity, true, `${t} RLS`);
    for (const t of ['lwb_participants', 'lwb_responses', 'lwb_settings']) assert.equal(m[t].relreplident, 'f', `${t} replica identity`);
  });

  it('anon 권한: 네 표는 읽기만, 비밀 표는 아무것도, 서버 함수는 공개 목록만 실행', async () => {
    const rows = await runSql(`
      select t.t as tbl,
             has_table_privilege('anon', 'public.' || t.t, 'select') as sel,
             has_table_privilege('anon', 'public.' || t.t, 'insert') as ins,
             has_table_privilege('anon', 'public.' || t.t, 'update') as upd,
             has_table_privilege('anon', 'public.' || t.t, 'delete') as del,
             has_table_privilege('anon', 'public.' || t.t, 'truncate') as trn
        from unnest(array['lwb_events','lwb_event_secrets','lwb_participants','lwb_responses','lwb_settings']) as t(t)`);
    for (const r of rows) {
      assert.equal(r.sel, r.tbl !== 'lwb_event_secrets', `${r.tbl} select`);
      assert.deepEqual([r.ins, r.upd, r.del, r.trn], [false, false, false, false], `${r.tbl} 쓰기 권한`);
    }
    const fns = await runSql(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'lwb\\_%' and has_function_privilege('anon', p.oid, 'execute')
       order by 1`);
    assert.deepEqual(fns.map((r) => r.proname), [...PUBLIC_RPC].sort());
  });

  it('공개 서버 함수는 security definer 이고 search_path 가 고정되어 있다', async () => {
    const rows = await runSql(`
      select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'lwb\\_%'`);
    for (const r of rows) {
      assert.ok((r.proconfig || []).some((c) => c.startsWith('search_path=')), `${r.proname} search_path`);
      if (PUBLIC_RPC.includes(r.proname) && r.proname !== 'lwb_ping') assert.equal(r.prosecdef, true, `${r.proname} security definer`);
    }
  });
});
