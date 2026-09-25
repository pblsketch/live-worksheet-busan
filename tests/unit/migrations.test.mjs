/**
 * 부산 마이그레이션이 lwb_ 아닌 객체를 건드리지 않는가 (명세 0·7)
 *   npm run test:unit
 * supabase/migrations/*.sql 을 모두 읽어 create·alter·drop·grant·revoke·comment on 의 대상 이름을 뽑아 본다.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkMigrationSql, stripComments, baseName } from '../../tools/lib/sql-guard.mjs';

const DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

describe('부산 마이그레이션 파일', () => {
  it('0001~0004 가 lwb_ 이름이다', () => {
    assert.deepEqual(FILES, ['0001_lwb_tables.sql', '0002_lwb_functions.sql', '0003_lwb_realtime_cron.sql', '0004_lwb_submit_no_touch.sql']);
  });

  for (const f of FILES) {
    it(`${f}: lwb_ 아닌 객체를 만들거나 바꾸거나 지우거나 권한을 바꾸지 않는다`, () => {
      assert.deepEqual(checkMigrationSql(readFileSync(join(DIR, f), 'utf8')), []);
    });
  }

  it('예약 작업은 lwb_anonymize, 18:27 UTC (반곡고 18:17 과 겹치지 않게)', () => {
    const sql = stripComments(readFileSync(join(DIR, '0003_lwb_realtime_cron.sql'), 'utf8'));
    assert.match(sql, /cron\.schedule\('lwb_anonymize', '27 18 \* \* \*', 'select public\.lwb_anonymize_expired\(\)'\)/);
  });

  it('확장(pgcrypto·pg_cron)을 만들지 않는다', () => {
    for (const f of FILES) assert.doesNotMatch(stripComments(readFileSync(join(DIR, f), 'utf8')), /create\s+extension/i, f);
  });
});

describe('검사 도구가 잡아야 하는 것', () => {
  const rules = (sql) => checkMigrationSql(sql).map((x) => x.rule);
  const caught = (sql) => assert.ok(checkMigrationSql(sql).length > 0, `못 잡음: ${sql}`);
  const clean = (sql) => assert.deepEqual(checkMigrationSql(sql), [], sql);

  it('부산 객체만 다루는 문장은 통과', () => {
    clean('create table if not exists public.lwb_x (id int constraint lwb_x_pos check (id > 0));');
    clean('create or replace function public.lwb_f(p text) returns int language sql as $$ select 1 $$;');
    clean('create index if not exists lwb_x_idx on public.lwb_x (id);');
    clean('create policy lwb_read_all on public.lwb_x for select to anon using (true);');
    clean('alter table public.lwb_x enable row level security;');
    clean('alter table public.lwb_x replica identity full;');
    clean('revoke all on table public.lwb_x, public.lwb_y from anon, authenticated;');
    clean('revoke all on function public.lwb_f(text, text) from public, anon, authenticated;');
    clean('grant execute on function public.lwb_f(text) to anon, authenticated;');
    clean('revoke all on sequence public.lwb_x_id_seq from anon;');
    clean('alter publication supabase_realtime add table public.lwb_x;');
    clean("select cron.schedule('lwb_job', '1 2 * * *', 'select 1');");
    clean("do $$ begin perform cron.schedule('lwb_job', '1 2 * * *', 'select public.lwb_f()'); end $$;");
    clean("-- 주석 속 lw_x 와 create table public.foo 는 괜찮다\nselect 1;");
    clean("select jsonb_build_object('created', true, 'msg', 'create table x 라는 글');");
  });

  it('반곡고(lw_)·기본 객체를 건드리는 문장은 잡는다', () => {
    caught('create table public.lw_x (id int);');
    caught('create table public.foo (id int);');
    caught('create or replace function public.lw_submit() returns int language sql as $$ select 1 $$;');
    caught('drop function if exists public.lw_join(text, text, text);');
    caught('drop table public.lwb_x, public.lw_y;');
    caught('alter table public.lw_responses replica identity full;');
    caught('alter publication supabase_realtime add table public.lw_x;');
    caught('alter publication supabase_realtime drop table public.lwb_x;');
    caught('alter publication supabase_realtime set table public.lwb_x;');
    caught('create publication lwb_pub for all tables;');
    caught('grant select on table public.lw_events to anon;');
    caught('revoke all on function public.lw_fail(text, text) from anon;');
    caught('grant anon to authenticated;');
    caught('grant usage on schema public to anon;');
    caught('grant select on all tables in schema public to anon;');
    caught('alter default privileges in schema public grant all on tables to anon;');
    caught('comment on table public.lw_events is $$x$$;');
    caught('create extension if not exists pgcrypto with schema extensions;');
    caught('create policy lw_read_all on public.lwb_x for select using (true);');
    caught('create policy lwb_read_all on public.lw_x for select using (true);');
    caught('create index lwb_i on public.lw_x (id);');
    caught('create index foo_idx on public.lwb_x (id);');
    caught('create table public.lwb_x (id int constraint foo_pos check (id > 0));');
    caught("select cron.schedule('lw_anonymize', '17 18 * * *', 'select 1');");
    caught("select cron.unschedule('lwb_anonymize');");
    caught("do $$ begin execute format('create policy p on public.%I', 'lw_x'); end $$;");
    caught('create or replace function public.lwb_f() returns void language sql as $$ update public.lw_participants set name = 1 $$;');
    assert.ok(rules('alter table public.lw_x replica identity full;').length === 2); // lw_ 참조 + alter 대상
  });

  it('이름 뽑기', () => {
    assert.equal(baseName('public.lwb_fail(text, text)'), 'lwb_fail');
    assert.equal(baseName('"public"."LWB_X"'), 'lwb_x');
    assert.equal(baseName('lwb_events'), 'lwb_events');
  });
});
