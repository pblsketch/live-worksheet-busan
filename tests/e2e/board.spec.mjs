/**
 * 현황판(board.html) E2E: PC 폭(1920×1080)
 *
 * 시험 연수를 events/sample.json 으로 등록하고(ox1 · practice(stage_check) · pledge(sentence)),
 * 서버 함수(lwb_admin_set · lwb_join · lwb_submit)로 가짜 응답을 넣은 뒤 현황판을 확인한다.
 *   - 네 화면(ox · stage_check · sentence · 제출 현황)을 ← → 로 넘기고, &v= 로 바로 연다
 *   - stage_check: ↓ 로 보기를 바꾸면 그 학습목표의 수로 바뀌고, 직접 적은 목표 묶음에 적은 문장이 보인다
 *   - 판단 갈림: 일부러 갈라 놓은 항목에만 붙고, 몰린 항목에는 붙지 않는다(보기마다 따로 계산)
 *   - ox: 공개 전에는 정답·점수·패널이 어디에도 없고, reveal 을 Y 로 켜면 정답 테두리와 패널 성적표가 나온다
 *   - sentence: 처음 낸 순서로 쌓이고, 새로 낸 문장이 새로고침 없이 노란 테두리로 끝에 붙는다(쪽 표시)
 * 시험 연수는 실패해도 afterAll 에서 지운다.
 */
import { test, expect } from '@playwright/test';
import { createTestEvent, deleteTestEvent, seeder } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1920, height: 1080 } });

let EV = null;
const P = {}; // 이름표 → 참가자 id

// 참가자 아홉. P1 이름에는 태그를 넣어 이스케이프를 확인한다
const NAMES = {
  p1: '<i>시험</i>하나', p2: '시험 참가자 둘', p3: '시험 참가자 셋', p4: '시험 참가자 넷', p5: '시험 참가자 다섯',
  p6: '시험 참가자 여섯', p7: '시험 참가자 일곱', p8: '시험 참가자 여덟', p9: '시험 참가자 아홉'
};

// 학습목표: p1~p5 obj-a, p6·p7 obj-b, p8·p9 직접 적기
// topic : obj-a 다섯은 1~5단계로 흩어지고 나머지 넷은 1단계 → 전체에서는 1단계로 몰림(5/9), obj-a 에서는 갈림
// research: 모두 3단계 → 어디서도 갈림 아님
// draft : 2단계 셋 · 4단계 셋 · 5단계 셋 → 전체에서만 갈림(obj-a 에서는 두 단계뿐)
const STAGE = {
  p1: { obj: { id: 'obj-a' }, topic: 1, draft: 2 },
  p2: { obj: { id: 'obj-a' }, topic: 2, draft: 2 },
  p3: { obj: { id: 'obj-a' }, topic: 3, draft: 2 },
  p4: { obj: { id: 'obj-a' }, topic: 4, draft: 4 },
  p5: { obj: { id: 'obj-a' }, topic: 5, draft: 4 },
  p6: { obj: { id: 'obj-b' }, topic: 1, draft: 4 },
  p7: { obj: { id: 'obj-b' }, topic: 1, draft: 5 },
  p8: { obj: { id: 'custom', text: '시험 직접 목표 하나' }, topic: 1, draft: 5 },
  p9: { obj: { id: 'custom', text: '시험 직접 목표 둘' }, topic: 1, draft: 5 }
};
const MEMO_P1 = '시험메모 <b>굵게</b>';

