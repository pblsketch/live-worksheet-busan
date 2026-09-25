/**
 * 전체 흐름 E2E (명세 7-B3)
 *
 * 1. 휴대폰 폭(390×844) 참가자: 입장 → 메뉴(설정 순서, 모두 대기) → 활동마다 대기 화면에 있다가
 *    관리자가 PC 폭(1366×768) 관리자 화면의 스위치로 열면 새로고침 없이 전환 →
 *    OX(모든 문항 · 고른 답 확인 · 제출) → stage_check(학습목표를 고르기 전에는 항목 카드가 잠김 · 한 항목 이상 · 제출)
 *    → sentence(틀 고르기 · 빈칸 · 제출) → 자료가 새로고침 없이 열림(주소 없는 자료는 "준비 중", 링크 아님).
 *    아무것도 내지 않은 둘째 참가자는 자료가 잠겨 있다가, 관리자가 "자료 전체 공개"를 켜면 새로고침 없이 열린다.
 * 2. 관리자 PC 화면: 접속·모두 완료 수와 활동별 n/전체, OX 정답 공개 스위치(reveal:<id>)를 켜야만
 *    참가자 결과 화면에 정답·점수가 나온다, 응답 모두 비우기는 확인 창을 거친다.
 *    비운 뒤 참가자는: 응답·참가자 목록을 보고 있던 화면이면 바로, 아니면 다음 제출이나 새로고침 때 입장 화면으로 간다.
 * 3. 새로고침: 입장·OX 제출 뒤 새로고침해도 참가자로 남아 있고 OX 결과가 그대로 보인다(답하던 중이면 이어서).
 *
 * 테스트마다 events/sample.json 으로 시험 연수(t-…-e2e)를 새로 만들고, 실패해도 afterEach 에서 지운다.
 * 실제 연수에는 손대지 않는다.
 */
import { test, expect } from '@playwright/test';
import { createTestEvent, deleteTestEvent, seeder } from './helpers.mjs';
import { call, restGet, samplePublic } from '../db/helpers.mjs';

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'ko-KR' };
const DESK = { viewport: { width: 1366, height: 768 }, locale: 'ko-KR' };
/** 다른 브라우저에서 바꾼 것이 넘어올 때까지 기다리는 시간(실시간이 끊겨도 20초 재조회로 들어온다) */
const LIVE = { timeout: 30_000 };

// 샘플 연수의 활동(설정 순서): ox1(ox) · practice(stage_check) · pledge(sentence)
const SAMPLE = samplePublic('x');
const ACTS = SAMPLE.activities.map((a) => a.id);

let EV = null;

test.beforeEach(async () => {
  EV = await createTestEvent('e2e');
});

test.afterEach(async () => {
  if (EV) await deleteTestEvent(EV.id);
  EV = null;
});

/* ───────────── 도구 ───────────── */

/** 브라우저 컨텍스트를 열고 load 횟수와 페이지 오류를 센다. 테스트 끝에 모두 닫는다 */
function opener(browser) {
  const all = [];
  return {
    async open(opts) {
      const ctx = await browser.newContext(opts);
      const page = await ctx.newPage();
      const t = { ctx, page, loads: 0, mark: -1, errors: [] };
      page.on('load', () => { t.loads++; });
      page.on('pageerror', (e) => t.errors.push(e.message));
      all.push(t);
      return t;
    },
    async closeAll() {
      for (const t of all) await t.ctx.close().catch(() => {});
    },
    errors() {
      return all.flatMap((t) => t.errors);
    }
  };
}

/** 새로고침 없이 바뀌는지 보려고 페이지에 표시를 남긴다 */
async function markPage(t) {
  await t.page.evaluate(() => { window.__lwSamePage = true; });
  t.mark = t.loads;
}

async function expectSamePage(t) {
  expect(await t.page.evaluate(() => window.__lwSamePage === true), '페이지가 새로 불려 왔다').toBe(true);
  expect(t.loads).toBe(t.mark);
}

const screenOf = (page) => page.locator('body');

