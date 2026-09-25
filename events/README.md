# 연수 설정 파일

연수 하나는 파일 두 개로 정한다.

| 파일 | 내용 | 저장소 |
|---|---|---|
| `events/<id>.json` | 공개 설정: 제목, 날짜, 목록 노출, 활동 목록과 각 활동의 공개 내용, 자료 목록 | 올린다 |
| `events/<id>.secret.json` | 비밀 설정: 관리자 암호, 공개 전용 내용(OX 정답·라벨·해설·방송 패널) | **올리지 않는다** (`.gitignore`) |

형식 검사는 `tools/lib/event-config.mjs`가 한다. 형식을 바꾸면 이 문서와 그 파일을 함께 고친다.

## 등록

```
node tools/register-event.mjs <id>             # 검사하고 DB에 넣거나 갱신
node tools/register-event.mjs <id> --dry-run   # 검사만 (DB에 접속하지 않음)
```

- 형식이 틀리면 이유를 모두 출력하고 종료 코드 1로 끝난다. DB에는 아무것도 쓰지 않는다.
- 통과하면 연수·비밀을 넣거나 갱신하고, 빠진 진행 설정만 `N`으로 만든다. **이미 있는 진행 설정 값은 덮어쓰지 않는다.** 연수 중에 다시 등록해도 열린 활동이 닫히지 않는다.
- 비밀 파일에 `admin_passcode`가 없거나 비어 있으면 12자 암호를 새로 만들어 비밀 파일에 적고, 화면에 한 번 출력한다. 암호는 DB에 해시(pgcrypto `crypt`, bf)로만 저장된다.
- 끝나면 참가자 주소 `https://pblsketch.github.io/live-worksheet-busan/?e=<id>`와 현황판 주소 `…/board.html?e=<id>`를 출력한다.
- `--dry-run`에서 비밀 파일이 없으면 공개 설정만 검사하고 알린다. 실제 등록에는 비밀 파일이 필요하다(ox 활동이 있으면 정답이 있어야 한다).
- 종료 코드: 0 성공 · 1 검사 실패 · 2 사용법 오류 · 3 DB 오류
- `.env.local`의 `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`으로 관리 API의 SQL 실행을 쓴다. 토큰은 출력하지 않는다.

연수를 지우는 명령은 없다. 필요하면 DB에서 `delete from lwb_events where id = '<id>'`로 지운다(비밀·참가자·응답·진행 설정이 함께 지워진다).

## 공개 설정 `events/<id>.json`

### 최상위 칸

| 칸 | 필수 | 형식 |
|---|---|---|
| `id` | 선택 | 적으면 파일 이름의 id와 같아야 한다. id는 소문자·숫자·하이픈 3~40자 (`^[a-z0-9-]{3,40}$`) |
| `title` | 필수 | 1~200자 |
| `date` | 필수 | `YYYY-MM-DD` (실제 있는 날짜). 이 날짜 + 30일이 지나면 참가자 이름이 익명화된다 |
| `listed` | 선택 | `true`면 주소에 `?e=`가 없을 때 보이는 연수 목록에 나온다. 기본 `false`. 개발·시험용 연수는 `false` |
| `description` | 선택 | 문자열 |
| `activities` | 필수 | 활동 배열(1개 이상). **적힌 순서가 화면 순서다** |
| `materials` | 선택 | 자료 배열 |

`id`·`title`·`date`·`listed`는 DB의 `lwb_events` 열로, 나머지(`description`, `activities`, `materials`)는 `lwb_events.config`에 그대로 들어간다. 모르는 칸은 경고만 하고 그대로 저장한다.

### 활동 공통 칸

| 칸 | 필수 | 형식 |
|---|---|---|
| `id` | 필수 | 연수 안에서 고유. `^[a-z0-9][a-z0-9_-]{0,39}$` |
| `type` | 필수 | `ox` · `stage_check` · `sentence` · `rewrite` |
| `title` | 필수 | 문자열 |
| `description` | 선택 | 문자열 |

같은 종류의 활동이 여러 개 있어도 된다. 정답·라벨·해설·패널(`answers`, `labels`, `notes`, `panel` 등)을 공개 파일에 넣으면 검사에서 막힌다.

### `ox`