// OX 정답(샘플 비밀)은 O·X·O. 맞힌 수: p1 3, p2 2, p3 0, p4 3, p5 1, p6 2 → 평균 11/6 ≈ 1.8
const OX = {
  p1: ['O', 'X', 'O'], p2: ['O', 'O', 'O'], p3: ['X', 'O', 'X'],
  p4: ['O', 'X', 'O'], p5: ['X', 'X', 'X'], p6: ['O', 'X', 'X']
};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  EV = await createTestEvent('brd');
  const s = seeder(EV);
  for (const a of ['ox1', 'practice', 'pledge']) await s.open(a);
  for (const [k, name] of Object.entries(NAMES)) P[k] = await s.join(name);
  for (const [k, v] of Object.entries(STAGE)) {
    await s.submit(P[k], 'practice', {
      objective: v.obj,
      items: {
        topic: { risk: '상', stage: v.topic, memo: k === 'p1' ? MEMO_P1 : '' },
        research: { risk: '중', stage: 3, memo: k === 'p8' ? '시험메모 직접' : '' },
        draft: { risk: '하', stage: v.draft, memo: '' }
      }
    });
  }
  for (const [k, answers] of Object.entries(OX)) await s.submit(P[k], 'ox1', { answers });
  await s.submit(P.p1, 'pledge', { template: 'student', blank: '시험 문장 하나' });
  await s.submit(P.p2, 'pledge', { template: 'teacher', blank: '시험 문장 둘' });
});

test.afterAll(async () => {
  if (EV) await deleteTestEvent(EV.id);
});

/** 현황판을 열고 자바스크립트 오류를 모은다 */
async function openBoard(page, query) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`./board.html?e=${EV.id}${query || ''}`);
  return errors;
}

test('없는 연수는 "연수를 찾을 수 없습니다"', async ({ page }) => {
  await page.goto('./board.html?e=no-such-event-x');
  await expect(page.locator('.blank h2')).toHaveText('연수를 찾을 수 없습니다');
});

test('네 화면을 ← → 로 넘기고, &v= 로 바로 연다 · 연결 상태 · 제출 현황', async ({ page }) => {
  const errors = await openBoard(page);
  const body = page.locator('body');

  // v 가 없으면 첫 화면(ox)
  await expect(body).toHaveAttribute('data-screen', 'ox');
  await expect(page.locator('.oxq')).toHaveCount(3);
  await expect(page.locator('#barCount b')).toHaveText('6');
  // 오른쪽 위 연결 상태
  await expect(page.locator('#conn [data-conn="live"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#conn')).toContainText('실시간');

  await page.keyboard.press('ArrowRight');
  await expect(body).toHaveAttribute('data-screen', 'stage_check');
  await expect(page.locator('.hm')).toBeVisible();
  await expect(page).toHaveURL(/[?&]v=2(&|$)/);

  await page.keyboard.press('ArrowRight');
  await expect(body).toHaveAttribute('data-screen', 'sentence');
  await expect(page.locator('.sncard')).toHaveCount(2);

  await page.keyboard.press('ArrowRight');
  await expect(body).toHaveAttribute('data-screen', 'status');
  await expect(page).toHaveURL(/[?&]v=4(&|$)/);

  // 제출 현황: 활동별 게이지 + 이름 칩(점 = 그 활동을 냄)
  await expect(page.locator('.gauge')).toHaveCount(3);
  await expect(page.locator('[data-gauge="ox1"] .v b')).toHaveText('6');
  await expect(page.locator('[data-gauge="practice"] .v b')).toHaveText('9');
  await expect(page.locator('[data-gauge="pledge"] .v b')).toHaveText('2');
  await expect(page.locator('#barCount b')).toHaveText('9');
  await expect(page.locator('.chip')).toHaveCount(9);
  await expect(page.locator('.chip.all')).toHaveCount(2);
  const c1 = page.locator(`[data-person="${P.p1}"]`);
  await expect(c1.locator('.cn')).toHaveText(NAMES.p1); // 이름의 태그는 글자 그대로
  await expect(c1.locator('.cn i')).toHaveCount(0);
  await expect(page.locator(`[data-person="${P.p3}"] .dots i.on`)).toHaveCount(2);
  await expect(page.locator(`[data-person="${P.p9}"] .dots i.on`)).toHaveCount(1);

  // 끝에서 한 번 더 넘기면 처음으로, 왼쪽은 반대로
  await page.keyboard.press('ArrowRight');
  await expect(body).toHaveAttribute('data-screen', 'ox');
  await page.keyboard.press('ArrowLeft');
  await expect(body).toHaveAttribute('data-screen', 'status');

  // 화면 아래 버튼으로도 넘긴다
  await page.locator('.nav-list [data-go="2"]').click();
  await expect(body).toHaveAttribute('data-screen', 'sentence');

  // F: 전체화면(헤드리스에서는 거절될 수 있다. 오류 없이 넘어가야 한다)
  await page.keyboard.press('f');

  // &v= 로 바로 열기
  for (const [v, screen] of [['3', 'sentence'], ['2', 'stage_check'], ['4', 'status'], ['9', 'ox']]) {
    await page.goto(`./board.html?e=${EV.id}&v=${v}`);
    await expect(body).toHaveAttribute('data-screen', screen);
  }
  expect(errors).toEqual([]);
});