/** 이름 칸에 적고 들어가기(관리자는 암호를 적는다) */
async function enter(page, text) {
  await page.goto(`./?e=${EV.id}`);
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'join');
  await page.locator('#nick').fill(text);
  await page.locator('#joinBtn').click();
}

async function join(page, name) {
  await enter(page, name);
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'menu');
}

async function loginAdmin(page) {
  await enter(page, EV.passcode);
  await expect(screenOf(page)).toHaveAttribute('data-screen', 'admin');
}

/** 실시간 연결이 붙을 때까지(붙기 전에 바뀐 것도 붙으면서 다시 불러오지만, 시간을 짧게 하려고 기다린다) */
async function waitLive(page) {
  await expect(screenOf(page)).toHaveAttribute('data-live', 'live', { timeout: 20_000 });
}

/** 관리자 화면의 스위치를 눌러 켜거나 끈다 */
async function flip(admin, key, on) {
  const sw = admin.locator(`[data-key="${key}"]`);
  await expect(sw).toHaveAttribute('role', 'switch');
  await expect(sw).toHaveAttribute('aria-checked', String(!on));
  await sw.click();
  await expect(admin.locator(`[data-key="${key}"]`)).toHaveAttribute('aria-checked', String(on));
}

const kpi = (admin) => admin.locator('#admKpi .v');           // [접속, 모두 완료]
const gnum = (admin, id) => admin.locator(`[data-card="${id}"] .gnum`);
const menuItem = (page, id) => page.locator(`.menu [data-open="${id}"]`);
const matItem = (page) => page.locator('.menu [data-open-materials]');
const pidOf = (page) => page.evaluate((k) => localStorage.getItem(k), `lwb:${EV.id}:pid`);

/** OX: 문항마다 고르고 '고른 답' 화면까지 */
async function answerOx(page, picks) {
  for (let i = 0; i < picks.length; i++) {
    await expect(page.locator('.qcount')).toHaveText(`${i + 1} / ${picks.length}`);
    await page.locator(`[data-pick="${picks[i]}"]`).click();
  }
  await expect(page.locator('.review-row')).toHaveCount(picks.length);
}

/* ───────────── 1. 휴대폰 참가자 전체 흐름 ───────────── */

