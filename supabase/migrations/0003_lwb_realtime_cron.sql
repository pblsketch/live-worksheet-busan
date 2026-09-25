-- ═══════════════════════════════════════════════════════════════
--  live-worksheet 부산 판 · 0003 실시간 방송과 익명화 예약 작업
--  여러 번 실행해도 안전하다.
--  발행(supabase_realtime)에는 lwb_ 표를 더하기만 하고, 확장(pg_cron)은 만들지 않는다.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────
--  실시간: 참가자·응답·진행 설정의 변경을 방송한다
--  (클라이언트는 event_id 로 자기 연수만 걸러 받는다. 참가자 기기는 진행 설정만 구독한다)
-- ───────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime 발행이 없어 실시간 설정을 건너뜁니다.';
    return;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lwb_participants') then
    alter publication supabase_realtime add table public.lwb_participants;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lwb_responses') then
    alter publication supabase_realtime add table public.lwb_responses;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lwb_settings') then
    alter publication supabase_realtime add table public.lwb_settings;
  end if;
end $$;

-- 수정·삭제 방송에도 옛 행 전체(event_id 포함)가 실려야 연수별로 거를 수 있다
alter table public.lwb_participants replica identity full;
alter table public.lwb_responses    replica identity full;
alter table public.lwb_settings     replica identity full;

-- ───────────────────────────────────────────────
--  익명화 예약 작업: 매일 18:27 UTC(한국 시각 새벽 3:27). 반곡고 lw_anonymize(18:17)와 10분 어긋나게 둔다.
--  cron.schedule 은 같은 이름이 있으면 고쳐 쓴다(pg_cron 1.3+). pg_cron 이 없으면 건너뛴다.
-- ───────────────────────────────────────────────
do $$
begin
  if to_regprocedure('cron.schedule(text, text, text)') is null then
    raise notice 'pg_cron 이 없어 익명화 예약 작업을 건너뜁니다.';
    return;
  end if;
  perform cron.schedule('lwb_anonymize', '27 18 * * *', 'select public.lwb_anonymize_expired()');
end $$;
