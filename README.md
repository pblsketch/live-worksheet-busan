# 라이브 활동지 · 부산 판

2026. 10. 19.(월) 부산 교원 연수 「배움이 깊어지는 학생평가」(Zoom 100명)에서 쓰는 라이브 활동지입니다. 참가자는 Zoom 옆 브라우저 창이나 휴대폰으로 들어와 활동을 내고, 강사는 관리자 화면에서 활동을 열고 닫으며, 현황판을 Zoom 화면 공유로 보여 줍니다.

- 참가자 주소: `https://pblsketch.github.io/live-worksheet-busan/?e=busan1019`
- 현황판 주소: `https://pblsketch.github.io/live-worksheet-busan/board.html?e=busan1019`
- 관리자 화면: 참가자 주소에서 이름 칸에 관리자 암호를 넣고 들어갑니다(암호는 `events/busan1019.secret.json`, 등록할 때 만들어집니다).

## 반곡고 판과의 관계

반곡고 연수(10/15)가 쓰는 `pblsketch/live-worksheet`를 복사해 따로 만든 판입니다. 반곡고 코드와 DB를 한 글자도 바꾸지 않도록 이렇게 나눴습니다.

| | 반곡고 판 | 부산 판(이 저장소) |
|---|---|---|
| 저장소·사이트 | `pblsketch/live-worksheet` | `pblsketch/live-worksheet-busan` (새로 만듦) |
| Supabase 프로젝트 | 같은 프로젝트 | 같은 프로젝트 |
| DB 이름 | `lw_` 표·함수·정책·예약 작업 | **`lwb_`** (`lw_`는 만들지도 바꾸지도 않음) |
| 브라우저 저장 키 | `lw:…` | **`lwb:…`** (같은 출처 `pblsketch.github.io`라 나눔) |
| 실시간 채널 | `lw-…` | `lwb-…` |
| 익명화 예약 작업 | `lw_anonymize` 18:17 UTC | `lwb_anonymize` 18:27 UTC |
| 깨우기 예약 작업 | 있음(같은 DB를 깨움) | 없음 |

접두어는 브라우저에서 `assets/core.js`의 `NS` 한 곳에서 정합니다. 다른 Supabase 프로젝트로 옮기려면 `assets/config.js`와 `.env.local`만 바꾸면 됩니다. DB 쪽 규칙과 점검은 [supabase/README.md](supabase/README.md)에 있습니다.

## 활동 (`events/busan1019.json`)

| 순서 | id | 종류 | 내용 |
|---|---|---|---|
| ① | `grow` | sentence | 학생이 어떤 사람으로 성장하길 바라시나요? — "나는 학생이 ___ 사람으로 성장하길 바란다." 쓰는 화면 위에 강의 슬라이드의 삽화(`assets/img/grow.jpg`) |
| ② | `ox` | ox | 사람일까, AI일까? (반곡고 문항 그대로, 3번은 정답 공개 때 '사람 + AI 합작'으로 뒤집음) |
| ③ | `rewrite1` | rewrite | 수행 특성 고쳐 쓰기 (두 문장 가운데 하나를 골라 '잘함' 수준을 고쳐 씀). 과제 맥락(실제 수업의 2015 개정 성취기준 [10국03-02], 건의문 과제 GRASPS, 학습 요소·유의 사항, 평가기준 상·중·하)과 문장별 평가 요소를 함께 보여 줌 |
| ④ | `pledge` | sentence | 다음 학기에 바꿀 한 가지 — "다음 학기 수행평가에서 나는 ___" |

2026-09-25에 고쳐 쓰기 2차(`rewrite2`)를 뺐습니다. 강사 시범 바로 뒤의 2차는 시범 문장을 따라 쓰게 되기 쉬워, 그 시간을 1차에서 과제 맥락을 읽는 데 씁니다. rewrite 부품의 2차·나란히 보기 기능은 그대로 남아 있습니다(E2E는 2차를 붙인 시험 연수로 확인). 이미 등록된 DB에 다시 등록하면 `open:rewrite2` 진행 설정 키가 '설정에 없는 키'로 알려지는데, 지우지 않아도 됩니다.