| 칸 | 필수 | 형식 |
|---|---|---|
| `questions` | 필수 | 문항 문장 배열(N개, 1개 이상) |
| `choices` | 선택 | `{ "O": "…", "X": "…" }` O·X 버튼 아래에 붙는 짧은 설명(예: `"O": "AI가 썼다"`). 없으면 O·X만 보인다 |

정답은 비밀 파일의 `reveal.<활동 id>`에 둔다.

### `stage_check`

| 칸 | 필수 | 형식 |
|---|---|---|
| `items` | 필수 | `[{ "id", "name", "desc"? }]` 1개 이상. `id`는 `^[A-Za-z0-9_-]{1,40}$`, 활동 안에서 고유 |
| `objectives` | 조건부 | `[{ "id", "group"?, "text", "code"? }]` 학습목표 보기. `group`은 교과군 라벨, `code`는 근거 성취기준 코드. `id`에 `custom`은 쓸 수 없다. `allowCustom`이 `true`가 아니면 1개 이상 |
| `allowCustom` | 선택 | `true`면 '직접 적기'(2~80자)를 허용. 기본 `false` |
| `criteria` | 선택 | `{ "question", "rules": [문자열…], "common" }` 판단 기준 |
| `example` | 선택 | `{ "label", "risk": "상"/"중"/"하", "stage": 1~5, "memo": 80자 이내 }` 기입 예시 |
| `stages` | 선택 | 허용 단계 이름과 색. 적으면 정확히 5개 `[{ "name", "color": "#rrggbb" }]`. 없으면 화면의 기본 5단계(1 혼자 힘으로 · 2 생각 틔우기 · 3 초안 거들기 · 4 함께 다듬기 · 5 같이 만들기) |

### `sentence`

| 칸 | 필수 | 형식 |
|---|---|---|
| `templates` | 필수 | `[{ "id", "label", "before", "after", "placeholder" }]` 1개 이상. 틀이 둘 이상이면 `label` 필수. `before`(앞말)와 `after`(뒷말) 중 하나는 있어야 한다. `placeholder`(선택, 60자 이내)는 글상자 안내 문구(예: `"예: 스스로 질문하는"`), 없으면 "빈칸에 들어갈 말" |

### `rewrite` (수행 특성 문장 고쳐 쓰기)

참가자가 문장 하나를 골라 고쳐 쓴다. 1차·2차를 활동 두 개로 두고, 현황판이 참가자별로 짝지어 나란히 보여 준다.

| 칸 | 필수 | 형식 |
|---|---|---|
| `round` | 선택 | `1` 또는 `2`. 없으면 1 |
| `pairOf` | 2차 | 2차일 때 짝이 되는 1차 활동 id(같은 연수의 `rewrite`, round 1). 문장(`prompts`) id가 1차와 같아야 한다. 없으면 앞쪽에서 가장 가까운 1차와 짝짓고 경고한다 |
| `level` | 선택 | 고쳐 쓸 수준 이름(20자 이내, 예: `"잘함"`). 참가자 화면에 "‘잘함’ 수준으로 고쳐 쓰기"로 나온다 |
| `prompts` | 필수 | `[{ "id", "text" }]` 1개 이상. 참가자가 하나를 고른다. `id`는 `^[A-Za-z0-9_-]{1,40}$`, 화면에는 대문자로 보인다(`a` → A) |
| `checks` | 선택 | 점검 질문 문자열 배열. 참가자 글상자 옆(좁은 화면에서는 아래)과 현황판 골라 띄우기 옆에 늘 보인다 |
| `maxLength` | 선택 | 글자 수 한도, 정수 5~300. 없으면 200 |

- 2차 참가자 화면: 1차에서 고른 문장과 내 1차 문장을 위에 보이고, 글상자를 1차 문장으로 채워 둔다. 1차를 내지 않았으면 문장 고르기부터 한다.
- 현황판: 모아 보기(카드 벽, 문장별 나눠 보기 `0`·`1`·`2`, 넘김 `↑`·`↓`·`PageUp`·`PageDown`) · 골라 띄우기(카드를 누르거나 `Enter`로 고르고 방향키로 옮긴 뒤 `Enter`, `Esc`로 돌아감) · 나란히 보기(짝이 있는 활동, `V`). 이름은 기본으로 숨긴다(`N`).

