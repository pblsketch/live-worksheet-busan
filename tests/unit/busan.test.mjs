/**
 * 부산 연수 설정 events/busan1019.json (명세 5)
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePublic, settingKeys } from '../../tools/lib/event-config.mjs';
import { pairOf } from '../../assets/activities/rewrite.js';

const PUB = JSON.parse(readFileSync(new URL('../../events/busan1019.json', import.meta.url), 'utf8'));

describe('busan1019 설정', () => {
  it('형식 검사를 경고 없이 통과한다', () => {
    const r = validatePublic('busan1019', PUB);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  it('연수 칸과 활동 순서: grow → ox → rewrite1 → rewrite2 → pledge', () => {
    assert.equal(PUB.title, '배움이 깊어지는 학생평가');
    assert.equal(PUB.date, '2026-10-19');
    assert.equal(PUB.listed, true);
    assert.equal(PUB.description, '부산 교원 연수 · 2026. 10. 19.');
    assert.deepEqual(PUB.materials, []);
    assert.deepEqual(PUB.activities.map((a) => `${a.id}:${a.type}`),
      ['grow:sentence', 'ox:ox', 'rewrite1:rewrite', 'rewrite2:rewrite', 'pledge:sentence']);
    assert.deepEqual(settingKeys(PUB), ['open:grow', 'open:ox', 'reveal:ox', 'open:rewrite1', 'open:rewrite2', 'open:pledge', 'materials_open']);
  });

  it('문장 틀: 앞말·뒷말·안내 문구', () => {
    const [grow] = PUB.activities[0].templates;
    assert.deepEqual([grow.before, grow.after, grow.placeholder], ['나는 학생이', '사람으로 자라길 바란다.', '예: 스스로 질문하는']);
    const [pledge] = PUB.activities[4].templates;
    assert.deepEqual([pledge.before, pledge.after, pledge.placeholder], ['다음 학기 수행평가에서 나는', '', '예: 중간 피드백에서 점수를 말하지 않겠다']);
  });

  it('ox: 문항 셋, O/X 설명', () => {
    const ox = PUB.activities[1];
    assert.equal(ox.questions.length, 3);
    assert.deepEqual(ox.choices, { O: 'AI가 썼다', X: '사람이 썼다' });
  });

  it('rewrite: 1차·2차가 같은 문장·점검 질문을 쓰고 짝지어진다', () => {
    const [, , r1, r2] = PUB.activities;
    assert.equal(r1.round, 1);
    assert.equal(r2.round, 2);
    assert.equal(r2.pairOf, 'rewrite1');
    assert.equal(pairOf(PUB, r2), r1);
    assert.deepEqual(r2.prompts, r1.prompts);
    assert.deepEqual(r2.checks, r1.checks);
    assert.equal(r1.checks.length, 3);
    assert.equal(r1.level, '잘함');
    assert.equal(r1.maxLength, 200);
  });
});
