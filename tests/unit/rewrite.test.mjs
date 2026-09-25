/**
 * rewrite (명세 3): 형식 검사, payload 정리, 1차·2차 짝, 어절 비교, 관리자 카드
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePublic } from '../../tools/lib/event-config.mjs';
import rewrite, {
  tidy, maxOf, promptOf, promptLabel, pairOf, pairRows, byFirst, wordDiff, diffHTML, MIN, MAX_DEFAULT
} from '../../assets/activities/rewrite.js';
import { moduleFor } from '../../assets/activities/registry.js';

const PROMPTS = [
  { id: 'a', text: '예상 독자를 매우 잘 고려하여 건의문을 훌륭하게 작성함.' },
  { id: 'b', text: '복잡한 사회적 쟁점을 다루는 어려운 건의문을 완성도 높게 작성함.' }
];
const CHECKS = ['문장에 적힌 행동을 교사가 관찰할 수 있는가?', '과제의 난이도가 아니라 학생이 한 일을 적었는가?'];
const R1 = { id: 'rewrite1', type: 'rewrite', title: '1차', round: 1, level: '잘함', prompts: PROMPTS, checks: CHECKS, maxLength: 200 };
const R2 = { id: 'rewrite2', type: 'rewrite', title: '2차', round: 2, pairOf: 'rewrite1', level: '잘함', prompts: PROMPTS, checks: CHECKS };
const pub = (acts) => ({ title: '시험', date: '2026-10-19', activities: acts });
const clone = (x) => JSON.parse(JSON.stringify(x));

describe('rewrite 형식 검사 (event-config)', () => {
  it('명세의 1차·2차 설정은 통과한다', () => {
    const r = validatePublic('busan-x', pub([R1, R2]));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  it('round · maxLength · level · prompts · checks 칸', () => {
    const bad = (patch, re) => {
      const a = { ...clone(R1), ...patch };
      const r = validatePublic('busan-x', pub([a]));
      assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(patch)} → ${JSON.stringify(r.errors)}`);
    };
    bad({ round: 3 }, /round: 1 또는 2/);
    bad({ maxLength: 301 }, /maxLength: 5~300/);
    bad({ maxLength: 4 }, /maxLength: 5~300/);
    bad({ maxLength: 120.5 }, /maxLength/);
    bad({ level: 3 }, /level/);
    bad({ prompts: [] }, /prompts: 고쳐 쓸 문장 목록/);
    bad({ prompts: [{ id: 'a', text: '가' }, { id: 'a', text: '나' }] }, /중복/);
    bad({ prompts: [{ id: 'a', text: '' }] }, /text: 문장이 필요/);
    bad({ checks: ['좋음', ''] }, /checks/);
    bad({ prompts: [{ id: 'a', text: '<i>기울임</i>' }] }, /허용하지 않는 HTML 태그/);
    bad({ answers: ['x'] }, /비밀 파일/);
    // round·maxLength·level·checks 는 없어도 된다
    const { round: _r, maxLength: _m, level: _l, checks: _c, ...min } = clone(R1);
    assert.deepEqual(validatePublic('busan-x', pub([min])).errors, []);
  });

  it('짝(pairOf): 같은 연수의 1차 rewrite 이고, 문장 id 가 같아야 한다', () => {
    const errs = (acts) => validatePublic('busan-x', pub(acts)).errors;
    assert.ok(errs([R1, { ...R2, pairOf: 'nope' }]).some((e) => /pairOf: 같은 연수/.test(e)));
    assert.ok(errs([R1, { ...R2, pairOf: 'rewrite2' }]).some((e) => /pairOf: 같은 연수/.test(e)));
    assert.ok(errs([{ ...R1, round: 2, pairOf: undefined }, { ...R2 }]).some((e) => /1차\(round 1\) rewrite 활동이 아닙니다/.test(e)));
    assert.ok(errs([{ ...R1, pairOf: 'rewrite2' }, R2]).some((e) => /2차\(round 2\) 활동에만/.test(e)));
    const other = { ...R2, prompts: [PROMPTS[0], { id: 'c', text: '다른 문장' }] };
    assert.ok(errs([R1, other]).some((e) => /문장 id 가 같아야/.test(e)));
    const ox = { id: 'ox', type: 'ox', title: 'OX', questions: ['하나'] };
    assert.ok(errs([ox, { ...R2, pairOf: 'ox' }]).some((e) => /rewrite 활동이 아닙니다/.test(e)));
    // 글만 다르면 경고
    const w = validatePublic('busan-x', pub([R1, { ...R2, prompts: [PROMPTS[0], { id: 'b', text: '고친 글' }] }]));
    assert.deepEqual(w.errors, []);
    assert.ok(w.warnings.some((x) => /문장 글이 다릅니다/.test(x)));
  });

  it('2차에 pairOf 가 없으면 앞쪽 1차와 짝짓고(경고), 앞에 1차가 없으면 오류', () => {
    const { pairOf: _p, ...noPair } = R2;
    const ok = validatePublic('busan-x', pub([R1, noPair]));
    assert.deepEqual(ok.errors, []);
    assert.ok(ok.warnings.some((x) => /앞쪽의 1차 활동 "rewrite1"/.test(x)));
    const bad = validatePublic('busan-x', pub([noPair, R1]));
    assert.ok(bad.errors.some((e) => /pairOf 가 필요|pairOf\)가 필요/.test(e)), JSON.stringify(bad.errors));
  });
});

describe('rewrite payload 정리 (tidy)', () => {
  it('앞뒤 공백을 떼고, 줄 바꿈·연속 공백은 공백 하나로', () => {
    const r = tidy(R1, { prompt: 'a', text: '  학생이\n\n예상 독자의   질문을\t미리 적고 답함.  ', extra: 1 });
    assert.deepEqual(r, { ok: true, payload: { prompt: 'a', text: '학생이 예상 독자의 질문을 미리 적고 답함.' } });
  });

  it('5자 이상, maxLength(기본 200) 이하 · 글자는 코드 포인트로 센다', () => {
    assert.equal(MIN, 5);
    assert.equal(MAX_DEFAULT, 200);
    assert.deepEqual(tidy(R1, { prompt: 'a', text: '네 글자다' }), { ok: true, payload: { prompt: 'a', text: '네 글자다' } });
    assert.deepEqual(tidy(R1, { prompt: 'a', text: '네글자다' }), { ok: false, msg: '5자 이상 적어 주세요.' });
    assert.deepEqual(tidy(R1, { prompt: 'a', text: '   ' }), { ok: false, msg: '5자 이상 적어 주세요.' });
    assert.equal(tidy(R1, { prompt: 'a', text: '가'.repeat(200) }).ok, true);
    assert.deepEqual(tidy(R1, { prompt: 'a', text: '가'.repeat(201) }), { ok: false, msg: '200자 이내로 적어 주세요.' });
    const short = { ...R1, maxLength: 20 };
    assert.equal(maxOf(short), 20);
    assert.deepEqual(tidy(short, { prompt: 'a', text: '가'.repeat(21) }), { ok: false, msg: '20자 이내로 적어 주세요.' });
    // 이모지 하나는 한 글자(코드 포인트)
    assert.equal(tidy(short, { prompt: 'a', text: '😀'.repeat(20) }).ok, true);
    // 틀린 maxLength 는 기본값
    for (const m of [0, 301, '200', 12.5, null]) assert.equal(maxOf({ maxLength: m }), 200, String(m));
  });

  it('모르는 문장·글이 아닌 값은 거부', () => {
    assert.deepEqual(tidy(R1, { prompt: 'z', text: '충분히 긴 문장' }), { ok: false, msg: '고쳐 쓸 문장을 골라 주세요.' });
    assert.deepEqual(tidy(R1, { text: '충분히 긴 문장' }), { ok: false, msg: '고쳐 쓸 문장을 골라 주세요.' });
    assert.deepEqual(tidy(R1, { prompt: 'a', text: 12345 }), { ok: false, msg: '고쳐 쓴 문장을 적어 주세요.' });
    assert.deepEqual(tidy(R1, null), { ok: false, msg: '고쳐 쓸 문장을 골라 주세요.' });
  });

  it('문장 찾기와 표시', () => {
    assert.equal(promptOf(R1, 'b').text, PROMPTS[1].text);
    assert.equal(promptOf(R1, 'x'), null);
    assert.equal(promptLabel('a'), 'A');
  });
});

describe('1차·2차 짝', () => {
  const EVENT = { activities: [{ id: 'ox', type: 'ox' }, R1, R2] };
  const row = (pid, text, created, updated = created, prompt = 'a') =>
    ({ participant_id: pid, payload: { prompt, text }, created_at: created, updated_at: updated });

  it('짝 활동 찾기: pairOf, 없으면 앞쪽에서 가장 가까운 1차', () => {
    assert.equal(pairOf(EVENT, R2).id, 'rewrite1');
    assert.equal(pairOf(EVENT, R1), null);
    const { pairOf: _p, ...noPair } = R2;
    const ev2 = { activities: [R1, { ...R1, id: 'r1b' }, noPair] };
    assert.equal(pairOf(ev2, noPair).id, 'r1b');
    assert.equal(pairOf({ activities: [noPair] }, noPair), null);
    assert.equal(pairOf(EVENT, { ...R2, pairOf: 'ox' }), null);
  });

  it('두 번 다 낸 사람만, 2차를 처음 낸 순서대로. 둘 중 하나를 다시 내면 key 가 바뀐다', () => {
    const first = [
      row('p1', '1차 하나', '2026-10-19T10:00:01Z'),
      row('p2', '1차 둘', '2026-10-19T10:00:02Z'),
      row('p3', '1차 셋', '2026-10-19T10:00:03Z')
    ];
    const second = [ // 최근 제출 순으로 온다
      row('p1', '2차 하나 고침', '2026-10-19T11:00:05Z', '2026-10-19T11:09:00Z'),
      row('p3', '2차 셋', '2026-10-19T11:00:02Z'),
      row('p9', '1차 없음', '2026-10-19T11:00:01Z')
    ];
    const pairs = pairRows(first, second);
    assert.deepEqual(pairs.map((x) => x.pid), ['p3', 'p1']);
    assert.equal(pairs[1].first.text, '1차 하나');
    assert.equal(pairs[1].second.text, '2차 하나 고침');
    const again = pairRows([{ ...first[0], updated_at: '2026-10-19T12:00:00Z' }, first[2]], second);
    assert.notEqual(again.find((x) => x.pid === 'p1').key, pairs[1].key);
    assert.equal(again.find((x) => x.pid === 'p3').key, pairs[0].key);
    assert.deepEqual(pairRows(null, null), []);
  });

  it('카드 순서: 처음 낸 순서(다시 내도 자리가 그대로)', () => {
    const rows = [
      row('p2', '둘', '2026-10-19T10:00:02Z', '2026-10-19T10:30:00Z'),
      row('p3', '셋', '2026-10-19T10:00:03Z'),
      row('p1', '하나', '2026-10-19T10:00:01Z')
    ];
    assert.deepEqual(byFirst(rows).map((r) => r.participant_id), ['p1', 'p2', 'p3']);
    // 같은 시각이면 참가자 id 순
    assert.deepEqual(byFirst([row('b', 'x', 't'), row('a', 'y', 't')]).map((r) => r.participant_id), ['a', 'b']);
  });
});

describe('어절 비교 (wordDiff · diffHTML)', () => {
  const added = (a, b) => wordDiff(a, b).filter((t) => t.added).map((t) => t.w);

  it('같으면 새 어절이 없다', () => {
    assert.deepEqual(added('예상 독자를 고려함.', '예상 독자를 고려함.'), []);
  });

  it('새로 넣은 어절과 바꾼 어절만 표시한다', () => {
    const a = '예상 독자를 매우 잘 고려하여 건의문을 훌륭하게 작성함.';
    const b = '예상 독자가 물을 만한 질문을 두 가지 이상 미리 적고 건의문에서 답함.';
    assert.deepEqual(added(a, b), ['독자가', '물을', '만한', '질문을', '두', '가지', '이상', '미리', '적고', '건의문에서', '답함.']);
    assert.deepEqual(wordDiff(a, b)[0], { w: '예상', added: false });
    // 지우기만 하면 새 어절 없음
    assert.deepEqual(added(a, '예상 독자를 고려하여 건의문을 작성함.'), []);
  });

  it('자리를 옮긴 어절은 순서가 맞는 쪽만 그대로로 본다', () => {
    assert.deepEqual(added('가 나 다', '다 가 나'), ['다']);
  });

  it('1차가 비어 있으면 모두 새것, 공백·줄 바꿈 차이는 무시', () => {
    assert.deepEqual(added('', '새 문장'), ['새', '문장']);
    assert.deepEqual(added('학생이  질문을\n적음', ' 학생이 질문을 적음 '), []);
  });

  it('HTML: 붙어 있는 새 어절은 <mark> 하나로, 참가자 글은 이스케이프', () => {
    assert.equal(diffHTML('가 나 다', '가 <b>새</b> 말 다'), '가 <mark>&lt;b&gt;새&lt;/b&gt; 말</mark> 다');
    assert.equal(diffHTML('가 나', '가 나'), '가 나');
  });
});

describe('rewrite 부품', () => {
  it('등록부에 있고 네 화면 함수가 있다', () => {
    const m = moduleFor('rewrite');
    assert.equal(m, rewrite);
    for (const k of ['participant', 'board', 'adminCard', 'adminResponse', 'adminCell', 'summary']) {
      assert.equal(typeof m[k], 'function', k);
    }
    assert.equal(m.summary(R1), '1차 · 문장 2개 가운데 하나');
    assert.equal(m.summary(R2), '2차 · 문장 2개 가운데 하나');
    // round 를 비우면(1차·2차로 나누지 않는 연수) 차수를 붙이지 않는다
    const { round: _r, ...solo } = R1;
    assert.equal(m.summary(solo), '문장 2개 가운데 하나');
  });

  it('관리자 카드: 문장별 수와 비율, 1·2차 모두 낸 수, 최근 제출(이스케이프)', () => {
    const rows = [
      { participant_id: 'p1', payload: { prompt: 'a', text: '<script>최근</script> 문장' }, created_at: 't2', updated_at: 't2' },
      { participant_id: 'p2', payload: { prompt: 'b', text: '둘째 문장입니다' }, created_at: 't1', updated_at: 't1' },
      { participant_id: 'p3', payload: { prompt: 'a', text: '셋째 문장입니다' }, created_at: 't0', updated_at: 't0' }
    ];
    const first = [{ participant_id: 'p1', payload: { prompt: 'a', text: '1차' } }];
    const html = rewrite.adminCard({
      event: { activities: [R1, R2] }, activity: R2, rows, rowsOf: (id) => (id === 'rewrite1' ? first : [])
    });
    assert.match(html, /A <b>2<\/b>\(67%\) · B <b>1<\/b>\(33%\)/);
    assert.match(html, /1·2차 모두 <b>1<\/b>명/);
    assert.match(html, /&lt;script&gt;최근/);
    assert.doesNotMatch(html, /<script>/);
    assert.equal(rewrite.adminCard({ event: {}, activity: R1, rows: [] }), '');
    assert.equal(rewrite.adminCell({ activity: R1 }, rows[1]), 'B');
  });

  it('관리자 응답: 2차는 1차에서 새로 넣은 말을 표시한다', () => {
    const row = { participant_id: 'p1', payload: { prompt: 'a', text: '학생이 질문을 미리 적음' } };
    const html = rewrite.adminResponse({
      event: { activities: [R1, R2] }, activity: R2,
      rowsOf: () => [{ participant_id: 'p1', payload: { prompt: 'a', text: '학생이 잘 적음' } }]
    }, row);
    assert.match(html, /<mark>질문을 미리<\/mark>/);
  });
});

describe('rewrite 과제 맥락 (context · element)', () => {
  const CTX = {
    case: '슬기로운 환경 시민 프로젝트 · 2022 고1 국어',
    task: '개인 과제 · 학교 환경 정책 건의문',
    standard: { code: '[10공국1-03-01]', text: '사회적 쟁점에 대한 자신의 견해를 정교하게 표현하는 글을 쓴다.' },
    grasps: [{ key: 'G', name: '목표', text: '정책을 제안한다' }, { key: 'A', name: '청중', text: '행정실장님 <script>' }],
    guide: { title: '성취기준 해설', lead: '해설이 없어 옮깁니다.', items: ['고려 사항 하나'], source: '별책 5' },
    levels: { items: [{ level: 'A', text: '정교하게 쓸 수 있다.' }, { level: 'E', text: '견해를 표현하는 글을 쓴다.' }], source: '평가원' },
    note: '2015 개정으로 한 수업'
  };
  // 형식 검사용: 화면 이스케이프 시험에 쓴 <script> 는 설정 검사에서 막히므로 뺀다
  const CLEAN = { ...clone(CTX), grasps: [{ key: 'G', name: '목표', text: '정책을 제안한다' }] };
  const withCtx = (patch = {}) => ({ ...clone(R1), context: { ...clone(CLEAN), ...patch } });

  it('맥락 HTML: 성취기준은 늘 보이고, GRASPS·해설·성취수준은 펼침 칸. 설정 문구도 이스케이프', async () => {
    const { contextHTML } = await import('../../assets/activities/rewrite.js');
    const html = contextHTML(CTX, { grasps: true });
    assert.match(html, /<b>\[10공국1-03-01\]<\/b>/);
    assert.match(html, /<details class="rw-more" data-sec="grasps" open><summary>수행과제 · GRASPS<\/summary>/);
    assert.match(html, /<details class="rw-more" data-sec="guide"><summary>성취기준 해설<\/summary>/);
    assert.match(html, /<details class="rw-more" data-sec="levels"><summary>성취수준 A~E<\/summary>/);
    assert.match(html, /<dt><b>A<\/b>청중<\/dt><dd>행정실장님 &lt;script&gt;<\/dd>/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /2015 개정으로 한 수업/);
    // 칸 이름을 적으면 그것으로(2015 개정 평가기준 상·중·하)
    const t15 = contextHTML({ ...CTX, levels: { title: '평가기준 상·중·하', items: [{ level: '상', text: '가' }, { level: '하', text: '나' }] } });
    assert.match(t15, /<summary>평가기준 상·중·하<\/summary>/);
    assert.equal(contextHTML(undefined), '');
    assert.equal(contextHTML('맥락'), '');
    // 없는 칸은 그리지 않는다
    const bare = contextHTML({ case: '사례만' });
    assert.match(bare, /사례만/);
    assert.doesNotMatch(bare, /details|rw-std/);
  });

  it('평가 요소 HTML: 있을 때만', async () => {
    const { elementHTML } = await import('../../assets/activities/rewrite.js');
    assert.equal(elementHTML({ id: 'a', text: '문장', element: '예상 독자를 고려했는가?' }),
      '<span class="rw-el"><span class="rw-el-l">평가 요소</span>예상 독자를 고려했는가?</span>');
    assert.equal(elementHTML({ id: 'a', text: '문장' }), '');
    assert.equal(elementHTML(null), '');
  });

  it('형식 검사: 맥락과 평가 요소는 통과, 틀린 모양은 막는다', () => {
    const ok = validatePublic('busan-x', pub([withCtx()]));
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.warnings, []);
    const e = (a) => validatePublic('busan-x', pub([a])).errors;
    const has = (a, re) => assert.ok(e(a).some((x) => re.test(x)), `${JSON.stringify(a.context || a.prompts)} → ${JSON.stringify(e(a))}`);
    has({ ...clone(R1), context: '맥락' }, /context: 객체여야/);
    has(withCtx({ case: 3 }), /context\.case: 문자열/);
    has(withCtx({ standard: { code: '[x]' } }), /context\.standard: /);
    has(withCtx({ grasps: [] }), /context\.grasps: /);
    has(withCtx({ grasps: [{ key: 'GOAL!', text: '목표' }] }), /grasps\[0\]\.key: 4자 이내/);
    has(withCtx({ grasps: [{ key: 'G' }] }), /grasps\[0\]: 내용\(text\)/);
    has(withCtx({ guide: { items: [] } }), /context\.guide: /);
    has(withCtx({ guide: { items: ['가'], source: 1 } }), /guide\.source: 문자열/);
    has(withCtx({ levels: { items: [{ level: 'A' }] } }), /levels\.items\[0\]: /);
    has(withCtx({ levels: { items: [{ level: '', text: '가' }] } }), /levels\.items\[0\]: /);
    has(withCtx({ note: 1 }), /context\.note: 문자열/);
    has(withCtx({ levels: { title: 3, items: [{ level: '상', text: '가' }] } }), /levels\.title: 문자열/);
    has({ ...clone(R1), prompts: [{ id: 'a', text: '문장', element: ' ' }] }, /prompts\[0\]\.element: /);
    has(withCtx({ case: '<i>기울임</i>' }), /허용하지 않는 HTML 태그 <i>/);
    const w = validatePublic('busan-x', pub([withCtx({ extra: 1 })])).warnings;
    assert.ok(w.some((x) => /context: 알 수 없는 칸 "extra"/.test(x)));
  });
});