```json
{ "id": "rewrite1", "type": "rewrite", "title": "수행 특성 고쳐 쓰기 · 1차", "round": 1, "level": "잘함",
  "prompts": [{ "id": "a", "text": "…" }, { "id": "b", "text": "…" }],
  "checks": ["…", "…", "…"], "maxLength": 200 }
{ "id": "rewrite2", "type": "rewrite", "title": "수행 특성 고쳐 쓰기 · 2차", "round": 2, "pairOf": "rewrite1", … }
```

### 자료 `materials`

| 칸 | 필수 | 형식 |
|---|---|---|
| `kind` | 필수 | `"자료"` 또는 `"도구"` |
| `title` | 필수 | 문자열 |
| `desc` | 선택 | 문자열 |
| `url` | 필수 | `http(s)://…` 주소, 저장소 안의 상대 경로(예: `materials/shared/purposes.html`), 또는 `""`(화면에 "준비 중"으로 보이고 누를 수 없다) |

### 문구 규칙

- 공개 설정의 모든 문자열에서 HTML 태그는 `<b>`, `</b>`만 쓸 수 있다(판단 기준 강조용). 다른 태그가 있으면 검사에서 막힌다. 화면은 설정 문구의 `<b>`만 살려 그리고, 참가자가 입력한 글은 모두 이스케이프한다.
- 글자 수는 문자(코드 포인트) 단위로 센다. 서버도 같은 방식이다.

## 비밀 설정 `events/<id>.secret.json`

| 칸 | 필수 | 형식 |
|---|---|---|
| `admin_passcode` | 선택 | 영문·숫자 8~16자, 대소문자 구분. 없거나 `""`이면 등록할 때 12자로 새로 만들어 이 파일에 적는다 |
| `reveal` | 조건부 | `{ "<ox 활동 id>": {...} }`. **ox 활동마다 필수**, ox가 아닌 활동에는 둘 수 없다 |

`reveal.<ox 활동 id>`:

| 칸 | 필수 | 형식 |
|---|---|---|
| `answers` | 필수 | `"O"`/`"X"` 배열. 길이는 그 활동의 `questions`와 같아야 한다 |
| `labels` | 선택 | 문항별 라벨(예: "AI", "사람") 배열, 길이 N |
| `notes` | 선택 | 문항별 해설 배열, 길이 N |
| `panel` | 선택 | 방송 패널 성적표 `[{ "name", "desc"?, "picks": ["O"/"X" N개], "score"?: "2/3" }]` |

관리자 입장: 참가자 화면의 이름 칸에 암호를 그대로 넣는다. 서버는 앞뒤 공백만 떼고, 길이 검사·정규화 전에 대소문자를 구분해 비교한다.

`reveal` 내용은 관리자가 `reveal:<활동 id>`를 `Y`로 켜기 전에는 어디에서도 읽을 수 없다(비밀 표에는 브라우저 권한이 없다).

## 진행 설정 키

등록할 때 아래 키가 없으면 `N`으로 만든다. 값은 `Y`/`N`뿐이다.

- `open:<활동 id>` — 모든 활동. `Y`여야 제출할 수 있다
- `reveal:<활동 id>` — ox 활동만. `Y`면 연수 불러오기가 그 활동의 `reveal` 내용을 내려 준다
- `materials_open` — `Y`면 모든 참가자에게 자료 메뉴가 열린다(아니면 모든 활동을 한 번씩 낸 사람에게 열린다)

## 응답 payload (서버 검사 규칙)

서버 함수 `lwb_submit`이 등록된 설정을 읽어 검사한다. 통과하면 정리한 payload를 저장한다(모르는 칸은 버리고, 글은 앞뒤 공백을 떼고 연속 공백을 하나로 줄인다).

- `ox`: `{ "answers": ["O"|"X", …] }` — 길이 = 문항 수
- `stage_check`:
  ```json
  { "objective": { "id": "<보기 id>" | "custom", "text": "<직접 적기일 때 2~80자>" },
    "items": { "<항목 id>": { "risk": "상"|"중"|"하"|"", "stage": 1~5 | null, "memo": "0~80자" } } }
  ```
  학습목표 필수(직접 적기는 `allowCustom: true`일 때만), 항목 가운데 하나 이상은 위험·단계·메모 중 하나가 채워져 있어야 한다. 모르는 항목 id, 범위 밖 값(단계 0·6·2.5·"3" 등)은 거부한다.
