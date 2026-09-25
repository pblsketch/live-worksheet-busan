# DB (Supabase) — 부산 판 `lwb_`

- 프로젝트: 반곡고 판과 **같은 Supabase 프로젝트**를 쓴다(ref는 `.env.local`의 `SUPABASE_PROJECT_REF`). 반곡고 판은 `lw_`, 부산 판은 **`lwb_`** 접두어로 표·함수·정책·예약 작업을 따로 둔다.
  - `lw_b_`가 아니라 `lwb_`인 까닭: 반곡고 DB 검사(`tests/db/schema.test.mjs`)는 `lw\_%`로 시작하는 함수를 모두 반곡고 것으로 센다. `lwb_`는 그 검사에 잡히지 않는다.
  - 부산 마이그레이션은 `lwb_` 아닌 객체를 만들거나 바꾸거나 지우거나 권한을 바꾸지 않는다. 예외는 부산 객체를 더하기만 하는 두 가지: `alter publication supabase_realtime add table public.lwb_…`, `cron.schedule('lwb_anonymize', …)`. pgcrypto·pg_cron 확장은 만들지 않고 있는지만 본다(반곡고 판이 이미 깔았다).
  - 이 규칙은 `tools/lib/sql-guard.mjs`가 검사한다(단위 검사 `tests/unit/migrations.test.mjs`, `npm run migrate`도 위반이 있으면 적용하지 않는다).
- 마이그레이션: `supabase/migrations/0001~0004_lwb_*.sql`을 이름 순서로 적용한다. 여러 번 실행해도 안전하다(데이터를 지우지 않는다).

```
npm run snapshot -- --write supabase/baseline-snapshot.json   # 마이그레이션 전 기준 만들기(읽기만)
npm run migrate                                                # = node tools/apply-migrations.mjs
npm run snapshot                                               # 기준과 비교(아래 규칙)
npm run test:db                                                # 서버 함수 검사(시험 연수 t-… 를 만들고 끝나면 지운다)
```

`npm run snapshot` 규칙(`tools/lib/snapshot.mjs`): 기준 대비 **`lwb_` 아닌 객체의 추가·삭제가 없고**, `lwb_` 아닌 표(열·제약·정책·RLS·권한)·함수(`pg_get_functiondef`+실행 권한)·예약 작업(일정·명령)은 **md5 해시까지 그대로**여야 통과한다. 반곡고 `lw_` 정의가 한 글자라도 바뀌면 실패한다. 기준 파일은 원격 확인 단계에서 만든다(저장소에는 없다).

## 표

| 표 | 브라우저(publishable key) | 내용 |
|---|---|---|
| `lwb_events` | 읽기 | `id`, `title`, `date`, `listed`, `config`(공개 설정: `description`·`activities`·`materials`), `created_at`, `updated_at` |
| `lwb_event_secrets` | **권한 없음** | `event_id`, `admin_hash`(bcrypt), `reveal`(활동 id → 공개 전용 내용) |
| `lwb_participants` | 읽기 | `id`(uuid), `event_id`, `name`, `norm_name`, `created_at`, `last_seen`, `anonymized_at` |
| `lwb_responses` | 읽기 | `id`, `event_id`, `activity_id`, `participant_id`, `payload`, `created_at`, `updated_at` — (연수, 활동, 참가자)마다 1건. 이름·점수 칸 없음 |
| `lwb_settings` | 읽기 | `event_id`, `key`, `value`('Y'/'N'), `updated_at` |

- 쓰기는 모두 아래 서버 함수로만 한다(표에 직접 쓰는 권한 없음).
- 실시간 발행(`supabase_realtime`): `lwb_participants`, `lwb_responses`, `lwb_settings` (replica identity full). 클라이언트는 `event_id=eq.<id>` 필터로 자기 연수만 받는다.
  - **참가자 기기는 `lwb_settings`만 구독한다.** 응답·참가자 변경은 관리자 화면과 현황판만 구독한다(`assets/core.js`의 `subscribedTables`). 참가자 화면에 다른 사람 결과가 필요하면 그 활동의 응답만 제출 직후 한 번, 그 뒤 15~25초 무작위 간격으로 다시 불러온다. 100명이 한꺼번에 내도 참가자 기기로 가는 알림이 없다.
  - 관리자·현황판은 응답·참가자 알림을 첫 알림부터 600ms 모아 한 번만 다시 불러온다.
- 목록 노출 연수: `GET /rest/v1/lwb_events?select=id,title,date&listed=is.true&order=date.desc`

## 서버 함수 (`POST /rest/v1/rpc/<이름>`, 인자는 JSON 객체)

실패는 모두 `{ ok:false, code, msg }`. `msg`는 화면에 그대로 보여도 되는 문구다.
코드: `no_event` · `no_participant` · `no_activity` · `closed` · `invalid` · `bad_name` · `bad_mode` · `auth` · `bad_key` · `bad_value`