test('휴대폰 참가자: 입장 → 대기 → 관리자가 PC 화면에서 열면 새로고침 없이 전환 → 세 활동 제출 → 자료 열림', async ({ browser }) => {
  test.setTimeout(240_000);
  const o = opener(browser);
  const NAME = '시험 참가자 하나';
  const NAME2 = '시험 참가자 둘';
  const MEMO = '시험 장치 메모';
  const BLANK = '시험 빈칸 문장';
  try {
    const phone = await o.open(PHONE);
    const desk = await o.open(DESK);
    const p = phone.page;
    const a = desk.page;

    /* ── 입장 → 메뉴: 설정 순서대로 세 활동, 모두 대기. 자료는 잠김 ── */
    await join(p, NAME);
    await expect(p.locator('.top .who')).toHaveText(NAME);
    const items = p.locator('.menu [data-open]');
    await expect(items).toHaveCount(ACTS.length);
    expect(await items.evaluateAll((els) => els.map((e) => e.dataset.open))).toEqual(ACTS);
    await expect(items.locator('.tt')).toHaveText(SAMPLE.activities.map((x) => x.title));
    for (const id of ACTS) {
      await expect(menuItem(p, id)).toHaveClass(/\bshut\b/);
      await expect(menuItem(p, id).locator('.st')).toHaveText('대기');
    }
    await expect(matItem(p)).toHaveClass(/\blocked\b/);
    await expect(matItem(p).locator('.st')).toHaveText(`0/${ACTS.length}`);
    await waitLive(p);
    await markPage(phone);

    /* ── 관리자(PC 폭): 이름 칸에 암호 → 대시보드. 처음에는 모두 닫힘, 접속 1명 ── */
    await loginAdmin(a);
    for (const id of ACTS) await expect(a.locator(`[data-key="open:${id}"]`)).toHaveAttribute('aria-checked', 'false');
    await expect(kpi(a)).toHaveText(['1', '0']);

    /* ── OX: 대기 → 관리자가 열면 새로고침 없이 문항 → 모든 문항 → 고른 답(하나 고치기) → 제출 ── */
    await menuItem(p, 'ox1').click();
    await expect(p.locator('[data-wait]')).toBeVisible();
    await flip(a, 'open:ox1', true);
    await expect(p.locator('[data-pick="O"]')).toBeVisible(LIVE);
    await expect(p.locator('[data-wait]')).toHaveCount(0);
    await expectSamePage(phone);

    await answerOx(p, ['O', 'X', 'X']);
    await expect(p.locator('.review-row .ra')).toHaveText(['O', 'X', 'X']);
    await p.locator('.review-row[data-go="2"]').click();          // 셋째 문항을 고친다
    await expect(p.locator('.qcount')).toHaveText('3 / 3');
    await p.locator('[data-pick="O"]').click();
    await expect(p.locator('.review-row .ra')).toHaveText(['O', 'X', 'O']);
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('.big-num')).toHaveText('1명');
    await expect(p.locator('.bar-item')).toHaveCount(3);
    await expect(p.locator('.badge')).toHaveCount(0);              // 정답 공개 전
    await expect(gnum(a, 'ox1')).toHaveText('1 / 1명', LIVE);

    await p.locator('[data-act="menu"]').click();
    await expect(menuItem(p, 'ox1').locator('.st')).toHaveClass(/\bdone\b/);
    await expect(menuItem(p, 'ox1').locator('.st')).toHaveText('완료');
    await expect(matItem(p)).toHaveClass(/\blocked\b/);
    await expect(matItem(p).locator('.st')).toHaveText(`1/${ACTS.length}`);

    /* ── stage_check: 대기 → 열림 → 학습목표 전에는 항목 카드 잠김 → 목표 고르기 → 한 항목 채워 제출 ── */
    await menuItem(p, 'practice').click();
    await expect(p.locator('[data-wait]')).toBeVisible();
    await flip(a, 'open:practice', true);
    await expect(p.locator('#objs')).toBeVisible(LIVE);
    await expect(p.locator('[data-wait]')).toHaveCount(0);
    await expectSamePage(phone);

    await expect(p.locator('#items .locked-items')).toBeVisible();
    await expect(p.locator('#items [data-item]')).toHaveCount(0);
    await p.locator('[data-act="submit"]').click();                // 목표 없이 내면 막힌다
    await expect(p.locator('#toast')).toContainText('학습목표');
    await expect(p.locator('#objs')).toBeVisible();
    await expect(p.locator('.done-mark')).toHaveCount(0);

    await p.locator('input[name="obj"][value="obj-b"]').check();
    await expect(p.locator('#items .locked-items')).toHaveCount(0);
    await expect(p.locator('#items [data-item]')).toHaveCount(SAMPLE.activities[1].items.length);
    const topic = p.locator('[data-item="topic"]');
    await topic.locator('[data-risk="상"]').click();
    await topic.locator('[data-stage="2"]').click();
    await topic.locator('[data-memo]').fill(MEMO);
    await expect(topic.locator('[data-risk="상"]')).toHaveClass(/\bon\b/);
    await expect(topic.locator('[data-stage="2"]')).toHaveClass(/\bon\b/);
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('.done-mark')).toBeVisible();
    await expect(p.locator('.mine-box .pline')).toHaveCount(1);
    await expect(p.locator('.mine-box .pmemo')).toHaveText(MEMO);
    await expect(p.locator('.detail.mine')).toHaveCount(1);
    await expect(gnum(a, 'practice')).toHaveText('1 / 1명', LIVE);

    await p.locator('[data-act="menu"]').click();
    await expect(menuItem(p, 'practice').locator('.st')).toHaveClass(/\bdone\b/);
    await expect(matItem(p)).toHaveClass(/\blocked\b/);
    await expect(matItem(p).locator('.st')).toHaveText(`2/${ACTS.length}`);

    /* ── sentence: 대기 → 열림 → 틀을 고르기 전에는 빈칸을 못 씀 → 틀 · 빈칸 → 제출 ── */
    await menuItem(p, 'pledge').click();
    await expect(p.locator('[data-wait]')).toBeVisible();
    await flip(a, 'open:pledge', true);
    await expect(p.locator('#tpls')).toBeVisible(LIVE);
    await expect(p.locator('[data-wait]')).toHaveCount(0);
    await expectSamePage(phone);

    await expect(p.locator('#blank')).toBeDisabled();
    await p.locator('input[name="tpl"][value="teacher"]').check();
    // 둘 중 하나만: 고른 틀은 강조, 고르지 않은 틀은 흐리게
    await expect(p.locator('.tpl.on')).toHaveCount(1);
    await expect(p.locator('.tpl.off')).toHaveCount(1);
    await expect(p.locator('#blank')).toBeEnabled();
    await p.locator('#blank').fill(BLANK);
    await expect(p.locator('#pv .blank')).toHaveText(BLANK);
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('.stream-item.mine')).toBeVisible();
    await expect(p.locator('.stream-item.mine .tx b')).toHaveText(BLANK);

    /* ── 마지막 제출 뒤 메뉴: 자료가 새로고침 없이 열린다 ── */
    await p.locator('[data-act="menu"]').click();
    await expect(p.locator('.progress-bar i.on')).toHaveCount(ACTS.length);
    for (const id of ACTS) await expect(menuItem(p, id).locator('.st')).toHaveClass(/\bdone\b/);
    await expect(matItem(p)).not.toHaveClass(/\blocked\b/);
    await expect(matItem(p).locator('.st')).toHaveClass(/\bdone\b/);
    await matItem(p).click();
    await expect(screenOf(p)).toHaveAttribute('data-screen', 'materials');
    await expect(p.locator('#matBody .lock')).toHaveCount(0);
    // 주소가 있는 자료는 새 창 링크, 주소가 빈 자료는 "준비 중"이고 링크가 아니다
    const links = p.locator('#matBody a.mat');
    await expect(links).toHaveCount(2);
    await expect(links.nth(0)).toHaveAttribute('href', 'materials/shared/purposes.html');
    await expect(links.nth(1)).toHaveAttribute('href', 'https://example.com/');
    for (const i of [0, 1]) await expect(links.nth(i)).toHaveAttribute('target', '_blank');
    const soon = p.locator('#matBody .mat.soon');
    await expect(soon).toHaveCount(1);
    await expect(soon).toHaveAttribute('aria-disabled', 'true');
    expect(await soon.evaluate((el) => el.tagName)).toBe('DIV');
    expect(await soon.evaluate((el) => !!el.closest('a') || !!el.querySelector('a[href]'))).toBe(false);
    await expect(soon).toContainText('준비 중');
    await expectSamePage(phone);

    /* ── 관리자: 접속 1 · 모두 완료 1, 활동마다 1/1 ── */
    await expect(kpi(a)).toHaveText(['1', '1'], LIVE);
    for (const id of ACTS) await expect(gnum(a, id)).toHaveText('1 / 1명');
    await expect(a.locator('#admPeople tr.all')).toHaveCount(1);

    /* ── 아무것도 내지 않은 둘째 참가자: 자료 잠김 → 관리자가 "자료 전체 공개"를 켜면 새로고침 없이 열림 ── */
    const phone2 = await o.open(PHONE);
    const q = phone2.page;
    await join(q, NAME2);
    for (const id of ACTS) await expect(menuItem(q, id).locator('.st')).toHaveText('진행'); // 모두 열려 있다
    await expect(matItem(q)).toHaveClass(/\blocked\b/);
    await expect(matItem(q).locator('.st')).toHaveText(`0/${ACTS.length}`);
    await matItem(q).click();
    await expect(screenOf(q)).toHaveAttribute('data-screen', 'materials');
    await expect(q.locator('#matBody .lock')).toBeVisible();
    await expect(q.locator('#matBody .mat')).toHaveCount(0);
    await expect(q.locator('#matBody .check-list .c.on')).toHaveCount(0);
    await expect(kpi(a)).toHaveText(['2', '1'], LIVE);
    await waitLive(q);
    await markPage(phone2);

    await flip(a, 'materials_open', true);
    await expect(a.locator('#admCtrl .toggle.gate')).toHaveClass(/\bon\b/);
    await expect(q.locator('#matBody a.mat')).toHaveCount(2, LIVE);
    await expect(q.locator('#matBody .mat.soon')).toHaveCount(1);
    await expect(q.locator('#matBody .lock')).toHaveCount(0);
    await expectSamePage(phone2);
    // 메뉴로 돌아가도 열려 있다(낸 활동은 여전히 0개)
    await q.locator('.top .back').click();
    await expect(screenOf(q)).toHaveAttribute('data-screen', 'menu');
    await expect(matItem(q)).not.toHaveClass(/\blocked\b/);
    await expect(q.locator('.progress-bar i.on')).toHaveCount(0);
    await expectSamePage(phone2);

    expect(o.errors()).toEqual([]);
  } finally {
    await o.closeAll();
  }
});