자료(`materials`)는 비워 두었습니다. 칸마다의 규칙은 [events/README.md](events/README.md)에 있습니다.

## 어떻게 이루어져 있나

| 자리 | 하는 일 |
|---|---|
| `index.html`, `board.html`, `assets/` | 정적 사이트(GitHub Pages). 참가자 화면·관리자 화면·현황판 |
| `assets/activities/` | 활동 부품 `ox` · `stage_check` · `sentence` · `rewrite`, 등록부 `registry.js` |
| `assets/paging.js` | 현황판 카드 넘김(쪽 나누기)·새 카드 강조 |
| `events/<id>.json` / `events/<id>.secret.json` | 연수 공개 설정(올림) / 관리자 암호·OX 정답(**올리지 않음**) |
| `supabase/migrations/` | `0001~0004_lwb_*.sql` 표·서버 함수·실시간·예약 작업 |
| `tools/` | 등록(`register-event.mjs`), 마이그레이션·점검(`apply-migrations.mjs`), 부하 시험(`load-test.mjs`) |
| `tests/unit` · `tests/local` | 원격 없이 도는 검사(단위, PGlite, 로컬 흉내 Supabase) |
| `tests/db` · `tests/e2e` | 실제 DB 검사·브라우저 E2E(로컬 흉내 서버로도 돈다) |

## 실시간 구조 (100명 전제)

- 참가자 기기는 **진행 설정(`lwb_settings`)만** 실시간으로 받습니다. 스위치를 켜면 새로고침 없이 바뀝니다.
- 참가자 화면이 다른 사람 결과(OX 분포, 문장 목록)를 보여 줄 때는 그 활동의 응답만 제출 직후 한 번, 그 뒤 15~25초 무작위 간격으로 다시 불러옵니다. 화면이 가려져 있으면 멈춥니다.
- 응답·참가자 변경은 관리자 화면과 현황판만 받고, 알림이 몰려와도 600ms로 묶어 한 번만 다시 불러옵니다.
- 로컬 흉내 서버로 100명을 흉내 낸 결과(`npm run test:local-load`): 활동 하나(열기 → 100명 제출 → 닫기)에 참가자 기기가 받는 알림은 모두 합쳐 200건(열림·닫힘 각 1건씩), 현황판은 102건입니다. 예전 구조라면 제출 알림만 약 1만 건입니다.

## 연수 당일

**준비**: 노트북에서 참가자 주소를 열어 관리자 암호로 들어가고, 현황판은 다른 창(또는 관리자 화면의 "모니터에 띄우기")으로 열어 Zoom으로 그 창을 공유합니다. 접속 안내에 "닉네임으로 들어와도 됩니다"를 적습니다.

**현황판 키**

| 키 | 모든 화면 | 문장(①④) | 고쳐 쓰기(③) |
|---|---|---|---|
| `←` `→` | 화면 넘기기 | 〃 | 〃 (카드를 고르거나 띄운 동안에는 앞뒤 카드) |
| `PageDown` `PageUp` | 화면 넘기기(발표 리모컨) | **쪽 넘기기** | **쪽 넘기기** (띄운 동안에는 앞뒤 카드) |
| `↓` `↑` | | 쪽 넘기기 | 쪽 넘기기 (카드를 고르거나 띄운 동안에는 앞뒤 카드) |
| `Enter` | | | 첫 카드 고르기 → 방향키로 옮기고 → `Enter`로 가운데 크게 띄우기(카드를 눌러도 됨) |
| `Esc` | | | 띄운 것 닫기 · 고르기 풀기 |
| `N` | | | 이름 보이기·숨기기(기본 숨김) |
| `0` `1` `2` | | | 전체 · 문장 A · 문장 B |
| `V` | | | 모아 보기 ↔ 나란히 보기(2차가 있는 연수만) |
| `F` | 전체화면 | | |