| 함수 | 인자 | 성공 |
|---|---|---|
| `lwb_get_event` | `p_event_id` | `{ ok, event: { id, title, date, listed, description?, activities, materials? }, settings: { "<key>": "Y"|"N" }, reveal: { "<ox 활동 id>": { answers, labels?, notes?, panel? } }, server_time }` — `reveal`에는 `reveal:<id>`가 Y인 ox 활동만 들어간다 |
| `lwb_join` | `p_event_id`, `p_name`, `p_mode`('check' 기본 · 'resume' · 'new') | 관리자: `{ ok, admin:true, participant:{ id:'ADMIN', name:'관리자' } }` · 같은 이름이 있고 check: `{ ok, exists:true, name }` · 이어하기: `{ ok, resumed:true, participant:{id,name}, responses }` · 새로: `{ ok, created:true, participant:{id,name}, responses:{} }` |
| `lwb_restore` | `p_event_id`, `p_participant_id` | `{ ok, participant:{id,name}, responses }` (익명화된 참가자는 `no_participant`) |
| `lwb_submit` | `p_event_id`, `p_participant_id`, `p_activity_id`, `p_payload` | `{ ok:true }` 만. 점수·정답 여부는 돌려주지 않는다 |
| `lwb_admin_set` | `p_event_id`, `p_key`, `p_value`, `p_passcode` | `{ ok, key, value }` |
| `lwb_admin_reset` | `p_event_id`, `p_passcode` | `{ ok, participants, responses }` (지운 수. 설정·진행 설정은 남는다) |
| `lwb_admin_check` | `p_event_id`, `p_passcode` | `{ ok: true|false }` |
| `lwb_ping` | 없음 | `{ ok, at }` (점검용. 부산 판에는 깨우기 예약 작업이 없다: 반곡고 저장소가 같은 DB를 깨운다) |

- `responses`는 `{ "<활동 id>": payload }` (그 참가자의 응답).
- 관리자 판별: 이름 칸 입력에서 앞뒤 공백만 떼고, 길이 검사·정규화 **전에** 대소문자를 구분해 암호 해시와 비교한다(다시 열 때는 `lwb_admin_check`로 확인).
- `lwb_submit` 검사 순서: 연수 없음 → 참가자 없음 → 활동 없음 → `open:<활동 id>`가 Y 아님(`closed`) → 종류별 검사(`invalid`, 사유 문구). payload 형식은 `events/README.md` 참고. 제출은 참가자 행을 고치지 않는다(0004).
- `lwb_admin_set` 키: `open:<이 연수의 활동 id>`, `reveal:<이 연수의 ox 활동 id>`, `materials_open`. 값: `Y`/`N`.

## 내부 함수와 예약 작업

- `lwb_validate_payload(활동, payload)`가 종류별 검사(`lwb_validate_ox`, `lwb_validate_stage_check`, `lwb_validate_sentence`, `lwb_validate_rewrite`)로 보낸다. **새 활동 종류**를 더할 때는 `lwb_validate_<종류>`를 만들고 이 함수에 한 줄, `tools/lib/event-config.mjs`의 `ACTIVITY_TYPES`와 형식 검사에 한 곳, 클라이언트 등록부에 한 곳을 더한다.
- `lwb_validate_rewrite`: `{ prompt, text }`. `prompt`는 설정 `prompts`의 id, `text`는 앞뒤 공백을 떼고 연속 공백·줄 바꿈을 공백 하나로 바꾼 뒤 5자~`maxLength`(기본 200, 최대 300, 코드 포인트).
- `lwb_anonymize_expired()`: 날짜 + 30일이 지난 연수의 참가자 이름을 '익명'으로 바꾼다. 응답은 남긴다.
- pg_cron 작업 `lwb_anonymize`: 매일 **18:27 UTC**(한국 03:27). 반곡고 `lw_anonymize`(18:17)와 겹치지 않게 둔다.
- 내부 함수는 브라우저에서 부를 수 없다(실행 권한 없음).

## 원격 없이 확인하기

- `npm run test:pglite`: PGlite(메모리 Postgres)에 Supabase 흉내(anon·authenticated 역할과 기본 권한, `extensions.pgcrypto`, `supabase_realtime` 발행, `cron.job`·`cron.schedule`)를 깔고, 반곡고 마이그레이션(이 저장소의 git 기록 `b3627c3`)과 부산 마이그레이션을 얹어 확인한다: 두 번 실행 안전, 전후 스냅숏 비교(`lw_` 정의 그대로), 권한, `lwb_submit`의 rewrite 검사.
- `npm run test:local-db`: 로컬 흉내 Supabase(`tests/local/server.mjs`: PostgREST·관리 API·Realtime 흉내 + PGlite)에 대고 `tests/db` 전체를 돌린다.