test('stage_check: 보기 전환(↓ · 버튼), 보기별 수와 판단 갈림, 직접 적은 목표, 메모와 이름', async ({ page }) => {
  const errors = await openBoard(page, '&v=2');
  const sc = page.locator('.sc');
  const cell = (item, stage) => page.locator(`[data-cell="${item}:${stage}"]`);
  const flag = (item) => page.locator(`.hm-it[data-item="${item}"] .flag`);

  // 보기 목록: 전체 → 학습목표(설정 순서) → 직접 적은 목표, 수는 그 보기의 응답 수
  await expect(page.locator('.vt')).toHaveCount(4);
  await expect(page.locator('.vt[data-view="all"] .vn')).toHaveText('9');
  await expect(page.locator('.vt[data-view="o:obj-a"] .vn')).toHaveText('5');
  await expect(page.locator('.vt[data-view="o:obj-a"] .vl')).toHaveText('교과군 가');
  await expect(page.locator('.vt[data-view="o:obj-b"] .vn')).toHaveText('2');
  await expect(page.locator('.vt[data-view="custom"] .vn')).toHaveText('2');

  // 전체: topic 은 1단계로 몰림(5명) → 갈림 아님, draft 는 갈림, research 는 한 단계
  await expect(sc).toHaveAttribute('data-view', 'all');
  await expect(cell('topic', 1)).toHaveText('5');
  await expect(cell('research', 3)).toHaveText('9');
  await expect(cell('draft', 2)).toHaveText('3');
  await expect(flag('draft')).toHaveText('판단 갈림');
  await expect(flag('topic')).toHaveCount(0);
  await expect(flag('research')).toHaveCount(0);
  await expect(page.locator('.hm-it.split')).toHaveCount(1);
  // 위험 분포
  await expect(page.locator('[data-risk="topic"] .h')).toHaveText('9');
  // 메모는 이름과 함께, 참가자 글은 이스케이프
  const m1 = page.locator('.memo', { hasText: '시험메모 <b>굵게</b>' });
  await expect(m1.locator('.mt')).toHaveText(MEMO_P1);
  await expect(m1.locator('.mt b')).toHaveCount(0);
  await expect(m1.locator('.mn')).toHaveText(NAMES.p1);
  await expect(m1.locator('.mi')).toHaveText('탐구 주제 정하기');

  // ↓ → 학습목표 obj-a: 그 목표를 고른 다섯 명만으로 센다. topic 이 갈림, draft 는 아님
  await page.keyboard.press('ArrowDown');
  await expect(sc).toHaveAttribute('data-view', 'o:obj-a');
  await expect(page.locator('.sc-obj .ot')).toHaveText('탐구 질문을 세우고 자료를 근거로 답을 찾는다.');
  await expect(page.locator('.sc-obj .oc')).toHaveText('[예시01-01]');
  for (const n of [1, 2, 3, 4, 5]) await expect(cell('topic', n)).toHaveText('1');
  await expect(cell('research', 3)).toHaveText('5');
  await expect(cell('draft', 2)).toHaveText('3');
  await expect(cell('draft', 4)).toHaveText('2');
  await expect(flag('topic')).toHaveText('판단 갈림');
  await expect(flag('draft')).toHaveCount(0);
  await expect(page.locator('.memo')).toHaveCount(1); // obj-a 의 메모는 p1 것 하나

  // ↓ → obj-b(두 명): 갈림 없음
  await page.keyboard.press('ArrowDown');
  await expect(sc).toHaveAttribute('data-view', 'o:obj-b');
  await expect(cell('topic', 1)).toHaveText('2');
  await expect(cell('topic', 2)).toHaveText('·');
  await expect(page.locator('.flag')).toHaveCount(0);

  // ↓ → 직접 적은 목표: 적은 문장과 이름
  await page.keyboard.press('ArrowDown');
  await expect(sc).toHaveAttribute('data-view', 'custom');
  await expect(page.locator('.cobj')).toHaveCount(2);
  await expect(page.locator('.cobj', { hasText: '시험 직접 목표 하나' }).locator('.cn')).toHaveText(NAMES.p8);
  await expect(page.locator('.cobj', { hasText: '시험 직접 목표 둘' }).locator('.cn')).toHaveText(NAMES.p9);
  await expect(cell('topic', 1)).toHaveText('2');
  await expect(cell('draft', 5)).toHaveText('2');
  await expect(page.locator('.memo .mt')).toHaveText(['시험메모 직접']);

  // ↓ 한 번 더 → 처음(전체)으로, ↑ → 끝(직접 적은 목표)
  await page.keyboard.press('ArrowDown');
  await expect(sc).toHaveAttribute('data-view', 'all');
  await page.keyboard.press('ArrowUp');
  await expect(sc).toHaveAttribute('data-view', 'custom');

  // 화면 버튼으로도 바꾼다
  await page.locator('.vt[data-view="o:obj-a"]').click();
  await expect(sc).toHaveAttribute('data-view', 'o:obj-a');
  await expect(page.locator('.vt[data-view="o:obj-a"]')).toHaveAttribute('aria-selected', 'true');

  // 다른 화면에 갔다 와도 보던 보기가 남는다
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.sc')).toHaveAttribute('data-view', 'o:obj-a');
  expect(errors).toEqual([]);
});

