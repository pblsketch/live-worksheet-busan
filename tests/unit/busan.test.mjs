/**
 * 부산 연수 설정 events/busan1019.json (명세 5, 2026-09-25 고침: 성장하길 · 삽화 · 과제 맥락 · 2차 뺌)
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { validatePublic, settingKeys } from '../../tools/lib/event-config.mjs';
import { pairOf } from '../../assets/activities/rewrite.js';

const PUB = JSON.parse(readFileSync(new URL('../../events/busan1019.json', import.meta.url), 'utf8'));
const act = (id) => PUB.activities.find((a) => a.id === id);

describe('busan1019 설정', () => {
  it('형식 검사를 경고 없이 통과한다', () => {
    const r = validatePublic('busan1019', PUB);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  it('연수 칸과 활동 순서: grow → ox → rewrite1 → pledge (고쳐 쓰기는 한 번)', () => {
    assert.equal(PUB.title, '배움이 깊어지는 학생평가');
    assert.equal(PUB.date, '2026-10-19');
    assert.equal(PUB.listed, true);
    assert.equal(PUB.description, '부산 교원 연수 · 2026. 10. 19.');
    assert.deepEqual(PUB.materials, []);
    assert.deepEqual(PUB.activities.map((a) => `${a.id}:${a.type}`),
      ['grow:sentence', 'ox:ox', 'rewrite1:rewrite', 'pledge:sentence']);
    assert.deepEqual(settingKeys(PUB), ['open:grow', 'open:ox', 'reveal:ox', 'open:rewrite1', 'open:pledge', 'materials_open']);
  });

  it('문장 틀: 앞말·뒷말·안내 문구 (① 은 ‘성장하길’, 슬라이드 3·4쪽과 같다)', () => {
    const grow = act('grow');
    assert.equal(grow.title, '학생이 어떤 사람으로 성장하길 바라시나요?');
    const [t] = grow.templates;
    assert.deepEqual([t.before, t.after, t.placeholder], ['나는 학생이', '사람으로 성장하길 바란다.', '예: 스스로 질문하는']);
    assert.doesNotMatch(JSON.stringify(grow), /자라길/);
    const [pledge] = act('pledge').templates;
    assert.deepEqual([pledge.before, pledge.after, pledge.placeholder], ['다음 학기 수행평가에서 나는', '', '예: 중간 피드백에서 점수를 말하지 않겠다']);
  });

  it('① 그림: 강의 슬라이드의 삽화 파일이 저장소에 있다', () => {
    const { image } = act('grow');
    assert.equal(image.src, 'assets/img/grow.jpg');
    assert.ok(image.alt.length > 0);
    assert.ok(existsSync(new URL(`../../${image.src}`, import.meta.url)));
  });

  it('ox: 문항 셋, O/X 설명', () => {
    const ox = act('ox');
    assert.equal(ox.questions.length, 3);
    assert.deepEqual(ox.choices, { O: 'AI가 썼다', X: '사람이 썼다' });
  });

  it('rewrite: 한 번만 쓰고(짝 없음), 문장마다 평가 요소, 과제 맥락(2015 성취기준·GRASPS·해설·평가기준)', () => {
    const r = act('rewrite1');
    assert.equal(r.round, undefined);
    assert.equal(pairOf(PUB, r), null);
    assert.equal(PUB.activities.filter((a) => a.type === 'rewrite').length, 1);
    assert.equal(r.level, '잘함');
    assert.equal(r.maxLength, 200);
    assert.equal(r.checks.length, 3);
    assert.deepEqual(r.prompts.map((p) => p.id), ['a', 'b']);
    assert.ok(r.prompts.every((p) => p.element && p.element.endsWith('?')));
    const c = r.context;
    assert.equal(c.standard.code, '[10국03-02]'); // 2015 개정(실제로 이 기준으로 한 수업)
    assert.doesNotMatch(JSON.stringify(c), /10공국/);
    assert.deepEqual(c.grasps.map((g) => g.key).join(''), 'GRASPS');
    assert.ok(c.guide.items.length >= 1 && c.guide.source);
    assert.equal(c.levels.title, '평가기준 상·중·하');
    assert.deepEqual(c.levels.items.map((x) => x.level), ['상', '중', '하']);
    assert.ok(c.levels.source);
  });
});
