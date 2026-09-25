/**
 * 로컬 DB(PGlite, 메모리)로 마이그레이션과 서버 함수를 돌린다. 원격(Supabase)에는 닿지 않는다.
 *
 * Supabase 에만 있는 것은 준비 SQL(PREP_SQL)로 흉내 낸다:
 *   anon·authenticated 역할과 Supabase 기본 권한(public 스키마 사용, 새 표·함수·시퀀스에 모든 권한),
 *   extensions 스키마의 pgcrypto, supabase_realtime 발행, pg_cron(cron.job 표와 cron.schedule 함수).
 * 반곡고 판(lw_)도 같은 DB에 먼저 깔 수 있다. 반곡고 마이그레이션은 이 저장소의 git 기록(BANGOK_COMMIT)에서 읽는다
 * (원래 폴더 live-worksheet 는 열지 않는다).
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 반곡고 판 마지막 커밋(부산 판이 갈라져 나온 곳) */
export const BANGOK_COMMIT = 'b3627c3';

export const PREP_SQL = `
-- Supabase 역할과 기본 권한
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- extensions 스키마의 pgcrypto
create schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension pgcrypto with schema extensions;

-- 실시간 발행(표 없이 시작)
create publication supabase_realtime;

-- pg_cron 흉내: 작업 목록과 schedule(같은 이름이면 고쳐 쓴다, pg_cron 1.3+)
create schema cron;
create table cron.job (
  jobid bigserial primary key, schedule text not null, command text not null,
  nodename text not null default 'localhost', nodeport int not null default 5432,
  database text not null default current_database(), username text not null default current_user,
  active boolean not null default true, jobname text
);
create unique index job_name_user on cron.job (jobname, username);
create function cron.schedule(job_name text, schedule text, command text) returns bigint
language plpgsql as $$
#variable_conflict use_column
declare v bigint;
begin
  update cron.job set schedule = $2, command = $3 where jobname = $1 and username = current_user returning jobid into v;
  if v is null then
    insert into cron.job (jobname, schedule, command) values ($1, $2, $3) returning jobid into v;
  end if;
  return v;
end $$;
`;

/** 부산 마이그레이션 [{ name, sql }] */
export function busanMigrations() {
  const dir = join(ROOT, 'supabase', 'migrations');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * 반곡고 마이그레이션 [{ name, sql }] (git 기록에서).
 * Supabase 에서는 pg_cron 이 이미 있어 'create extension if not exists pg_cron' 이 아무 일도 하지 않는다.
 * PGlite 에는 pg_cron 이 없으므로 그 한 줄만 빼고 준비 SQL의 cron 흉내를 쓴다.
 */
export function bangokMigrations() {
  const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  return git('ls-tree', '--name-only', `${BANGOK_COMMIT}:supabase/migrations`).split('\n').map((s) => s.trim())
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({
      name: f,
      sql: git('show', `${BANGOK_COMMIT}:supabase/migrations/${f}`)
        .replace(/create extension if not exists pg_cron with schema pg_catalog;/i, '-- (로컬: pg_cron 은 cron 흉내로 대신)')
    }));
}

/**
 * 실시간 흉내용: 발행된 lwb_ 표의 행 변경을 pg_notify('mock_rt') 로 알린다(흉내 서버만 쓴다. 마이그레이션에는 없다).
 * 알림 크기 한도(8000바이트)를 넘으면 payload 칸을 빼고 보낸다.
 */
export const REALTIME_SQL = `
create schema if not exists mock;
create or replace function mock.rt_notify() returns trigger language plpgsql as $$
declare
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_msg text;
begin
  v_msg := jsonb_build_object('table', tg_table_name, 'type', tg_op, 'new', v_new, 'old', v_old, 'at', now())::text;
  if octet_length(v_msg) > 7800 then
    v_msg := jsonb_build_object('table', tg_table_name, 'type', tg_op, 'new', v_new - 'payload', 'old', v_old - 'payload', 'at', now())::text;
  end if;
  perform pg_notify('mock_rt', v_msg);
  return null;
end $$;
do $$
declare t text;
begin
  for t in select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' loop
    execute format('drop trigger if exists mock_rt on public.%I', t);
    execute format('create trigger mock_rt after insert or update or delete on public.%I for each row execute function mock.rt_notify()', t);
  end loop;
end $$;
`;

/**
 * 새 로컬 DB.
 * @param {{ bangok?: boolean, busan?: boolean, realtime?: boolean }} opt
 *   bangok  반곡고 lw_ 마이그레이션을 먼저 깐다(기본 true)
 *   busan   부산 lwb_ 마이그레이션을 얹는다(기본 true)
 *   realtime 실시간 흉내 트리거를 단다(기본 false)
 */
export async function createDb({ bangok = true, busan = true, realtime = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(PREP_SQL);
  if (bangok) for (const m of bangokMigrations()) await db.exec(m.sql);
  if (busan) for (const m of busanMigrations()) await db.exec(m.sql);
  if (realtime) await db.exec(REALTIME_SQL);
  return db;
}

/** SQL 한 문장을 돌려 행 배열을 돌려준다(스냅숏 등에 넘기는 실행 함수) */
export const runner = (db) => async (sql) => (await db.query(sql)).rows;

/** anon 역할로(브라우저 publishable key 와 같은 권한) 한 문장을 돌린다 */
export async function asAnon(db, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, params)).rows;
  });
}