- 문장(①④) 현황판은 이름이 보입니다. 카드는 처음 낸 순서로 쌓이고, 새 카드는 끝에 붙어 보던 쪽이 튀지 않습니다. 다른 쪽에 새 카드가 오면 쪽 표시 옆에 알립니다.
- 고쳐 쓰기(③) 골라 띄우기는 현황판 안의 기능입니다. DB에 아무것도 쓰지 않으므로 참가자 화면은 바뀌지 않습니다.
- 골라 띄우기에는 원래 문장 아래에 그 문장의 평가 요소가 작게 나옵니다.
- (2차가 있는 연수) 2차 현황판은 나란히 보기부터 열립니다(두 번 다 낸 사람만, 2차에서 새로 생긴 말은 형광펜).

**리허설 뒤**: 관리자 화면 → 응답 모두 비우기, 모든 스위치를 끕니다.

## 검사

원격 없이(언제든):

```
npm ci
npm run test:unit        # 단위 검사
npm run test:pglite      # PGlite: 반곡고 판 위에 부산 마이그레이션, lw_ 정의 그대로, rewrite 서버 검사
npm run test:local-db    # 로컬 흉내 Supabase 에 대고 tests/db 전체
npm run test:local-e2e   # 로컬 흉내 Supabase 에 대고 브라우저 E2E 전체(브라우저는 127.0.0.1 밖으로 못 나감)
npm run test:local-load  # 로컬 흉내 Supabase 에 대고 부하 시험 100명
```

실제 DB(아래 원격 작업 순서에서만): `npm run test:db`, `npm run test:e2e`, `npm run load-test -- --confirm-remote`.

## 원격 작업 순서 (사용자 확인 뒤)

1. `.env.local`을 원래 폴더(`live-worksheet`)에서 파일째 복사합니다(내용을 열지 않고).
2. 기준 목록 만들기(읽기만): `npm run snapshot -- --write supabase/baseline-snapshot.json`
3. `npm run migrate`(0001~0004 `lwb_`) → `npm run snapshot`으로 `lw_` 정의가 그대로인지 확인 → 원래 폴더에서 `npm run test:db`로 반곡고 검사를 확인합니다.
   - 반곡고의 `schema.test.mjs` 첫 검사("기준 목록 대비 lw_ 아닌 객체의 추가·삭제가 없다")와 반곡고 `npm run snapshot`은 `lwb_` 객체를 "lw_ 아닌 추가"로 알리며 실패합니다. 부산 판이 더한 것이라 예상된 결과이고, 사이트·연수에는 영향이 없습니다. 나머지 반곡고 검사는 그대로 통과해야 합니다.
4. 부산 `npm run test:db`, `npm run test:e2e`, `npm run load-test -- --confirm-remote`
5. `node tools/register-event.mjs busan1019` (관리자 암호가 만들어져 비밀 파일에 적히고 한 번 출력됩니다)
6. 새 저장소 `pblsketch/live-worksheet-busan`을 만들어 올리고 Pages를 켭니다(`main` 브랜치 루트, `.nojekyll` 있음).

## 비밀 파일과 로컬 접속 정보

| 무엇 | 어디 | 저장소 |
|---|---|---|
| Supabase 개인 토큰, 프로젝트 ref | `.env.local` | 올리지 않음(`.gitignore`) |
| 관리자 암호, OX 정답·해설 | `events/busan1019.secret.json` | 올리지 않음(`.gitignore`) |
| DB 주소, publishable key | `assets/config.js` | 올림(브라우저에 원래 공개되는 값) |

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| "연수를 찾을 수 없습니다" | 주소의 `?e=busan1019`, 등록 명령을 돌렸는지 |
| 참가자 화면이 대기에서 안 바뀜 | 관리자 화면의 그 활동 스위치. 실시간이 막힌 망이면 20초 안에 다시 불러와 바뀝니다 |
| 현황판 카드가 한 쪽에 다 안 보임 | 정상입니다. `PageDown`·`↓`로 넘깁니다(쪽 표시 2/5) |
| 고쳐 쓰기 현황판에 이름이 안 보임 | 기본으로 숨깁니다. `N` |
| 관리자로 안 들어가짐 | 암호는 대소문자를 구분합니다. 비밀 파일의 `admin_passcode`와 같은지 |