/* ───────────── 2. 관리자 PC 화면 ───────────── */

test('관리자 PC 화면: 접속·완료 수, OX 정답 공개 스위치, 응답 모두 비우기(확인 창)', async ({ browser }) => {
  test.setTimeout(240_000);
  const o = opener(browser);
  const N1 = '시험 관리 하나';
  const N2 = '시험 관리 둘';
  const N3 = '시험 관리 셋';
  try {
    const desk = await o.open(DESK);
    const a = desk.page;

    /* ── 빈 대시보드: 0명, 활동마다 0/0. 정답 공개 스위치는 OX 카드에만 ── */
    await loginAdmin(a);
    await expect(kpi(a)).toHaveText(['0', '0']);
    await expect(a.locator('#admPeople .empty')).toBeVisible();
    for (const id of ACTS) await expect(gnum(a, id)).toHaveText('0 / 0명');
    await expect(a.locator('[data-key^="reveal:"]')).toHaveCount(1);
    await expect(a.locator('[data-card="ox1"] [data-key="reveal:ox1"]')).toHaveAttribute('aria-checked', 'false');
    await flip(a, 'open:ox1', true);
    await flip(a, 'open:pledge', true);
    await waitLive(a);

    /* ── 참가자 하나: OX 를 내고 결과 화면에 머문다(맞힌 수 2: 정답 O·X·O) ── */
    const one = await o.open(PHONE);
    const p1 = one.page;
    await join(p1, N1);
    await expect(kpi(a)).toHaveText(['1', '0'], LIVE);
    await expect(a.locator('#admPeopleN')).toHaveText('1명');
    await menuItem(p1, 'ox1').click();
    await answerOx(p1, ['O', 'X', 'X']);
    await p1.locator('[data-act="submit"]').click();
    await expect(p1.locator('.big-num')).toHaveText('1명');
    await expect(gnum(a, 'ox1')).toHaveText('1 / 1명', LIVE);
    await expect(a.locator('#admPeekTabs [data-peek="ox1"] em')).toHaveText('1');

    /* ── 참가자 둘: 문장을 내고 결과 화면에 머문다 ── */
    const two = await o.open(PHONE);
    const p2 = two.page;
    await join(p2, N2);
    await menuItem(p2, 'pledge').click();
    await p2.locator('input[name="tpl"][value="student"]').check();
    await p2.locator('#blank').fill('시험 관리 문장');
    await p2.locator('[data-act="submit"]').click();
    await expect(p2.locator('.stream-item.mine')).toBeVisible();

    /* ── 참가자 셋: 문장을 적는 중(아직 내지 않음) ── */
    const three = await o.open(PHONE);
    const p3 = three.page;
    await join(p3, N3);
    await menuItem(p3, 'pledge').click();
    await p3.locator('input[name="tpl"][value="teacher"]').check();
    await p3.locator('#blank').fill('시험 적는 중');

    /* ── 수: 접속 3 · 모두 완료 0, ox1 1/3 · practice 0/3 · pledge 1/3, 참가자 표 ── */
    await expect(kpi(a)).toHaveText(['3', '0'], LIVE);
    await expect(a.locator('#admPeopleN')).toHaveText('3명');
    await expect(gnum(a, 'ox1')).toHaveText('1 / 3명', LIVE);
    await expect(gnum(a, 'practice')).toHaveText('0 / 3명');
    await expect(gnum(a, 'pledge')).toHaveText('1 / 3명', LIVE);
    await expect(a.locator('#admPeople tbody tr')).toHaveCount(3);
    const row1 = a.locator('#admPeople tbody tr', { hasText: N1 });
    await expect(row1.locator('td.y')).toHaveText(['✓']);          // OX 만, 공개 전이라 점수 없음

    /* ── 정답 공개: 켜기 전에는 참가자 결과 화면에 정답·점수가 없다 ── */
    await expect(p1.locator('.badge')).toHaveCount(0);
    await expect(p1.locator('.score-line')).toHaveCount(0);
    await waitLive(p1);
    await markPage(one);

    await flip(a, 'reveal:ox1', true);
    let g = await call('lwb_get_event', { p_event_id: EV.id });
    expect(g.settings['reveal:ox1']).toBe('Y');
    expect(g.reveal.ox1.answers).toEqual(['O', 'X', 'O']);
    await expect(p1.locator('.badge')).toHaveCount(3, LIVE);
    await expect(p1.locator('.score-line b')).toHaveText('2 / 3');
    await expect(p1.locator('.bar-item .ok')).toHaveCount(2);
    await expect(p1.locator('.bar-item .no')).toHaveCount(1);
    await expect(row1.locator('td.y')).toHaveText(['2/3'], LIVE);
    await expect(a.locator('[data-card="ox1"] .gextra b')).toHaveText('2.0 / 3');
    await expectSamePage(one);

    // 다시 끄면 정답이 가려진다
    await flip(a, 'reveal:ox1', false);
    g = await call('lwb_get_event', { p_event_id: EV.id });
    expect(g.settings['reveal:ox1']).toBe('N');
    expect(g.reveal.ox1).toBeUndefined();
    await expect(p1.locator('.badge')).toHaveCount(0, LIVE);
    await expect(p1.locator('.score-line')).toHaveCount(0);
    await expectSamePage(one);

    /* ── 응답 모두 비우기: 확인 창에서 취소하면 그대로 ── */
    await waitLive(p2);
    await markPage(two);
    await markPage(three);
    const dlg = a.locator('#modal [role="dialog"]');
    await a.locator('[data-act="reset"]').click();
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('3명');
    await expect(dlg).toContainText('2건');
    await dlg.locator('[data-m="no"]').click();
    await expect(dlg).toHaveCount(0);
    await expect(kpi(a)).toHaveText(['3', '0']);
    let rows = await restGet(`lwb_participants?select=id&event_id=eq.${encodeURIComponent(EV.id)}`);
    expect(rows.body).toHaveLength(3);

    /* ── 확인하면 참가자·응답이 지워지고, 스위치 상태는 남는다 ── */
    await a.locator('[data-act="reset"]').click();
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-m="yes"]').click();
    await expect(dlg).toHaveCount(0);
    await expect(kpi(a)).toHaveText(['0', '0'], LIVE);
    await expect(a.locator('#admPeople .empty')).toBeVisible();
    for (const id of ACTS) await expect(gnum(a, id)).toHaveText('0 / 0명');
    for (const [key, on] of [['open:ox1', 'true'], ['open:practice', 'false'], ['open:pledge', 'true'], ['reveal:ox1', 'false']]) {
      await expect(a.locator(`[data-key="${key}"]`)).toHaveAttribute('aria-checked', on);
    }
    rows = await restGet(`lwb_participants?select=id&event_id=eq.${encodeURIComponent(EV.id)}`);
    expect(rows.body).toEqual([]);
    rows = await restGet(`lwb_responses?select=activity_id&event_id=eq.${encodeURIComponent(EV.id)}`);
    expect(rows.body).toEqual([]);

    /* ── 참가자 쪽 ── */
    // 둘: 참가자 목록을 받는 화면(문장 결과)이라 새로고침 없이 바로 입장 화면으로
    await expect(screenOf(p2)).toHaveAttribute('data-screen', 'join', LIVE);
    await expectSamePage(two);
    expect(await pidOf(p2)).toBeNull();

    // 셋: 적던 화면(목록을 받지 않음)에서 제출하면 입장 화면으로
    await expect(screenOf(p3)).toHaveAttribute('data-screen', 'activity');
    await p3.locator('[data-act="submit"]').click();
    await expect(screenOf(p3)).toHaveAttribute('data-screen', 'join');
    await expectSamePage(three);
    expect(await pidOf(p3)).toBeNull();

    // 하나: OX 결과 화면(참가자 목록을 받지 않음) → 새로고침하면 입장 화면으로
    expect(await pidOf(p1)).not.toBeNull();
    await p1.reload();
    await expect(screenOf(p1)).toHaveAttribute('data-screen', 'join');
    expect(await pidOf(p1)).toBeNull();

    expect(o.errors()).toEqual([]);
  } finally {
    await o.closeAll();
  }
});

