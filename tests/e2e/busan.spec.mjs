/**
 * 부산 판 E2E (명세 2·3·4): events/busan1019.json 의 활동으로 시험 연수를 만들어 확인한다
 *   1. 참가자(Zoom 옆 좁은 창 400px): rewrite 1차 고르기·쓰기(남은 글자, 점검 질문은 아래) → 2차는 1차 문장으로 채워 고쳐 쓰기
 *      → 제출 뒤 1차 | 2차 비교에 새 어절 표시. 360px 에서도 가로 스크롤이 없다
 *   2. 참가자(넓은 창): 점검 질문이 글상자 옆
 *   3. 현황판 rewrite1: 모아 보기 넘김(PageDown·↑), 이름은 기본으로 숨김(N), 문장별(0·1·2), 골라 띄우기(클릭·Enter, ← →, Esc)
 *   4. 현황판 rewrite2: 나란히 보기(두 번 다 낸 사람만, 새 어절 형광펜), V 로 모아 보기
 *   5. sentence 카드 100장: 모두 쪽으로 넘겨 볼 수 있고, 새 카드가 와도 보던 쪽이 그대로, ← → 는 화면 넘기기
 *   6. 실시간 구독(로컬 흉내 서버에서만): 참가자 기기는 진행 설정만, 현황판·관리자는 응답까지
 * 시험 연수는 실패해도 afterAll 에서 지운다.
 */
import { test, expect } from '@playwright/test';
import { createBusanTestEvent, deleteTestEvent, seeder } from './helpers.mjs';
import { restGet } from '../db/helpers.mjs';

test.describe.configure({ mode: 'serial' });

let EV = null;
let S = null;
const FULL = { viewport: { width: 1920, height: 1080 }, locale: 'ko-KR' };
const NARROW = { viewport: { width: 400, height: 820 }, locale: 'ko-KR' };
const LIVE = { timeout: 30_000 };
const PROMPT = {};

test.beforeAll(async () => {
  test.setTimeout(120_000);
  EV = await createBusanTestEvent('bsn');
  S = seeder(EV);
  for (const a of EV.pub.activities) if (a.type === 'rewrite') for (const p of a.prompts) PROMPT[p.id] = p.text;
});

test.afterAll(async () => {
  if (EV) await deleteTestEvent(EV.id);
});

async function joinAs(page, name) {
  await page.goto(`./?e=${EV.id}`);
  await page.locator('#nick').fill(name);
  await page.locator('#joinBtn').click();
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'menu');
}

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

/** 시험 참가자 n명을 만들어 활동에 낸다. text(i) 는 i 번째 글 */
async function seedMany(n, tag, activity, payloadOf) {
  const pids = [];
  for (let i = 0; i < n; i++) pids.push(await S.join(`${tag} ${String(i + 1).padStart(3, '0')}`));
  for (let i = 0; i < n; i++) await S.submit(pids[i], activity, payloadOf(i));
  return pids;
}

const TEXT1 = '학생이 쟁점에 대한 두 입장을 근거와 함께 정리하고 자기 주장을 세움.';
const TEXT2 = '학생이 쟁점에 대한 두 입장을 근거 세 개와 함께 정리하고 반론에 답하며 자기 주장을 세움.';

