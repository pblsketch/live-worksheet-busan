/**
 * 연수 등록 SQL(tools/register-event.mjs 가 관리 API로 실행한다. 로컬 검사도 같은 SQL을 쓴다)
 *   - lwb_events · lwb_event_secrets 를 넣거나 갱신한다(관리자 암호는 DB에서 pgcrypto로 해시)
 *   - 빠진 진행 설정만 N으로 만든다. 이미 있는 값은 덮어쓰지 않는다
 * 결과 한 행: { secrets: 1, inserted: [새로 만든 키], stale: [설정에 없는 활동의 키] }
 */
import { lit, jsonLit } from './env.mjs';
import { publicConfig, settingKeys } from './event-config.mjs';

export function registerSql(id, pub, secret, passcode) {
  const keys = settingKeys(pub);
  const arr = `array[${keys.map(lit).join(', ')}]::text[]`;
  return `
with ev as (
  insert into public.lwb_events (id, title, date, listed, config)
  values (${lit(id)}, ${lit(pub.title.trim())}, ${lit(pub.date)}::date, ${pub.listed === true}, ${jsonLit(publicConfig(pub))})
  on conflict (id) do update
    set title = excluded.title, date = excluded.date, listed = excluded.listed,
        config = excluded.config, updated_at = now()
  returning id
), sec as (
  insert into public.lwb_event_secrets (event_id, admin_hash, reveal)
  select ev.id, extensions.crypt(${lit(passcode)}, extensions.gen_salt('bf', 8)), ${jsonLit((secret && secret.reveal) ?? {})}
    from ev
  on conflict (event_id) do update
    set admin_hash = excluded.admin_hash, reveal = excluded.reveal, updated_at = now()
  returning event_id
), ins as (
  insert into public.lwb_settings (event_id, key, value)
  select ev.id, k, 'N' from ev, unnest(${arr}) as k
  on conflict (event_id, key) do nothing
  returning key
)
select (select count(*) from sec)::int as secrets,
       coalesce((select json_agg(key order by key) from ins), '[]'::json) as inserted,
       coalesce((select json_agg(key order by key) from public.lwb_settings
                  where event_id = ${lit(id)} and key <> all (${arr})), '[]'::json) as stale;
`;
}