/* ───────────── 3. 새로고침 ───────────── */

test('새로고침: 답하던 중이면 이어서, OX 를 낸 뒤에는 참가자로 남고 결과가 그대로 보인다', async ({ browser }) => {
  const o = opener(browser);
  const NAME = '시험 새로고침';
  try {
    await seeder(EV).open('ox1');
    const phone = await o.open(PHONE);
    const p = phone.page;
    await join(p, NAME);
    const pid = await pidOf(p);
    expect(pid).toBeTruthy();

    // 답하던 중에 새로고침: 참가자로 남고, 고른 답과 위치가 기기에 남아 있다
    await menuItem(p, 'ox1').click();
    await p.locator('[data-pick="X"]').click();
    await expect(p.locator('.qcount')).toHaveText('2 / 3');
    await p.reload();
    await expect(screenOf(p)).toHaveAttribute('data-screen', 'menu');
    await expect(p.locator('.top .who')).toHaveText(NAME);
    await menuItem(p, 'ox1').click();
    await expect(p.locator('.qcount')).toHaveText('2 / 3');
    await p.locator('[data-pick="O"]').click();
    await expect(p.locator('.qcount')).toHaveText('3 / 3');
    await p.locator('[data-pick="O"]').click();
    await expect(p.locator('.review-row .ra')).toHaveText(['X', 'O', 'O']);
    await p.locator('[data-act="submit"]').click();
    await expect(p.locator('.big-num')).toHaveText('1명');

    // 낸 뒤 새로고침: 입장 화면 없이 메뉴(OX 완료), 다시 누르면 결과 화면과 내 답
    await p.reload();
    await expect(screenOf(p)).toHaveAttribute('data-screen', 'menu');
    await expect(p.locator('#nick')).toHaveCount(0);
    await expect(p.locator('.top .who')).toHaveText(NAME);
    expect(await pidOf(p)).toBe(pid);
    await expect(menuItem(p, 'ox1').locator('.st')).toHaveClass(/\bdone\b/);
    await expect(matItem(p).locator('.st')).toHaveText(`1/${ACTS.length}`);
    await menuItem(p, 'ox1').click();
    await expect(p.locator('.big-num')).toHaveText('1명');
    await expect(p.locator('[data-pick]')).toHaveCount(0);
    await expect(p.locator('.bar-item')).toHaveCount(3);
    await expect(p.locator('.bar-item .hint b')).toHaveText(['X', 'O', 'O']); // 내 답
    expect(await p.evaluate((k) => localStorage.getItem(k), `lwb:${EV.id}:draft:ox1`)).toBeNull();

    expect(o.errors()).toEqual([]);
  } finally {
    await o.closeAll();
  }
});