test('ox: 공개 전에는 정답·점수·패널이 없고, reveal 을 켜면 새로고침 없이 정답 테두리와 패널 성적표', async ({ page }) => {
  const errors = await openBoard(page, '&v=1');
  let loads = 0;
  page.on('load', () => { loads++; });
  const q = (n) => page.locator(`.oxq[data-q="${n}"]`);

  // 막대와 인원
  await expect(page.locator('.oxq')).toHaveCount(3);
  await expect(q(1).locator('[data-seg="O"]')).toContainText('O 67%');
  await expect(q(1).locator('[data-seg="O"] small')).toHaveText('4명');
  await expect(q(1).locator('[data-seg="X"] small')).toHaveText('2명');
  await expect(q(2).locator('[data-seg="X"]')).toContainText('X 67%');
  await expect(q(3).locator('[data-seg="O"]')).toContainText('O 50%');
  await expect(page.locator('#barCount b')).toHaveText('6');

  // 공개 전: 정답·라벨·해설·점수·패널이 어디에도 없다
  await expect(page.locator('.ox')).not.toHaveClass(/\brv\b/);
  await expect(page.locator('.right')).toHaveCount(0);
  await expect(page.locator('.ans')).toHaveCount(0);
  await expect(page.locator('.ox-side, .oxpanel, .ours, .dist')).toHaveCount(0);
  await expect(page.locator('.bar .pill.rv')).toHaveCount(0);
  const before = await page.locator('body').innerText();
  for (const t of ['정답', '시험라벨', '시험해설', '시험패널', '평균', '맞힘']) {
    expect(before.includes(t), `공개 전 화면에 "${t}"`).toBe(false);
  }

  await page.evaluate(() => { window.__lwSamePage = true; });
  await seeder(EV).set('reveal:ox1', 'Y');

  // 공개 뒤: 정답 테두리(O·X·O), 정답 표시와 해설, 패널 성적표(점수는 화면이 계산)
  await expect(page.locator('.ox.rv')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.right')).toHaveCount(3);
  await expect(q(1).locator('[data-seg="O"]')).toHaveClass(/\bright\b/);
  await expect(q(2).locator('[data-seg="X"]')).toHaveClass(/\bright\b/);
  await expect(q(3).locator('[data-seg="O"]')).toHaveClass(/\bright\b/);
  await expect(q(1).locator('.ans')).toHaveText('정답 O · 시험라벨AI');
  await expect(q(2).locator('.ans')).toHaveText('정답 X · 시험라벨사람');
  await expect(q(1).locator('.nt')).toHaveText('시험해설하나');
  const rows = page.locator('.oxpanel tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.nm')).toContainText('시험패널갑');
  await expect(rows.nth(0).locator('.sum')).toHaveText('2/3');
  await expect(rows.nth(1).locator('.nm')).toContainText('시험패널을');
  await expect(rows.nth(1).locator('.sum')).toHaveText('0/3');
  await expect(page.locator('.ours .ov')).toContainText('1.8');
  await expect(page.locator('.ours .ol')).toHaveText('6명 평균');
  await expect(page.locator('.dist .dr b')).toHaveText(['2명', '2명', '1명', '1명']); // 3개·2개·1개·0개
  await expect(page.locator('.bar .pill.rv')).toHaveText('정답 공개');

  expect(await page.evaluate(() => window.__lwSamePage)).toBe(true);
  expect(loads).toBe(0);
  expect(errors).toEqual([]);
});