- `sentence`: `{ "template": "<틀 id>", "blank": "2~60자" }`
- `rewrite`: `{ "prompt": "<prompts의 id>", "text": "5자~maxLength(기본 200)" }` — 글은 앞뒤 공백을 떼고 연속 공백·줄 바꿈을 공백 하나로 바꾼 뒤 센다. 열려 있는 동안은 다시 내서 고칠 수 있다((연수, 활동, 참가자)마다 1건)

## 완전한 예

`events/sample.json`(저장소에 있는 개발용 샘플)이 ox·stage_check·sentence 를 쓰는 완전한 예다. `rewrite`와 `placeholder`는 `events/busan1019.json`을 본다. 짝이 되는 비밀 파일은 저장소에 없다(테스트가 실행할 때 만든다). 형식은 아래와 같다.

`events/sample.json`

```json
{
  "id": "sample",
  "title": "개발용 샘플 연수",
  "date": "2026-10-01",
  "listed": false,
  "description": "화면과 서버 함수를 시험하는 연수입니다. 실제 연수가 아닙니다.",
  "activities": [
    {
      "id": "ox1",
      "type": "ox",
      "title": "사람일까, AI일까?",
      "description": "문장마다 AI가 썼다고 생각하면 O, 사람이 썼다고 생각하면 X를 고르세요.",
      "choices": { "O": "AI가 썼다", "X": "사람이 썼다" },
      "questions": ["문장 하나", "문장 둘", "문장 셋"]
    },
    {
      "id": "practice",
      "type": "stage_check",
      "title": "탐구 과제, 몇 단계로 열까?",
      "items": [
        { "id": "topic", "name": "탐구 주제 정하기", "desc": "관심사에서 탐구할 질문을 고른다" },
        { "id": "research", "name": "자료 조사", "desc": "주제에 맞는 자료를 찾아 출처와 함께 정리한다" }
      ],
      "objectives": [
        { "id": "obj-a", "group": "교과군 가", "text": "탐구 질문을 세우고 자료를 근거로 답을 찾는다.", "code": "[예시01-01]" }
      ],
      "allowCustom": true,
      "criteria": {
        "question": "이 활동에서, 학생이 스스로 겪어야만 배우는 것은 무엇인가?",
        "rules": ["… → 예라면 <b>1~2단계로 잠근다</b>"],
        "common": "공통 규칙 · 썼으면 밝힌다 · 단계와 이유는 미리 공지한다"
      },
      "example": { "label": "자료 조사라면", "risk": "상", "stage": 3, "memo": "출처 링크 기록 의무" }
    },
    {
      "id": "pledge",
      "type": "sentence",
      "title": "한 줄 선언",
      "templates": [
        { "id": "student", "label": "학생 쪽", "before": "나는 학생에게 AI를 맡기기 전에, 반드시", "after": "하게 하겠다." },
        { "id": "teacher", "label": "교사 쪽", "before": "나는 AI에 맡기기 전에, 반드시", "after": "하겠다." }
      ]
    }
  ],
  "materials": [
    { "kind": "자료", "title": "강의 자료", "desc": "준비 중", "url": "" },
    { "kind": "자료", "title": "AI·에듀테크 9가지 교육적 목적", "url": "materials/shared/purposes.html" },
    { "kind": "도구", "title": "예시 도구", "desc": "외부 링크", "url": "https://example.com/" }
  ]
}
```

`events/sample.secret.json` (저장소에 올리지 않음)

```json
{
  "admin_passcode": "",
  "reveal": {
    "ox1": {
      "answers": ["X", "O", "X"],
      "labels": ["사람", "AI", "사람"],
      "notes": ["해설 하나", "해설 둘", "해설 셋"],
      "panel": [
        { "name": "패널 이름", "desc": "한 줄 소개", "picks": ["X", "O", "O"], "score": "2/3" }
      ]
    }
  }
}
```

`admin_passcode`를 비워 두면 첫 등록 때 암호가 만들어져 이 파일에 적힌다.