test('참가자(좁은 창): rewrite 1차 → 2차는 1차 문장으로 채워 고쳐 쓰고, 제출 뒤 새 어절이 표시된다', async ({ browser }) => {
  const ctx = await browser.newContext(NARROW);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  try {
    await joinAs(p, '시험 고쳐 쓰기');
    const items = p.locator('.menu [data-open]');
    expect(await items.evaluateAll((els) => els.map((e) => e.dataset.open))).toEqual(['grow', 'ox', 'rewrite1', 'rewrite2', 'pledge']);
    await expect(p.locator('body')).toHaveAttribute('data-live', 'live', { timeout: 20_000 });

    // 대기 → 관리자가 열면 새로고침 없이 문장 고르기
    await p.locator('.menu [data-open="rewrite1"]').click();
    await expect(p.locator('[data-wait]')).toBeVisible();
    await S.open('rewrite1');
    await expect(p.locator('#rwPicks .rw-pick')).toHaveCount(2, LIVE);
    await expect(p.locator('.rw-checks li')).toHaveCount(3);
    expect(await noSideScroll(p)).toBe(true);

    // 고르면 고른 문장이 위에, 글상자와 남은 글자 수
    await p.locator('input[name="rwp"][value="b"]').click();
    await expect(p.locator('.rw-q.on .rw-qt')).toHaveText(PROMPT.b);
    await expect(p.locator('#rwLeft')).toContainText('남은 글자 200자');
    // 좁은 창: 점검 질문은 글상자 아래
    const ta = await p.locator('#rwText').boundingBox();
    const ck = await p.locator('.rw-checks').boundingBox();
    expect(ck.y).toBeGreaterThanOrEqual(ta.y + ta.height - 1);

    await p.locator('#rwText').fill('짧다');
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('#toast')).toContainText('5자 이상');
    await p.locator('#rwText').fill(`  ${TEXT1.replace(' 두 ', '\n두 ')}  `);
    await expect(p.locator('#rwLeft b')).toHaveText(String(200 - [...TEXT1].length));
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('.done-mark')).toBeVisible();
    await expect(p.locator('.rw-mine')).toHaveText(TEXT1); // 서버처럼 줄 바꿈·앞뒤 공백 정리
    const saved = await restGet(`lwb_responses?select=payload&event_id=eq.${EV.id}&activity_id=eq.rewrite1`);
    expect(saved.body.map((r) => r.payload)).toEqual([{ prompt: 'b', text: TEXT1 }]);

    // 2차: 1차에서 고른 문장과 내 1차 문장이 위에, 글상자는 1차 문장으로 채워져 있다
    await p.locator('[data-act="menu"]').click();
    await expect(p.locator('.menu [data-open="rewrite1"] .st')).toHaveText('완료');
    await S.open('rewrite2');
    await p.locator('.menu [data-open="rewrite2"]').click();
    await expect(p.locator('.rw-ref .rw-qt')).toHaveText(PROMPT.b, LIVE);
    await expect(p.locator('.rw-ref .rw-first')).toHaveText(TEXT1);
    await expect(p.locator('#rwPicks')).toHaveCount(0);
    await expect(p.locator('#rwText')).toHaveValue(TEXT1);
    await p.locator('#rwText').fill(TEXT2);
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('.rw-cmp .c1')).toContainText(TEXT1);
    const marks = await p.locator('.rw-cmp .c2 mark').allTextContents();
    expect(marks.join(' ')).toContain('세 개와');
    expect(marks.join(' ')).toContain('반론에 답하며');
    expect(marks.join(' ')).not.toContain('학생이');

    // 360px 에서도 가로 스크롤 없음(결과·입력 화면)
    await p.setViewportSize({ width: 360, height: 740 });
    expect(await noSideScroll(p)).toBe(true);
    await p.locator('[data-act="edit"]').click();
    await expect(p.locator('#rwText')).toBeVisible();
    expect(await noSideScroll(p)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('참가자(넓은 창): 점검 질문이 글상자 옆에 있다', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ko-KR' });
  const p = await ctx.newPage();
  try {
    await joinAs(p, '시험 넓은 창');
    await p.locator('.menu [data-open="rewrite1"]').click();
    await p.locator('input[name="rwp"][value="a"]').click();
    const ta = await p.locator('#rwText').boundingBox();
    const ck = await p.locator('.rw-checks').boundingBox();
    expect(ck.x).toBeGreaterThanOrEqual(ta.x + ta.width - 1);
    expect(Math.abs(ck.y - ta.y)).toBeLessThan(120);
  } finally {
    await ctx.close();
  }
});