test('sentence: 3열 카드, 틀 라벨과 이름, 새 문장은 새로고침 없이 노란 테두리로 끝에 붙는다', async ({ page }) => {
  const errors = await openBoard(page, '&v=3');
  let loads = 0;
  page.on('load', () => { loads++; });

  await expect(page.locator('.sn-col')).toHaveCount(3);
  await expect(page.locator('.sncard')).toHaveCount(2);
  // 처음 낸 것이 먼저(첫 칸 맨 위), 다음 카드는 가장 짧은 칸(둘째 칸)으로
  const first = page.locator('.sn-col').nth(0).locator('.sncard').first();
  await expect(first.locator('.nm')).toHaveText(NAMES.p1);
  await expect(first.locator('.tag')).toHaveText('학생 쪽');
  await expect(first.locator('.tx b')).toHaveText('시험 문장 하나');
  await expect(page.locator('.sn-col').nth(1).locator('.sncard .nm')).toHaveText(NAMES.p2);
  await expect(page.locator('.sncard', { hasText: '시험 문장 둘' }).locator('.tag')).toHaveText('교사 쪽');
  await expect(page.locator('.sn-pg .pg')).toHaveText('2장');
  // 처음 열 때 있던 문장은 강조하지 않는다
  await expect(page.locator('.sncard.fresh')).toHaveCount(0);
  await expect(page.locator('.sn-t')).toHaveText(['학생 쪽1', '교사 쪽1']);

  await page.evaluate(() => { window.__lwSamePage = true; });
  await seeder(EV).submit(P.p3, 'pledge', { template: 'student', blank: '시험 새 문장' });

  const fresh = page.locator('.sncard.fresh');
  await expect(fresh).toHaveCount(1, { timeout: 30_000 });
  await expect(fresh.locator('.tx b')).toHaveText('시험 새 문장');
  await expect(fresh.locator('.nm')).toHaveText(NAMES.p3);
  await expect(page.locator('.sncard')).toHaveCount(3);
  await expect(page.locator('.sn-col').nth(2).locator('.sncard').first()).toHaveClass(/\bfresh\b/);
  await expect(page.locator('.sn-pg .pg')).toHaveText('3장');
  await expect(page.locator('#barCount b')).toHaveText('3');
  expect(await page.evaluate(() => window.__lwSamePage)).toBe(true);
  expect(loads).toBe(0);
  expect(errors).toEqual([]);
});
