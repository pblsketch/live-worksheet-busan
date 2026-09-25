/**
 * ox · sentence 현황판 계산 (순수 함수)
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { oxSummary, tally, scoreOf } from '../../assets/activities/ox.js';
import { sentenceCards, freshKeys, FRESH_MS, sentenceHTML, templateOf } from '../../assets/activities/sentence.js';

const OX = { id: 'ox1', type: 'ox', questions: ['하나', '둘', '셋'], choices: { O: 'AI', X: '사람' } };
const ans = (pid, answers) => ({ activity_id: 'ox1', participant_id: pid, payload: { answers } });
const ROWS = [
  ans('p1', ['O', 'X', 'O']), // 정답과 같으면 3
  ans('p2', ['O', 'O', 'O']), // 2
  ans('p3', ['X', 'O', 'X'])  // 0
];
const REVEAL = {
  answers: ['O', 'X', 'O'],
  labels: ['AI', '사람', '협업'],
  notes: ['해설1', '해설2', '해설3'],
  panel: [
    { name: '갑', desc: '설명', picks: ['O', 'O', 'O'], score: '9/9' }, // 적힌 score 는 무시하고 계산한다
    { name: '을', picks: ['X', 'X', 'X'] }
  ]
};

describe('ox 현황판 (oxSummary)', () => {
  it('공개 전: 막대 수치만 있고 정답·라벨·해설·점수·패널은 하나도 없다', () => {
    const s = oxSummary(OX, ROWS, null);
    assert.equal(s.total, 3);
    assert.equal(s.revealed, false);
    assert.equal(s.avg, null);
    assert.equal(s.dist, null);
    assert.deepEqual(s.panel, []);
    for (const q of s.questions) {
      assert.equal(q.right, null);
      assert.equal(q.label, '');
      assert.equal(q.note, '');
    }
    assert.deepEqual(s.questions.map((q) => [q.O, q.X, q.n, q.pO, q.pX]), [
      [2, 1, 3, 67, 33],
      [2, 1, 3, 67, 33],
      [2, 1, 3, 67, 33]
    ]);
    // 정답이 빠진 공개 내용(라벨만 있는 등)도 공개 전과 같다
    const half = oxSummary(OX, ROWS, { labels: ['AI', '사람', '협업'], panel: REVEAL.panel });
    assert.equal(half.revealed, false);
    assert.deepEqual(half.panel, []);
    assert.ok(half.questions.every((q) => q.label === '' && q.right === null));
  });

  it('공개 뒤: 정답·라벨·해설, 점수는 공개된 정답으로 화면에서 계산한다', () => {
    const s = oxSummary(OX, ROWS, REVEAL);
    assert.equal(s.revealed, true);
    assert.deepEqual(s.questions.map((q) => q.right), ['O', 'X', 'O']);
    assert.deepEqual(s.questions.map((q) => q.label), ['AI', '사람', '협업']);
    assert.deepEqual(s.questions.map((q) => q.note), ['해설1', '해설2', '해설3']);
    assert.equal(s.avg, (3 + 2 + 0) / 3);
    assert.deepEqual(s.dist, [1, 0, 1, 1]); // 0개 1명, 1개 0명, 2개 1명, 3개 1명
    assert.deepEqual(s.panel.map((p) => [p.name, p.score, p.marks]), [
      ['갑', 2, [true, false, true]],
      ['을', 1, [false, true, false]]
    ]);
    assert.equal(s.panel[1].desc, '');
  });

  it('응답이 없으면 인원 0, 공개 뒤 평균은 없음', () => {
    const s = oxSummary(OX, [], REVEAL);
    assert.equal(s.total, 0);
    assert.equal(s.avg, null);
    assert.deepEqual(s.dist, [0, 0, 0, 0]);
    assert.ok(s.questions.every((q) => q.n === 0 && q.pO === 0 && q.pX === 0));
    assert.equal(oxSummary(OX, null, null).total, 0);
  });

  it('O/X 가 아닌 값은 세지 않는다', () => {
    const t = tally(OX, [ans('p', ['O', 'Y', null])]);
    assert.deepEqual(t, [{ O: 1, X: 0 }, { O: 0, X: 0 }, { O: 0, X: 0 }]);
    assert.equal(scoreOf(['O', 'X'], null), null);
  });
});

describe('sentence 현황판', () => {
  const ACT = {
    templates: [
      { id: 'student', label: '학생 쪽', before: '나는 <b>학생</b>에게', after: '하게 하겠다.' },
      { id: 'teacher', label: '교사 쪽', before: '나는', after: '하겠다.' }
    ]
  };

  it('카드 목록: 처음 낸 순서(새 카드는 끝에 붙는다), 다시 내면 key 만 바뀌고 자리는 그대로', () => {
    // 응답은 최근 제출 순으로 온다
    const rows = [
      { participant_id: 'b', payload: { template: 'nope', blank: '하나' }, created_at: '2026-10-19T10:00:02Z', updated_at: '2026-10-19T10:00:02Z' },
      { participant_id: 'a', payload: { template: 'teacher', blank: '둘' }, created_at: '2026-10-19T10:00:01Z', updated_at: '2026-10-19T10:00:01Z' }
    ];
    const cards = sentenceCards(ACT, rows);
    assert.deepEqual(cards.map((c) => c.pid), ['a', 'b']);
    assert.deepEqual(cards.map((c) => c.key), ['a|2026-10-19T10:00:01Z', 'b|2026-10-19T10:00:02Z']);
    assert.equal(cards[0].template.id, 'teacher');
    assert.equal(cards[1].template, null);
    // a 가 다시 냄: 맨 앞에 오는 응답이지만 카드 자리는 그대로, key 는 바뀐다
    const again = sentenceCards(ACT, [{ ...rows[1], updated_at: '2026-10-19T10:05:00Z' }, rows[0]]);
    assert.deepEqual(again.map((c) => c.pid), ['a', 'b']);
    assert.notEqual(again[0].key, cards[0].key);
    assert.equal(again[1].key, cards[1].key);
  });

  it('문장 HTML: 설정 문구는 <b>만 살리고, 참가자 글은 이스케이프한다', () => {
    const html = sentenceHTML(templateOf(ACT, 'student'), '<img src=x onerror=1>');
    assert.equal(html, '나는 <b>학생</b>에게 <b>&lt;img src=x onerror=1&gt;</b> 하게 하겠다.');
  });

  it('새 문장 고르기: 처음 그릴 때 있던 것은 새것이 아니고, 뒤에 들어온 것만 잠깐 강조한다', () => {
    const seen = new Map();
    assert.deepEqual([...freshKeys(seen, ['k1', 'k2'], 1000, { first: true })], []);
    assert.deepEqual([...freshKeys(seen, ['k3', 'k1', 'k2'], 2000)], ['k3']);
    assert.deepEqual([...freshKeys(seen, ['k3', 'k1', 'k2'], 2000 + FRESH_MS - 1)], ['k3']);
    assert.deepEqual([...freshKeys(seen, ['k3', 'k1', 'k2'], 2000 + FRESH_MS)], []);
    // 다시 낸 문장(새 key)은 다시 새것이다
    assert.deepEqual([...freshKeys(seen, ['k1b', 'k3', 'k2'], 50000)], ['k1b']);
  });
});