test('현황판 rewrite1: 넘김 · 이름 숨김(N) · 문장별(0·1·2) · 골라 띄우기(클릭·Enter·← →·Esc)', async ({ browser }) => {
  test.setTimeout(150_000);
  // 40명: 짝수는 A, 홀수는 B. 길이가 다른 문장
  await seedMany(40, '시험 벽', 'rewrite1', (i) => ({
    prompt: i % 2 ? 'b' : 'a',
    text: `${i + 1}번 문장: 학생이 예상 독자가 물을 질문을 ${(i % 4) + 2}가지 적고 건의문에서 차례로 답함.${' 근거를 덧붙임.'.repeat(i % 5)}`
  }));
  const total = (await restGet(`lwb_responses?select=participant_id&event_id=eq.${EV.id}&activity_id=eq.rewrite1`)).body.length;
  expect(total).toBe(41);

  const ctx = await browser.newContext(FULL);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`./board.html?e=${EV.id}&v=3`);
    const body = page.locator('body');
    await expect(body).toHaveAttribute('data-screen', 'rewrite');
    await expect(page.locator('#nav .tip')).toContainText('Enter');
    const pg = page.locator('.rw-pg .pg');
    await expect(pg).toContainText(`${total}장`);
    const pages = Number(await pg.getAttribute('data-pages'));
    expect(pages).toBeGreaterThan(1);
    const shown = await page.locator('.rw-col .rwcard').count();
    expect(shown).toBeLessThan(total);
    // 잘려 보이는 카드가 없다: 모든 카드가 칸 안에 들어간다
    const cut = await page.evaluate(() => [...document.querySelectorAll('.rw-col')].some((col) => {
      const c = col.getBoundingClientRect();
      return [...col.children].some((card) => card.getBoundingClientRect().bottom > c.bottom + 1);
    }));
    expect(cut).toBe(false);

    // 이름은 기본으로 숨김, N 으로 보이기·숨기기(한글 입력 상태의 ㅜ 도 같은 자리)
    await expect(page.locator('.rwcard .nm')).toHaveCount(0);
    await expect(page.locator('.rw-names')).toContainText('이름 숨김');
    await page.keyboard.press('n');
    await expect(page.locator('.rwcard .nm').first()).toContainText('시험');
    await page.keyboard.press('n');
    await expect(page.locator('.rwcard .nm')).toHaveCount(0);

    // 쪽 넘기기: PageDown·↓ 다음, ↑ 앞. 화면은 그대로
    const firstText = await page.locator('.rw-col .rwcard .tx').first().textContent();
    await page.keyboard.press('PageDown');
    await expect(pg).toHaveAttribute('data-page', '2');
    await expect(body).toHaveAttribute('data-screen', 'rewrite');
    await expect(page).toHaveURL(/[?&]v=3(&|$)/);
    expect(await page.locator('.rw-col .rwcard .tx').first().textContent()).not.toBe(firstText);
    await page.keyboard.press('ArrowUp');
    await expect(pg).toHaveAttribute('data-page', '1');
    // 모든 쪽을 넘기면 카드를 모두 본다
    const seen = new Set();
    for (let i = 0; i < pages; i++) {
      for (const t of await page.locator('.rw-col .rwcard .tx').allTextContents()) seen.add(t);
      await page.keyboard.press('PageDown');
    }
    expect(seen.size).toBe(total);
    for (let i = 0; i < pages; i++) await page.keyboard.press('PageUp');
    await expect(pg).toHaveAttribute('data-page', '1');

    // 문장별: 2 → B 만, 0 → 전체
    await page.keyboard.press('2');
    await expect(page.locator('.vt[data-filter="b"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.rw-prompt .rq')).toHaveCount(1);
    await expect(page.locator('.rw-prompt .rqt')).toHaveText(PROMPT.b);
    const tags = await page.locator('.rw-col .rwcard .tag').allTextContents();
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set(['B']));
    await expect(page.locator('.vt[data-filter="b"] .vn')).toHaveText('21'); // 홀수 20 + 1차 참가자(B)
    await page.keyboard.press('0');
    await expect(page.locator('.vt[data-filter="all"]')).toHaveAttribute('aria-selected', 'true');

    // 카드를 누르면 가운데 크게: 원래 문장(작게), 참가자 문장, 점검 질문. 이름은 숨김 그대로
    const card = page.locator('.rw-col .rwcard').first();
    const cardText = await card.locator('.tx').textContent();
    const cardTag = await card.locator('.tag').textContent();
    await card.click();
    const spot = page.locator('.rw-spot');
    await expect(spot).toBeVisible();
    await expect(spot.locator('.sp-text')).toHaveText(cardText);
    await expect(spot.locator('.sp-qt')).toHaveText(PROMPT[cardTag.toLowerCase()]);
    await expect(spot.locator('.sp-checks li')).toHaveCount(3);
    await expect(spot.locator('.sp-nm')).toHaveCount(0);
    await expect(spot.locator('.sp-n')).toHaveText(`1 / ${total}`);
    // 띄운 동안 → 는 다음 카드(화면을 넘기지 않는다)
    await page.keyboard.press('ArrowRight');
    await expect(spot.locator('.sp-n')).toHaveText(`2 / ${total}`);
    await expect(page).toHaveURL(/[?&]v=3(&|$)/);
    await page.keyboard.press('n');
    await expect(spot.locator('.sp-nm')).toHaveCount(1);
    await page.keyboard.press('n');
    await page.keyboard.press('Escape');
    await expect(spot).toBeHidden();

    // 키보드로: Esc 로 고르기를 풀고, Enter 로 첫 카드 고르기 → → 로 옮기고 → Enter 로 띄우기
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    const pid1 = await page.evaluate(() => document.activeElement && document.activeElement.dataset.pid);
    expect(pid1).toBeTruthy();
    await page.keyboard.press('ArrowRight');
    const pid2 = await page.evaluate(() => document.activeElement && document.activeElement.dataset.pid);
    expect(pid2).toBeTruthy();
    expect(pid2).not.toBe(pid1);
    await page.keyboard.press('Enter');
    await expect(spot).toBeVisible();
    await expect(spot.locator('.sp-n')).toHaveText(`2 / ${total}`);
    await page.locator('[data-act="close"]').click();
    await expect(spot).toBeHidden();

    // 고르기를 풀면 ← → 는 다시 화면 넘기기
    await page.keyboard.press('Escape');
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(/[?&]v=4(&|$)/);
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/[?&]v=3(&|$)/);

    // 새 카드가 와도 보던 쪽(1쪽)은 그대로, 뒤쪽에 새 카드가 있다고 알린다
    const before = await page.locator('.rw-col .rwcard .tx').allTextContents();
    const late = await S.join('시험 늦게');
    await S.submit(late, 'rewrite1', { prompt: 'a', text: '늦게 낸 문장: 학생이 독자의 반론을 예상해 답을 적음.' });
    await expect(pg).toContainText(`${total + 1}장`, LIVE);
    await expect(pg).toHaveAttribute('data-page', '1');
    expect(await page.locator('.rw-col .rwcard .tx').allTextContents()).toEqual(before);
    await expect(page.locator('.pg-new')).toHaveText('다른 쪽에 새 카드 1');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('현황판 rewrite2: 나란히 보기(두 번 다 낸 사람만, 새 어절 형광펜) · V 로 모아 보기', async ({ browser }) => {
  // 벽에 낸 40명 가운데 앞의 10명이 2차를 낸다(1차 글 + 새 말). 2차만 낸 사람 하나는 짝이 없다
  const first = (await restGet(`lwb_responses?select=participant_id,payload&event_id=eq.${EV.id}&activity_id=eq.rewrite1&order=created_at.asc`)).body;
  const ten = first.slice(1, 11);
  for (const r of ten) {
    await S.submit(r.participant_id, 'rewrite2', { prompt: r.payload.prompt, text: `${r.payload.text} 반론에 답함.` });
  }
  const only2 = await S.join('시험 2차만');
  await S.submit(only2, 'rewrite2', { prompt: 'a', text: '2차만 낸 사람의 문장입니다.' });

  const ctx = await browser.newContext(FULL);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`./board.html?e=${EV.id}&v=4`);
    const rw = page.locator('.rw');
    await expect(rw).toHaveAttribute('data-mode', 'pairs'); // 2차는 나란히 보기부터
    await expect(page.locator('.vt[data-mode="pairs"] .vn')).toHaveText('11'); // 10명 + 1번 테스트의 참가자
    await expect(page.locator('.vt[data-mode="wall"] .vn')).toHaveText('12');
    await expect(page.locator('.rw-pg .pg')).toContainText('11쌍');
    const pair = page.locator('.rwpair').nth(1);
    await expect(pair.locator('.p1 .tx')).toHaveText(ten[0].payload.text);
    await expect(pair.locator('.p2 mark')).toHaveText('반론에 답함.');
    await expect(page.locator('.rwpair', { hasText: '2차만 낸 사람' })).toHaveCount(0);
    await expect(page.locator('.rwpair .nm')).toHaveCount(0);

    await pair.click();
    await expect(page.locator('.rw-spot .sp-1 .tx')).toHaveText(ten[0].payload.text);
    await expect(page.locator('.rw-spot .sp-2 mark')).toHaveText('반론에 답함.');
    await page.keyboard.press('Escape');

    await page.keyboard.press('v');
    await expect(rw).toHaveAttribute('data-mode', 'wall');
    const pg = page.locator('.rw-pg .pg');
    await expect(pg).toContainText('12장');
    // 2차만 낸 사람은 가장 늦게 냈으니 끝쪽에 있다
    const pages = Number(await pg.getAttribute('data-pages'));
    for (let i = 1; i < pages; i++) await page.keyboard.press('PageDown');
    await expect(page.locator('.rwcard', { hasText: '2차만 낸 사람' })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('sentence 카드 100장: 쪽으로 모두 넘겨 보고, 새 카드가 와도 보던 쪽이 그대로다(이름은 보인다)', async ({ browser }) => {
  test.setTimeout(150_000);
  await S.open('grow');
  await seedMany(100, '시험 선언', 'grow', (i) => ({ template: 'grow', blank: `${i + 1}번 ${'스스로 질문하는 '.repeat((i % 3) + 1).trim()}` }));
  const ctx = await browser.newContext(FULL);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`./board.html?e=${EV.id}&v=1`);
    await expect(page.locator('body')).toHaveAttribute('data-screen', 'sentence');
    const pg = page.locator('.sn-pg .pg');
    await expect(pg).toContainText('100장');
    const pages = Number(await pg.getAttribute('data-pages'));
    expect(pages).toBeGreaterThan(1);
    await expect(page.locator('#nav .tip')).toContainText('↑ ↓ 쪽');
    await expect(page.locator('.sncard .nm').first()).toContainText('시험 선언');
    // 처음 낸 것이 첫 칸 맨 위
    await expect(page.locator('.sn-col').first().locator('.sncard .tx b').first()).toHaveText(/^1번 /);

    const seen = new Set();
    for (let i = 0; i < pages; i++) {
      for (const t of await page.locator('.sncard .tx b').allTextContents()) seen.add(t);
      await page.keyboard.press('ArrowDown');
    }
    expect(seen.size).toBe(100);
    await expect(pg).toHaveAttribute('data-page', String(pages)); // 끝쪽에서 더 넘기지 않는다

    // ← → 는 화면 넘기기. 돌아오면 보던 쪽 그대로
    await page.keyboard.press('PageUp');
    const at = await pg.getAttribute('data-page');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('body')).toHaveAttribute('data-screen', 'ox');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.sn-pg .pg')).toHaveAttribute('data-page', at);

    // 1쪽을 보는 중에 새 카드: 1쪽 그대로, 끝에 붙는다
    for (let i = 0; i < pages; i++) await page.keyboard.press('PageUp');
    const before = await page.locator('.sncard .tx b').allTextContents();
    const late = await S.join('시험 늦은 선언');
    await S.submit(late, 'grow', { template: 'grow', blank: '늦게 낸 선언' });
    await expect(pg).toContainText('101장', LIVE);
    await expect(pg).toHaveAttribute('data-page', '1');
    expect(await page.locator('.sncard .tx b').allTextContents()).toEqual(before);
    await expect(page.locator('.pg-new')).toHaveText('다른 쪽에 새 문장 1');
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});

