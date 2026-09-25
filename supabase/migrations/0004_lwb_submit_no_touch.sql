-- 0004 (부산 판): 제출할 때 참가자 행(last_seen)을 고치지 않는다. 반곡고 0004 를 lwb_ 로 옮긴 것이다.
-- 제출 1건이 실시간 변경 2건(응답 + 참가자)이 되어 모든 구독자에게 두 번 방송되던 것을 1건으로 줄인다.
-- 40명이 한꺼번에 낼 때 무료 플랜의 초당 실시간 메시지 한도에 덜 걸리게 하려는 것이다.
-- last_seen은 입장·복원 때만 고친다(화면은 제출 뒤 last_seen을 쓰지 않는다). 나머지 동작은 0002와 같다.

create or replace function public.lwb_submit(p_event_id text, p_participant_id text,
                                            p_activity_id text, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_ev  public.lwb_events%rowtype;
  v_pid uuid := public.lwb_to_uuid(p_participant_id);
  v_act jsonb;
  v_res jsonb;
begin
  select * into v_ev from public.lwb_events where id = p_event_id;
  if not found then
    return public.lwb_fail('no_event', '연수를 찾을 수 없습니다.');
  end if;

  if v_pid is null or not exists (select 1 from public.lwb_participants
                                   where id = v_pid and event_id = p_event_id and anonymized_at is null) then
    return public.lwb_fail('no_participant', '참가자 정보를 찾을 수 없습니다. 새로고침해 주세요.');
  end if;

  select a into v_act
    from jsonb_array_elements(coalesce(v_ev.config->'activities', '[]'::jsonb)) a
   where a->>'id' = p_activity_id
   limit 1;
  if v_act is null then
    return public.lwb_fail('no_activity', '알 수 없는 활동입니다.');
  end if;

  if coalesce((select s.value from public.lwb_settings s
                where s.event_id = p_event_id and s.key = 'open:' || p_activity_id), 'N') <> 'Y' then
    return public.lwb_fail('closed', '아직 열리지 않은 과제입니다.');
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or pg_column_size(p_payload) > 16384 then
    return public.lwb_fail('invalid', '응답 형식이 올바르지 않습니다.');
  end if;

  v_res := public.lwb_validate_payload(v_act, p_payload);
  if (v_res->>'ok')::boolean is not true then
    return public.lwb_fail('invalid', coalesce(v_res->>'msg', '응답 형식이 올바르지 않습니다.'));
  end if;

  insert into public.lwb_responses (event_id, activity_id, participant_id, payload)
  values (p_event_id, p_activity_id, v_pid, v_res->'payload')
  on conflict (event_id, activity_id, participant_id)
  do update set payload = excluded.payload, updated_at = now();

  return jsonb_build_object('ok', true);
end $$;
