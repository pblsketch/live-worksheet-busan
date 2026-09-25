/**
 * public 스키마 객체 목록과 정의 해시(스냅숏). 부산 판 규칙(명세 1).
 *
 * 같은 Supabase 프로젝트에 반곡고 판(lw_)이 있다. 부산 마이그레이션 전에 기준 목록을 만들고(읽기만),
 * 마이그레이션 뒤에 비교해 다음을 확인한다.
 *   - lwb_ 아닌 객체가 새로 생기거나 사라지지 않았다
 *   - lwb_ 아닌 표·함수·예약 작업은 **정의까지** 그대로다(반곡고 lw_ 는 한 글자도 바뀌지 않았다)
 *
 * 스냅숏 형식: { version: 2, objects: string[], defs: { "<항목>": "<md5>" } }
 * objects 항목: "<종류>:<이름>" 문자열, 정렬된 배열.
 *   table / partitioned_table / view / matview / sequence / foreign_table / index : pg_class
 *   function:<이름>(<인자 형식>)                                               : pg_proc
 *   type:<이름>  (도메인·열거형·복합형만. 표의 행 형식과 배열 형식은 뺀다)     : pg_type
 *   trigger:<표>.<트리거>                                                      : pg_trigger
 *   policy:<표>.<정책>                                                         : pg_policies
 *   public 밖이지만 이 앱이 만드는 것도 적는다: publication:<발행>:<표>(public 표만) / cron:<작업 이름>
 * defs 항목(lwb_ 아닌 것만):
 *   function:<이름>(<인자>)  md5(pg_get_functiondef + 실행 권한)
 *   table:<이름>             md5(열 목록 | 제약 | 정책 | RLS·replica identity·권한)
 *   cron:<작업 이름>          md5(일정 + 명령 + 켜짐)
 */
import { runSql } from './env.mjs';

export const PREFIX = 'lwb_';
const RELKIND = { r: 'table', p: 'partitioned_table', v: 'view', m: 'matview', S: 'sequence', f: 'foreign_table', i: 'index', I: 'index' };

export const OBJECTS_SQL = `
    select 'rel'::text as k, c.relkind::text as sub, c.relname::text as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p','v','m','S','f','i','I')
    union all
    select 'function', '', p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
    union all
    select 'type', '', t.typname::text
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typtype in ('d','e','c','r','m')
       and (t.typrelid = 0 or (select relkind from pg_class where oid = t.typrelid) = 'c')
       and t.typelem = 0
    union all
    select 'trigger', '', c.relname::text || '.' || tg.tgname::text
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and not tg.tgisinternal
    union all
    select 'policy', '', tablename::text || '.' || policyname::text from pg_policies where schemaname = 'public'
    union all
    select 'publication', '', pubname::text || ':' || tablename::text from pg_publication_tables where schemaname = 'public'`;

/** lwb_ 아닌 표·함수의 정의 해시 */
export const DEFS_SQL = `
    select 'function:' || p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k,
           md5(pg_get_functiondef(p.oid) || ' | ' || coalesce(p.proacl::text, '')) as h
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f', 'p') and p.proname not like 'lwb\\_%'
    union all
    select 'table:' || c.relname::text, md5(
             coalesce((select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                                         || case when a.attnotnull then ' not null' else '' end
                                         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), ''),
                                         ', ' order by a.attnum)
                         from pg_attribute a
                         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '')
             || ' | ' || coalesce((select string_agg(co.conname || ' ' || pg_get_constraintdef(co.oid), ', ' order by co.conname)
                                     from pg_constraint co where co.conrelid = c.oid), '')
             || ' | ' || coalesce((select string_agg(po.policyname || ' ' || po.cmd || ' ' || array_to_string(po.roles, ',')
                                                     || ' ' || coalesce(po.qual, '') || ' ' || coalesce(po.with_check, ''),
                                                     ', ' order by po.policyname)
                                     from pg_policies po where po.schemaname = 'public' and po.tablename = c.relname), '')
             || ' | ' || c.relrowsecurity::text || ' ' || c.relreplident::text || ' ' || coalesce(c.relacl::text, ''))
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname not like 'lwb\\_%'`;

