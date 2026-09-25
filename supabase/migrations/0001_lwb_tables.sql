-- ═══════════════════════════════════════════════════════════════
--  live-worksheet 부산 판 · 0001 표와 읽기 권한
--
--  여러 번 실행해도 안전하다(데이터를 지우지 않는다).
--  이 앱이 만드는 이름에는 모두 lwb_ 접두어를 붙인다.
--  같은 Supabase 프로젝트에 반곡고 판(lw_ 접두어)이 있다. lwb_ 아닌 객체를
--  만들거나 바꾸거나 지우는 문장은 쓰지 않는다(tests/unit/migrations.test.mjs 가 검사한다).
-- ═══════════════════════════════════════════════════════════════

-- 관리자 암호 해시(crypt/bf)용 pgcrypto 는 만들지 않고 있는지만 본다(Supabase에는 extensions 스키마에 이미 있다).
do $$
begin
  if to_regprocedure('extensions.crypt(text, text)') is null
     or to_regprocedure('extensions.gen_salt(text, integer)') is null then
    raise exception 'extensions 스키마에 pgcrypto(crypt, gen_salt)가 없습니다. 이 마이그레이션은 확장을 만들지 않습니다.';
  end if;
end $$;

-- ───────────────────────────────────────────────
--  연수: 공개 설정(활동·자료)은 config 에 통째로 둔다
-- ───────────────────────────────────────────────
create table if not exists public.lwb_events (
  id         text primary key
             constraint lwb_events_id_format check (id ~ '^[a-z0-9-]{3,40}$'),
  title      text not null
             constraint lwb_events_title_len check (char_length(btrim(title)) between 1 and 200),
  date       date not null,
  listed     boolean not null default false,
  config     jsonb not null default '{}'::jsonb
             constraint lwb_events_config_object check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 연수 비밀: 관리자 암호 해시, 공개 전용 내용(활동 id → 내용). 누구도 직접 읽지 못한다.
create table if not exists public.lwb_event_secrets (
  event_id   text primary key references public.lwb_events (id) on delete cascade,
  admin_hash text not null,
  reveal     jsonb not null default '{}'::jsonb
             constraint lwb_event_secrets_reveal_object check (jsonb_typeof(reveal) = 'object'),
  updated_at timestamptz not null default now()
);

-- 참가자: 이름은 여기에만 둔다(응답에 복사하지 않는다)
create table if not exists public.lwb_participants (
  id            uuid primary key default gen_random_uuid(),
  event_id      text not null references public.lwb_events (id) on delete cascade,
  name          text not null
                constraint lwb_participants_name_len check (char_length(name) between 1 and 20),
  norm_name     text not null,
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  anonymized_at timestamptz,
  constraint lwb_participants_id_event_key unique (id, event_id)
);
create index if not exists lwb_participants_event_norm_idx on public.lwb_participants (event_id, norm_name);
create index if not exists lwb_participants_event_seen_idx on public.lwb_participants (event_id, last_seen desc);

-- 응답: (연수, 활동, 참가자)마다 한 건. 이름·점수 칸은 두지 않는다.
create table if not exists public.lwb_responses (
  id             bigint generated always as identity primary key,
  event_id       text not null references public.lwb_events (id) on delete cascade,
  activity_id    text not null,
  participant_id uuid not null,
  payload        jsonb not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint lwb_responses_one_per_activity unique (event_id, activity_id, participant_id),
  constraint lwb_responses_participant_fk foreign key (participant_id, event_id)
    references public.lwb_participants (id, event_id) on delete cascade
);
create index if not exists lwb_responses_participant_idx on public.lwb_responses (participant_id);
create index if not exists lwb_responses_event_updated_idx on public.lwb_responses (event_id, updated_at desc);

-- 진행 설정: 키는 open:<활동 id> · reveal:<활동 id> · materials_open 세 종류, 값은 Y/N
create table if not exists public.lwb_settings (
  event_id   text not null references public.lwb_events (id) on delete cascade,
  key        text not null
             constraint lwb_settings_key_format
             check (key ~ '^(open:[a-z0-9][a-z0-9_-]{0,39}|reveal:[a-z0-9][a-z0-9_-]{0,39}|materials_open)$'),
  value      text not null
             constraint lwb_settings_value_yn check (value in ('Y', 'N')),
  updated_at timestamptz not null default now(),
  primary key (event_id, key)
);

-- ───────────────────────────────────────────────
--  RLS · 읽기는 네 표만 공개, 쓰기는 서버 함수로만
-- ───────────────────────────────────────────────
alter table public.lwb_events        enable row level security;
alter table public.lwb_event_secrets enable row level security;
alter table public.lwb_participants  enable row level security;
alter table public.lwb_responses     enable row level security;
alter table public.lwb_settings      enable row level security;

-- Supabase 기본 권한(anon·authenticated에 모든 권한)을 걷어 내고 읽기만 다시 준다.
-- 비밀 표에는 아무 권한도 주지 않는다(정책도 없다).
revoke all on table public.lwb_events, public.lwb_event_secrets, public.lwb_participants,
                    public.lwb_responses, public.lwb_settings
  from anon, authenticated;
revoke all on sequence public.lwb_responses_id_seq from anon, authenticated;
grant select on table public.lwb_events, public.lwb_participants, public.lwb_responses, public.lwb_settings
  to anon, authenticated;

-- 이름을 검사할 수 있게 표마다 문장을 따로 쓴다(동적 SQL을 쓰지 않는다)
do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'lwb_events' and policyname = 'lwb_read_all') then
    create policy lwb_read_all on public.lwb_events for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'lwb_participants' and policyname = 'lwb_read_all') then
    create policy lwb_read_all on public.lwb_participants for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'lwb_responses' and policyname = 'lwb_read_all') then
    create policy lwb_read_all on public.lwb_responses for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'lwb_settings' and policyname = 'lwb_read_all') then
    create policy lwb_read_all on public.lwb_settings for select to anon, authenticated using (true);
  end if;
end $$;