test('실시간 구독: 참가자 기기는 진행 설정만, 현황판·관리자는 응답·참가자까지(로컬 흉내 서버)', async ({ browser }) => {
  test.skip(!process.env.LWB_LOCAL_MOCK, '소켓별 구독은 로컬 흉내 서버에서만 볼 수 있다');
  const mock = process.env.LWB_LOCAL_MOCK;
  const stats = async () => (await (await fetch(`${mock}/__mock/stats`)).json());
  const ctxs = [];
  try {
    const phones = [];
    for (let i = 0; i < 3; i++) {
      const c = await browser.newContext(NARROW);
      ctxs.push(c);
      const p = await c.newPage();
      await joinAs(p, `시험 구독 ${i + 1}`);
      await p.locator('.menu [data-open="ox"]').click();   // 대기 화면
      await expect(p.locator('body')).toHaveAttribute('data-live', 'live', { timeout: 20_000 });
      phones.push(p);
    }
    const bc = await browser.newContext(FULL);
    ctxs.push(bc);
    const board = await bc.newPage();
    await board.goto(`./board.html?e=${EV.id}&v=3`);
    await expect(board.locator('#conn [data-conn="live"]')).toBeVisible({ timeout: 20_000 });
    const ac = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'ko-KR' });
    ctxs.push(ac);
    const admin = await ac.newPage();
    await admin.goto(`./?e=${EV.id}`);
    await admin.locator('#nick').fill(EV.passcode);
    await admin.locator('#joinBtn').click();
    await expect(admin.locator('body')).toHaveAttribute('data-screen', 'admin');

    const ALL = ['lwb_participants', 'lwb_responses', 'lwb_settings'];
    await expect.poll(async () => (await stats()).sockets.filter((s) => s.tables.join() === ALL.join()).length).toBe(2);
    const s0 = await stats();
    const settingsOnly = s0.sockets.filter((s) => s.tables.join() === 'lwb_settings');
    expect(settingsOnly.length).toBeGreaterThanOrEqual(3);

    // 20명이 한꺼번에 낸다 → 참가자 기기에는 응답 알림이 가지 않는다
    await seedMany(20, '시험 알림', 'rewrite1', (i) => ({ prompt: 'a', text: `알림 시험 문장 ${i + 1}번입니다.` }));
    await expect.poll(async () => {
      const s = await stats();
      return s.sockets.filter((x) => x.tables.length === 3).every((x) => (x.received.lwb_responses || 0) >= 20);
    }).toBe(true);
    const s1 = await stats();
    for (const s of s1.sockets.filter((x) => x.tables.join() === 'lwb_settings')) {
      expect(s.received.lwb_responses || 0).toBe(0);
      expect(s.received.lwb_participants || 0).toBe(0);
    }
    // 관리자가 활동을 열면 참가자 기기는 진행 설정 알림만으로 새로고침 없이 바뀐다
    await S.open('ox');
    for (const p of phones) await expect(p.locator('[data-pick="O"]')).toBeVisible(LIVE);
  } finally {
    for (const c of ctxs) await c.close();
  }
});
