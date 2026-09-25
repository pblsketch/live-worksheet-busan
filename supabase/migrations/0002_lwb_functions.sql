-- ═══════════════════════════════════════════════════════════════
--  live-worksheet 부산 판 · 0002 서버 함수 (반곡고 0002 의 lw_ 를 lwb_ 로 옮긴 것)
--
--  브라우저(publishable key)의 쓰기는 모두 여기의 security definer 함수를 거친다.
--  검사는 코드에 박힌 이름이 아니라 **등록된 연수 설정(lwb_events.config)**을 읽어서 한다.
--  여러 번 실행해도 안전하다(create or replace).
--
--  돌려주는 형식: 성공 {ok:true, ...} / 실패 {ok:false, code:'<사유 코드>', msg:'<화면 문구>'}
--  사유 코드: no_event · no_participant · no_activity · closed · invalid · bad_name · bad_mode
--             auth · bad_key · bad_value
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────
--  내부 도우미 (브라우저에서 부를 수 없다)
-- ───────────────────────────────────────────────

-- 실패 응답 한 줄
create or replace function public.lwb_fail(p_code text, p_msg text)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'msg', p_msg);
$$;

-- 앞뒤 공백만 뗀다(전각 공백·줄 바꿈 없는 공백 포함). 가운데는 건드리지 않는다.
create or replace function public.lwb_trim(p text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select regexp_replace(coalesce(p, ''), '^[\s 　﻿]+|[\s 　﻿]+$', '', 'g');
$$;

-- 한 줄 입력 정리: 앞뒤 공백을 떼고 안쪽의 연속 공백·줄 바꿈을 공백 하나로
create or replace function public.lwb_one_line(p text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select regexp_replace(public.lwb_trim(p), '[\s 　]+', ' ', 'g');
$$;

-- 문자열 → uuid (형식이 틀리면 null)
create or replace function public.lwb_to_uuid(p text)
returns uuid language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p is null or p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return p::uuid;
end $$;

-- 관리자 암호 확인: 대소문자 구분, 해시(crypt/bf) 비교
create or replace function public.lwb_admin_ok(p_event_id text, p_passcode text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.lwb_event_secrets s
     where s.event_id = p_event_id
       and coalesce(p_passcode, '') <> ''
       and extensions.crypt(p_passcode, s.admin_hash) = s.admin_hash
  );
$$;

-- 참가자 한 명의 응답: { "<활동 id>": payload, ... }
create or replace function public.lwb_participant_responses(p_participant_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_object_agg(r.activity_id, r.payload), '{}'::jsonb)
    from public.lwb_responses r where r.participant_id = p_participant_id;
$$;

-- ───────────────────────────────────────────────
--  활동 종류별 서버 검사 (부품 규약의 '서버 검사 규칙')
--  돌려주는 형식: {ok:true, payload:<정리된 payload>} / {ok:false, msg}
--  새 종류를 더할 때: lwb_validate_<종류> 함수를 만들고 lwb_validate_payload 에 한 줄 더한다.
-- ───────────────────────────────────────────────

-- ox: { "answers": ["O"|"X", …] } 길이 = 문항 수
create or replace function public.lwb_validate_ox(p_activity jsonb, p_payload jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_n   int := case when jsonb_typeof(p_activity->'questions') = 'array'
                    then jsonb_array_length(p_activity->'questions') else 0 end;
  v_ans jsonb := p_payload->'answers';
begin
  if v_n = 0 or jsonb_typeof(v_ans) is distinct from 'array' or jsonb_array_length(v_ans) <> v_n
     or exists (select 1 from jsonb_array_elements(v_ans) e where e not in ('"O"'::jsonb, '"X"'::jsonb)) then
    return jsonb_build_object('ok', false, 'msg', '모든 문항에 O 또는 X를 골라 주세요.');
  end if;
  return jsonb_build_object('ok', true, 'payload', jsonb_build_object('answers', v_ans));
end $$;

-- stage_check:
--   { "objective": { "id": "<보기 id>" | "custom", "text": "<직접 적기 2~80자>" },
--     "items": { "<항목 id>": { "risk": "상"|"중"|"하"|"", "stage": 1~5|null, "memo": "0~80자" } } }
create or replace function public.lwb_validate_stage_check(p_activity jsonb, p_payload jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_obj      jsonb := p_payload->'objective';
  v_obj_id   text;
  v_obj_text text;
  v_out_obj  jsonb;
  v_items    jsonb := p_payload->'items';
  v_out      jsonb := '{}'::jsonb;
  v_filled   int := 0;
  v_t        text;
  v_risk     text;
  v_stage    int;
  v_memo     text;
  r          record;
begin
  -- 학습목표는 반드시 고른다
  if jsonb_typeof(v_obj) is distinct from 'object' or jsonb_typeof(v_obj->'id') is distinct from 'string'
     or v_obj->>'id' = '' then
    return jsonb_build_object('ok', false, 'msg', '학습목표를 먼저 골라 주세요.');
  end if;
  v_obj_id := v_obj->>'id';
  if v_obj_id = 'custom' then
    if jsonb_typeof(p_activity->'allowCustom') is distinct from 'boolean'
       or not (p_activity->>'allowCustom')::boolean then
      return jsonb_build_object('ok', false, 'msg', '이 활동은 학습목표를 직접 적을 수 없습니다.');
    end if;
    if jsonb_typeof(v_obj->'text') is distinct from 'string' then
      return jsonb_build_object('ok', false, 'msg', '직접 적은 학습목표는 2~80자로 적어 주세요.');
    end if;
    v_obj_text := public.lwb_one_line(v_obj->>'text');
    if char_length(v_obj_text) < 2 or char_length(v_obj_text) > 80 then
      return jsonb_build_object('ok', false, 'msg', '직접 적은 학습목표는 2~80자로 적어 주세요.');
    end if;
    v_out_obj := jsonb_build_object('id', 'custom', 'text', v_obj_text);
  else
    if not exists (select 1 from jsonb_array_elements(coalesce(p_activity->'objectives', '[]'::jsonb)) o
                    where o->>'id' = v_obj_id) then
      return jsonb_build_object('ok', false, 'msg', '알 수 없는 학습목표입니다.');
    end if;
    v_out_obj := jsonb_build_object('id', v_obj_id);
  end if;

  -- 항목
  if v_items is null or v_items = 'null'::jsonb then
    v_items := '{}'::jsonb;
  end if;
  if jsonb_typeof(v_items) <> 'object' then
    return jsonb_build_object('ok', false, 'msg', '응답 형식이 올바르지 않습니다.');
  end if;
  for r in select key, value from jsonb_each(v_items) loop
    if not exists (select 1 from jsonb_array_elements(coalesce(p_activity->'items', '[]'::jsonb)) i
                    where i->>'id' = r.key) then
      return jsonb_build_object('ok', false, 'msg', '알 수 없는 항목이 있습니다.');
    end if;
    if jsonb_typeof(r.value) <> 'object' then
      return jsonb_build_object('ok', false, 'msg', '응답 형식이 올바르지 않습니다.');
    end if;

    v_t := jsonb_typeof(r.value->'risk');
    if v_t is null or v_t = 'null' then
      v_risk := '';
    elsif v_t = 'string' and (r.value->>'risk') in ('상', '중', '하', '') then
      v_risk := r.value->>'risk';
    else
      return jsonb_build_object('ok', false, 'msg', '외주화 위험은 상·중·하 가운데 하나로 골라 주세요.');
    end if;

    v_t := jsonb_typeof(r.value->'stage');
    if v_t is null or v_t = 'null' then
      v_stage := null;
    elsif v_t = 'number' and (r.value->>'stage')::numeric in (1, 2, 3, 4, 5) then
      v_stage := (r.value->>'stage')::numeric::int;
    else
      return jsonb_build_object('ok', false, 'msg', '허용 단계는 1~5 가운데 하나로 골라 주세요.');
    end if;

    v_t := jsonb_typeof(r.value->'memo');
    if v_t is null or v_t = 'null' then
      v_memo := '';
    elsif v_t = 'string' then
      v_memo := public.lwb_one_line(r.value->>'memo');
      if char_length(v_memo) > 80 then
        return jsonb_build_object('ok', false, 'msg', '메모는 80자 이내로 적어 주세요.');
      end if;
    else
      return jsonb_build_object('ok', false, 'msg', '응답 형식이 올바르지 않습니다.');
    end if;

    if v_risk <> '' or v_stage is not null or v_memo <> '' then
      v_filled := v_filled + 1;
    end if;
    v_out := v_out || jsonb_build_object(r.key, jsonb_build_object('risk', v_risk, 'stage', v_stage, 'memo', v_memo));
  end loop;

  if v_filled = 0 then
    return jsonb_build_object('ok', false, 'msg', '적어도 한 항목은 채워 주세요.');
  end if;
  return jsonb_build_object('ok', true, 'payload', jsonb_build_object('objective', v_out_obj, 'items', v_out));
end $$;

-- sentence: { "template": "<틀 id>", "blank": "2~60자" }
create or replace function public.lwb_validate_sentence(p_activity jsonb, p_payload jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
declare
  v_tpl   text;
  v_blank text;
begin
  if jsonb_typeof(p_payload->'template') is distinct from 'string'
     or not exists (select 1 from jsonb_array_elements(coalesce(p_activity->'templates', '[]'::jsonb)) t
                     where t->>'id' = p_payload->>'template') then
    return jsonb_build_object('ok', false, 'msg', '문장 틀을 골라 주세요.');
  end if;
  v_tpl := p_payload->>'template';
  if jsonb_typeof(p_payload->'blank') is distinct from 'string' then
    return jsonb_build_object('ok', false, 'msg', '빈칸을 채워 주세요.');
  end if;
  v_blank := public.lwb_one_line(p_payload->>'blank');
  if char_length(v_blank) < 2 then
    return jsonb_build_object('ok', false, 'msg', '조금만 더 구체적으로 적어 주세요.');
  end if;
  if char_length(v_blank) > 60 then
    return jsonb_build_object('ok', false, 'msg', '60자 이내로 적어 주세요.');
  end if;
  return jsonb_build_object('ok', true, 'payload', jsonb_build_object('template', v_tpl, 'blank', v_blank));
end $$;

-- 종류별 검사로 보내기 (서버의 종류 목록은 여기 한 곳)
create or replace function public.lwb_validate_payload(p_activity jsonb, p_payload jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object('ok', false, 'msg', '응답 형식이 올바르지 않습니다.');
  end if;
  case p_activity->>'type'
    when 'ox'          then return public.lwb_validate_ox(p_activity, p_payload);
    when 'stage_check' then return public.lwb_validate_stage_check(p_activity, p_payload);
    when 'sentence'    then return public.lwb_validate_sentence(p_activity, p_payload);
    else return jsonb_build_object('ok', false, 'msg', '지원하지 않는 활동 종류입니다.');
  end case;
end $$;

-- ───────────────────────────────────────────────
--  공개 서버 함수 (anon·authenticated 가 부른다)
-- ───────────────────────────────────────────────

-- 연수 불러오기: 공개 설정 + 진행 설정 + (reveal:<id> 가 Y인 ox 활동만) 공개 전용 내용
create or replace function public.lwb_get_event(p_event_id text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ev       public.lwb_events%rowtype;
  v_settings jsonb;
  v_reveal   jsonb;
begin
  select * into v_ev from public.lwb_events where id = p_event_id;
  if not found then
    return public.lwb_fail('no_event', '연수를 찾을 수 없습니다.');
  end if;

  select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb) into v_settings
    from public.lwb_settings s where s.event_id = v_ev.id;

  select coalesce(jsonb_object_agg(a->>'id', sec.reveal->(a->>'id')), '{}'::jsonb) into v_reveal
    from jsonb_array_elements(coalesce(v_ev.config->'activities', '[]'::jsonb)) a
    join public.lwb_event_secrets sec on sec.event_id = v_ev.id
   where a->>'type' = 'ox'
     and v_settings->>('reveal:' || (a->>'id')) = 'Y'
     and sec.reveal ? (a->>'id');

  return jsonb_build_object(
    'ok', true,
    'event', v_ev.config || jsonb_build_object('id', v_ev.id, 'title', v_ev.title,
                                               'date', v_ev.date, 'listed', v_ev.listed),
    'settings', v_settings,
    'reveal', v_reveal,
    'server_time', now()
  );
end $$;

-- 입장: mode = check | resume | new
--   관리자 암호는 앞뒤 공백만 뗀 입력으로, 길이 검사·정규화 **전에**, 대소문자를 구분해 비교한다.
create or replace function public.lwb_join(p_event_id text, p_name text, p_mode text default 'check')
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_raw  text := public.lwb_trim(p_name);
  v_mode text := coalesce(nullif(p_mode, ''), 'check');
  v_norm text;
  v_row  public.lwb_participants%rowtype;
begin
  if not exists (select 1 from public.lwb_events where id = p_event_id) then
    return public.lwb_fail('no_event', '연수를 찾을 수 없습니다.');
  end if;

  if v_raw <> '' and public.lwb_admin_ok(p_event_id, v_raw) then
    return jsonb_build_object('ok', true, 'admin', true,
                              'participant', jsonb_build_object('id', 'ADMIN', 'name', '관리자'));
  end if;

  if v_mode not in ('check', 'resume', 'new') then
    return public.lwb_fail('bad_mode', '입장 방식이 올바르지 않습니다.');
  end if;
  if char_length(v_raw) < 1 then
    return public.lwb_fail('bad_name', '이름을 입력해 주세요.');
  end if;
  if char_length(v_raw) > 20 then
    return public.lwb_fail('bad_name', '이름은 20자 이내로 입력해 주세요.');
  end if;

  v_norm := lower(regexp_replace(v_raw, '\s+', ' ', 'g'));

  select * into v_row from public.lwb_participants
   where event_id = p_event_id and norm_name = v_norm and anonymized_at is null
   order by created_at desc limit 1;

  if found and v_mode = 'check' then
    return jsonb_build_object('ok', true, 'exists', true, 'name', v_row.name);
  end if;

  if found and v_mode = 'resume' then
    update public.lwb_participants set last_seen = now() where id = v_row.id;
    return jsonb_build_object('ok', true, 'resumed', true,
                              'participant', jsonb_build_object('id', v_row.id, 'name', v_row.name),
                              'responses', public.lwb_participant_responses(v_row.id));
  end if;

  insert into public.lwb_participants (event_id, name, norm_name)
  values (p_event_id, v_raw, v_norm)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'created', true,
                            'participant', jsonb_build_object('id', v_row.id, 'name', v_row.name),
                            'responses', '{}'::jsonb);
end $$;

-- 복원: 기기에 남은 참가자 id로 다시 들어간다(익명화된 참가자는 복원되지 않는다)
create or replace function public.lwb_restore(p_event_id text, p_participant_id text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_pid uuid := public.lwb_to_uuid(p_participant_id);
  v_row public.lwb_participants%rowtype;
begin
  if not exists (select 1 from public.lwb_events where id = p_event_id) then
    return public.lwb_fail('no_event', '연수를 찾을 수 없습니다.');
  end if;
  select * into v_row from public.lwb_participants
   where id = v_pid and event_id = p_event_id and anonymized_at is null;
  if v_pid is null or not found then
    return public.lwb_fail('no_participant', '참가자 정보를 찾을 수 없습니다. 새로고침해 주세요.');
  end if;
  update public.lwb_participants set last_seen = now() where id = v_row.id;
  return jsonb_build_object('ok', true,
                            'participant', jsonb_build_object('id', v_row.id, 'name', v_row.name),
                            'responses', public.lwb_participant_responses(v_row.id));
end $$;

-- 제출: 통과하면 덮어쓰고 {ok:true} 만 돌려준다(점수·정답 여부는 돌려주지 않는다)
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

  update public.lwb_participants set last_seen = now() where id = v_pid;
  return jsonb_build_object('ok', true);
end $$;

-- 관리자 · 진행 설정 바꾸기
--   키: open:<이 연수의 활동 id> · reveal:<이 연수의 ox 활동 id> · materials_open, 값: Y/N
create or replace function public.lwb_admin_set(p_event_id text, p_key text, p_value text, p_passcode text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_ev public.lwb_events%rowtype;
  v_ok boolean;
begin
  select * into v_ev from public.lwb_events where id = p_event_id;
  if not found then
    return public.lwb_fail('no_event', '연수를 찾을 수 없습니다.');
  end if;
  if not public.lwb_admin_ok(p_event_id, p_passcode) then
    return public.lwb_fail('auth', '관리자 인증에 실패했습니다.');
  end if;
  if p_value is null or p_value not in ('Y', 'N') then
    return public.lwb_fail('bad_value', '값은 Y 또는 N만 쓸 수 있습니다.');
  end if;

  v_ok := case
    when p_key = 'materials_open' then true
    when left(p_key, 5) = 'open:' then exists (
      select 1 from jsonb_array_elements(coalesce(v_ev.config->'activities', '[]'::jsonb)) a
       where a->>'id' = substr(p_key, 6))
    when left(p_key, 7) = 'reveal:' then exists (
      select 1 from jsonb_array_elements(coalesce(v_ev.config->'activities', '[]'::jsonb)) a
       where a->>'id' = substr(p_key, 8) and a->>'type' = 'ox')
    else false
  end;
  if v_ok is not true then
    return public.lwb_fail('bad_key', '알 수 없는 설정입니다.');
  end if;

  insert into public.lwb_settings (event_id, key, value) values (p_event_id, p_key, p_value)
  on conflict (event_id, key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
end $$;

-- 관리자 · 응답 모두 비우기: 그 연수의 참가자와 응답만 지운다(연수 설정·진행 설정은 남긴다)
create or replace function public.lwb_admin_reset(p_event_id text, p_passcode text)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_r int;
  v_p int;
begin
  if not exists (select 1 from public.lwb_events where id = p_event_id) then
    return public.lwb_fail('no_event', '연수를 찾을 수 없습니다.');
  end if;
  if not public.lwb_admin_ok(p_event_id, p_passcode) then
    return public.lwb_fail('auth', '관리자 인증에 실패했습니다.');
  end if;
  delete from public.lwb_responses where event_id = p_event_id;
  get diagnostics v_r = row_count;
  delete from public.lwb_participants where event_id = p_event_id;
  get diagnostics v_p = row_count;
  return jsonb_build_object('ok', true, 'participants', v_p, 'responses', v_r);
end $$;

-- 관리자 확인 (관리자 화면을 다시 열 때 기기에 남은 암호로 확인)
create or replace function public.lwb_admin_check(p_event_id text, p_passcode text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', public.lwb_admin_ok(p_event_id, p_passcode));
$$;

-- 가벼운 조회(점검용. 부산 판에는 깨우기 예약 작업이 없다: 반곡고 저장소가 같은 DB를 깨운다)
create or replace function public.lwb_ping()
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('ok', true, 'at', now());
$$;

-- ───────────────────────────────────────────────
--  자동 익명화: 연수 날짜 + 30일이 지난 연수의 참가자 이름을 지운다(응답은 남긴다)
--  예약 작업(lwb_anonymize, 0003)이 매일 부른다. 여러 번 불러도 결과가 같다.
-- ───────────────────────────────────────────────
create or replace function public.lwb_anonymize_expired()
returns integer language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_n int;
begin
  update public.lwb_participants p
     set name = '익명',
         norm_name = 'anon:' || p.id::text,   -- 식별 불가·고유 값(20자 이름과 겹칠 수 없다)
         anonymized_at = now()
    from public.lwb_events e
   where e.id = p.event_id
     and e.date + 30 < current_date
     and p.anonymized_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ───────────────────────────────────────────────
--  실행 권한
-- ───────────────────────────────────────────────

-- 내부 도우미는 브라우저에서 부를 수 없게 한다
revoke all on function public.lwb_fail(text, text)                           from public, anon, authenticated;
revoke all on function public.lwb_trim(text)                                 from public, anon, authenticated;
revoke all on function public.lwb_one_line(text)                             from public, anon, authenticated;
revoke all on function public.lwb_to_uuid(text)                              from public, anon, authenticated;
revoke all on function public.lwb_admin_ok(text, text)                       from public, anon, authenticated;
revoke all on function public.lwb_participant_responses(uuid)                from public, anon, authenticated;
revoke all on function public.lwb_validate_ox(jsonb, jsonb)                  from public, anon, authenticated;
revoke all on function public.lwb_validate_stage_check(jsonb, jsonb)         from public, anon, authenticated;
revoke all on function public.lwb_validate_sentence(jsonb, jsonb)            from public, anon, authenticated;
revoke all on function public.lwb_validate_payload(jsonb, jsonb)             from public, anon, authenticated;
revoke all on function public.lwb_anonymize_expired()                        from public, anon, authenticated;

-- 공개 서버 함수
revoke all on function public.lwb_get_event(text)                            from public;
revoke all on function public.lwb_join(text, text, text)                     from public;
revoke all on function public.lwb_restore(text, text)                        from public;
revoke all on function public.lwb_submit(text, text, text, jsonb)            from public;
revoke all on function public.lwb_admin_set(text, text, text, text)          from public;
revoke all on function public.lwb_admin_reset(text, text)                    from public;
revoke all on function public.lwb_admin_check(text, text)                    from public;
revoke all on function public.lwb_ping()                                     from public;
grant execute on function public.lwb_get_event(text)                         to anon, authenticated;
grant execute on function public.lwb_join(text, text, text)                  to anon, authenticated;
grant execute on function public.lwb_restore(text, text)                     to anon, authenticated;
grant execute on function public.lwb_submit(text, text, text, jsonb)         to anon, authenticated;
grant execute on function public.lwb_admin_set(text, text, text, text)       to anon, authenticated;
grant execute on function public.lwb_admin_reset(text, text)                 to anon, authenticated;
grant execute on function public.lwb_admin_check(text, text)                 to anon, authenticated;
grant execute on function public.lwb_ping()                                  to anon, authenticated;

-- PostgREST 가 새 함수를 바로 알도록
notify pgrst, 'reload schema';