/**
 * 스냅숏을 뜬다(읽기만 한다).
 * @param {(sql: string) => Promise<object[]>} run SQL 한 문장을 실행해 행 배열을 돌려주는 함수(기본: 관리 API)
 */
export async function takeSnapshot(run = runSql) {
  const rows = await run(OBJECTS_SQL);
  const objects = rows.map((r) => (r.k === 'rel' ? `${RELKIND[r.sub] || r.sub}:${r.name}` : `${r.k}:${r.name}`));
  const defs = {};
  for (const r of await run(DEFS_SQL)) defs[r.k] = r.h;
  // pg_cron 이 설치되어 있을 때만 작업 목록을 더한다(없으면 cron 스키마가 없다)
  const hasCron = await run(`select to_regclass('cron.job') is not null as ok`);
  if (hasCron[0]?.ok) {
    const jobs = await run(`select jobname::text as jobname, md5(schedule || ' | ' || command || ' | ' || active::text) as h
                              from cron.job where jobname is not null`);
    for (const j of jobs) {
      objects.push(`cron:${j.jobname}`);
      if (!j.jobname.startsWith(PREFIX)) defs[`cron:${j.jobname}`] = j.h;
    }
  }
  const sortedDefs = Object.fromEntries(Object.keys(defs).sort().map((k) => [k, defs[k]]));
  return { version: 2, objects: [...new Set(objects)].sort(), defs: sortedDefs };
}

/**
 * 항목에서 접두어 검사 대상 이름을 뽑는다.
 *   policy:<표>.<정책> → 표와 정책 모두, publication:<발행>:<표> → 표, trigger:<표>.<트리거> → 둘 다
 */
export function namesOf(item) {
  const i = item.indexOf(':');
  const kind = item.slice(0, i);
  const rest = item.slice(i + 1);
  if (kind === 'function') return [rest.slice(0, rest.indexOf('('))];
  if (kind === 'policy' || kind === 'trigger') return rest.split('.');
  if (kind === 'publication') return [rest.slice(rest.indexOf(':') + 1)];
  return [rest];
}

const ours = (item) => namesOf(item).every((n) => n.startsWith(PREFIX));

/**
 * 기준과 비교한다.
 *   badAdded / badRemoved  lwb_ 아닌 객체의 추가·삭제
 *   changed                기준에 있던 lwb_ 아닌 표·함수·예약 작업 가운데 정의가 바뀌었거나 없어진 것
 *   legacy                 기준 파일이 옛 형식(목록만, 정의 해시 없음)이라 정의를 비교할 수 없음
 */
export function compareSnapshot(baseline, current) {
  const legacy = Array.isArray(baseline) || !baseline || !baseline.defs;
  const baseObjs = Array.isArray(baseline) ? baseline : (baseline && baseline.objects) || [];
  const baseDefs = legacy ? {} : baseline.defs;
  const curObjs = Array.isArray(current) ? current : current.objects;
  const curDefs = (current && current.defs) || {};
  const base = new Set(baseObjs);
  const cur = new Set(curObjs);
  const added = curObjs.filter((x) => !base.has(x));
  const removed = baseObjs.filter((x) => !cur.has(x));
  const badAdded = added.filter((x) => !ours(x));
  const badRemoved = removed.filter((x) => !ours(x));
  const changed = Object.keys(baseDefs).filter((k) => !ours(k) && curDefs[k] !== baseDefs[k]);
  return {
    added, removed, badAdded, badRemoved, changed, legacy,
    ok: !legacy && badAdded.length === 0 && badRemoved.length === 0 && changed.length === 0
  };
}
