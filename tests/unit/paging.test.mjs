/**
 * 현황판 카드 넘김 (명세 4): 쪽 나누기 계산
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paginate, pageOf, clampPage, pagerHTML, freshKeys, FRESH_MS } from '../../assets/paging.js';

describe('쪽 나누기 (paginate)', () => {
  it('가장 짧은 칸부터 채우고, 들어가지 않으면 새 쪽', () => {
    // 칸 높이 35, 간격 5: 높이 10 카드는 한 칸에 둘(10+5+10=25, 셋이면 40)
    const pages = paginate(new Array(7).fill(10), { cols: 3, height: 35, gap: 5 });
    assert.deepEqual(pages, [
      [[0, 3], [1, 4], [2, 5]],
      [[6], [], []]
    ]);
  });

  it('높이가 다르면 짧은 칸에 먼저 넣는다(같으면 왼쪽)', () => {
    const pages = paginate([30, 10, 10, 10, 10], { cols: 2, height: 40, gap: 0 });
    assert.deepEqual(pages, [[[0, 4], [1, 2, 3]]]);
  });

  it('칸보다 긴 카드는 빈 칸에 혼자 들어간다', () => {
    assert.deepEqual(paginate([100, 10], { cols: 1, height: 50 }), [[[0]], [[1]]]);
    assert.deepEqual(paginate([10, 100], { cols: 1, height: 50 }), [[[0]], [[1]]]);
  });

  it('카드가 없으면 쪽도 없다', () => {
    assert.deepEqual(paginate([], { cols: 3, height: 100 }), []);
  });

  it('뒤에 카드가 붙어도 앞쪽은 그대로다(보고 있는 쪽이 튀지 않는다)', () => {
    const hs = Array.from({ length: 100 }, (_, i) => 20 + ((i * 37) % 60));
    const all = paginate(hs, { cols: 3, height: 300, gap: 8 });
    for (let k = 1; k <= hs.length; k++) {
      const part = paginate(hs.slice(0, k), { cols: 3, height: 300, gap: 8 });
      assert.deepEqual(part.slice(0, -1), all.slice(0, part.length - 1), `k=${k}`);
    }
    // 모든 카드가 한 번씩, 순서대로 쪽에 들어간다
    const seen = all.flatMap((p) => p.flat()).sort((x, y) => x - y);
    assert.deepEqual(seen, hs.map((_, i) => i));
    assert.ok(all.length > 3);
  });

  it('카드가 든 쪽 찾기, 쪽 번호 범위', () => {
    const pages = paginate(new Array(7).fill(10), { cols: 3, height: 35, gap: 5 });
    assert.equal(pageOf(pages, 5), 0);
    assert.equal(pageOf(pages, 6), 1);
    assert.equal(pageOf(pages, 9), -1);
    assert.equal(clampPage(5, 2), 1);
    assert.equal(clampPage(-1, 2), 0);
    assert.equal(clampPage(0, 0), 0);
  });

  it('쪽 표시: 2/5쪽과 전체 수, 쪽이 하나면 넘김 단추가 없다', () => {
    const h = pagerHTML(1, 5, 87);
    assert.match(h, /<b>2<\/b> \/ 5쪽 · 87장/);
    assert.match(h, /data-turn="-1"/);
    assert.match(h, /data-turn="1"/);
    const one = pagerHTML(0, 1, 4);
    assert.doesNotMatch(one, /data-turn/);
    assert.match(one, /4장/);
    assert.match(pagerHTML(4, 5, 87), /data-turn="1" aria-label="다음 쪽" disabled/);
  });

  it('새 카드 강조는 sentence 와 같은 규칙', () => {
    const seen = new Map();
    assert.deepEqual([...freshKeys(seen, ['a'], 1000, { first: true })], []);
    assert.deepEqual([...freshKeys(seen, ['a', 'b'], 2000)], ['b']);
    assert.deepEqual([...freshKeys(seen, ['a', 'b'], 2000 + FRESH_MS)], []);
  });
});
