/**
 * 등록 명령 검사 (spec 4.3, 7-B1·B2)
 *   - 형식이 틀린 설정은 이유를 출력하고 0이 아닌 코드로 끝나며 DB에 아무것도 쓰지 않는다
 *   - --dry-run 은 검사만 한다
 *   - 암호가 없으면 12자 암호를 만들어 비밀 파일에 적고 한 번 출력한다
 *   - 다시 등록해도 진행 설정 값을 덮어쓰지 않는다(빠진 키만 N으로 더한다)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  call, runSql, lit, testId, testPasscode, tmpDir, removeDir, samplePublic, sampleSecret,
  writeEventFiles, registerCli, deleteEvents
} from './helpers.mjs';

const created = [];
let dir;

const clone = (x) => JSON.parse(JSON.stringify(x));

describe('등록 명령', () => {
  before(() => { dir = tmpDir(); });
  after(async () => {
    try { await deleteEvents(created); } finally { removeDir(dir); }
  });

  describe('형식 검사 실패는 0이 아닌 코드', () => {
    const broken = [];
    const add = (tag, why, mutate, secretMutate) => broken.push({ tag, why, mutate, secretMutate });

    add('dup', 'id "ox1" 가 중복', (p) => { p.activities[2].id = 'ox1'; });
    add('type', '알 수 없는 종류 "poll"', (p) => { p.activities[0].type = 'poll'; });
    add('oxn', '문항 3개와 정답 2개', null, (s) => { s.reveal.ox1.answers = ['O', 'X']; });
    add('oxv', '"O" 또는 "X"', null, (s) => { s.reveal.ox1.answers = ['O', 'X', 'Y']; });
    add('noans', '정답이 없습니다', null, (s) => { delete s.reveal.ox1; });
    add('title', 'title: 제목이 필요', (p) => { delete p.title; });
    add('date', 'date: 날짜가 필요', (p) => { delete p.date; });
    add('datef', '올바른 날짜', (p) => { p.date = '2026-13-01'; });
    add('dates', '올바른 날짜', (p) => { p.date = '2026/10/01'; });
    add('acts', '활동 목록', (p) => { p.activities = []; });
    add('actid', 'id 형식', (p) => { p.activities[0].id = 'OX 1'; });
    add('noq', '문항 문장 목록', (p) => { delete p.activities[0].questions; });
    add('items', '항목 목록', (p) => { p.activities[1].items = []; });
    add('itemdup', '중복', (p) => { p.activities[1].items[1].id = 'topic'; });
    add('custom', '예약어', (p) => { p.activities[1].objectives[0].id = 'custom'; });
    add('tpl', '문장 틀 목록', (p) => { delete p.activities[2].templates; });
    add('leak', '비밀 파일(reveal)에 두세요', (p) => { p.activities[0].answers = ['O', 'X', 'O']; });
    add('tag', '허용하지 않는 HTML 태그', (p) => { p.activities[1].items[0].desc = '<script>alert(1)</script>'; });
    add('url', 'http(s) 주소', (p) => { p.materials[0].url = 'javascript:alert(1)'; });
    add('kind', '"자료" 또는 "도구"', (p) => { p.materials[0].kind = '링크'; });
    add('rvx', 'ox 활동에만', null, (s) => { s.reveal.practice = { answers: ['O'] }; });
    add('pass', '영문·숫자 8~16자', null, (s) => { s.admin_passcode = 'short'; });
    add('fileid', '파일 이름의 id', (p) => { p.id = 'something-else'; });

    for (const b of broken) {
      it(`${b.tag}: ${b.why}`, () => {
        const id = testId(b.tag);
        created.push(id);
        const pub = samplePublic(id);
        const sec = sampleSecret(testPasscode());
        if (b.mutate) b.mutate(pub);
        if (b.secretMutate) b.secretMutate(sec);
        writeEventFiles(dir, id, pub, sec);
        for (const extra of [[], ['--dry-run']]) {
          const r = registerCli(id, dir, extra);
          assert.equal(r.code, 1, `종료 코드 1이어야 합니다 (${extra.join(' ')}): stdout=${r.stdout} stderr=${r.stderr}`);
          assert.ok(r.stderr.includes('검사 실패'), r.stderr);
          assert.ok(r.stderr.includes(b.why), `이유 "${b.why}" 가 출력되어야 합니다:\n${r.stderr}`);
        }
      });
    }

    it('잘못된 연수 id·없는 파일·깨진 JSON', async () => {
      assert.equal(registerCli('Bad_Id', dir).code, 1);
      assert.equal(registerCli('ab', dir).code, 1);
      assert.equal(registerCli('t-no-such-file', dir).code, 1);
      const id = testId('json');
      created.push(id);
      writeEventFiles(dir, id, {}, null);
      writeFileSync(join(dir, `${id}.json`), '{ "title": ');
      const r = registerCli(id, dir);
      assert.equal(r.code, 1);
      assert.ok(r.stderr.includes('JSON'));
    });

    it('실패한 등록은 DB에 아무것도 남기지 않는다', async () => {
      const ids = created.filter((x) => x.startsWith('t-'));
      const rows = await runSql(`select id from public.lwb_events where id = any(array[${ids.map(lit).join(', ')}]::text[])`);
      assert.deepEqual(rows, []);
    });
  });

  describe('--dry-run', () => {
    it('저장소의 sample 은 비밀 파일 없이도 검사를 통과한다', () => {
      const r = registerCli('sample', null, ['--dry-run']);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.includes('검사 통과'));
    });

    it('올바른 설정도 --dry-run 이면 DB에 쓰지 않는다', async () => {
      const id = testId('dry');
      created.push(id);
      writeEventFiles(dir, id, samplePublic(id), sampleSecret(null));
      const r = registerCli(id, dir, ['--dry-run']);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(await runSql(`select id from public.lwb_events where id = ${lit(id)}`), []);
      const sec = JSON.parse(readFileSync(join(dir, `${id}.secret.json`), 'utf8'));
      assert.equal(sec.admin_passcode, undefined, '--dry-run 은 암호를 만들지 않는다');
    });
  });

  describe('등록과 다시 등록', () => {
    const id = testId('reg');
    let passcode;

    it('암호가 없으면 12자 암호를 만들어 비밀 파일에 적고 한 번 출력한다', async () => {
      created.push(id);
      writeEventFiles(dir, id, samplePublic(id), sampleSecret(null));
      const r = registerCli(id, dir);
      assert.equal(r.code, 0, r.stderr);
      const sec = JSON.parse(readFileSync(join(dir, `${id}.secret.json`), 'utf8'));
      passcode = sec.admin_passcode;
      assert.match(passcode, /^[A-Za-z0-9]{12}$/);
      assert.equal(r.stdout.split(passcode).length - 1, 1, '암호는 한 번만 출력한다');
      assert.deepEqual(sec.reveal, sampleSecret(null).reveal, '비밀 파일의 다른 내용은 그대로');
      assert.ok(r.stdout.includes(`https://pblsketch.github.io/live-worksheet-busan/?e=${id}`), '참가자 주소');
      assert.ok(r.stdout.includes(`https://pblsketch.github.io/live-worksheet-busan/board.html?e=${id}`), '현황판 주소');
      assert.equal((await call('lwb_admin_check', { p_event_id: id, p_passcode: passcode })).ok, true);
      const ev = await call('lwb_get_event', { p_event_id: id });
      assert.deepEqual(Object.values(ev.settings), ['N', 'N', 'N', 'N', 'N']);
      // 해시로 저장된다(평문 아님)
      const [row] = await runSql(`select admin_hash from public.lwb_event_secrets where event_id = ${lit(id)}`);
      assert.notEqual(row.admin_hash, passcode);
      assert.match(row.admin_hash, /^\$2[abxy]\$/);
    });

    it('다시 등록해도 진행 설정을 덮어쓰지 않고, 새 활동의 키만 N으로 더한다', async () => {
      for (const key of ['open:ox1', 'reveal:ox1', 'materials_open']) {
        assert.equal((await call('lwb_admin_set', { p_event_id: id, p_key: key, p_value: 'Y', p_passcode: passcode })).ok, true);
      }
      // 같은 파일로 다시 등록
      let r = registerCli(id, dir);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(!r.stdout.includes(passcode), '이미 있는 암호는 다시 출력하지 않는다');
      let s = (await call('lwb_get_event', { p_event_id: id })).settings;
      assert.equal(s['open:ox1'], 'Y');
      assert.equal(s['reveal:ox1'], 'Y');
      assert.equal(s.materials_open, 'Y');

      // 활동을 하나 더하고 제목을 바꿔 다시 등록
      const pub = samplePublic(id);
      pub.title = '제목을 바꾼 샘플';
      pub.activities.push(clone(pub.activities[2]));
      pub.activities[3].id = 'pledge2';
      writeEventFiles(dir, id, pub, null);
      r = registerCli(id, dir);
      assert.equal(r.code, 0, r.stderr);
      const ev = await call('lwb_get_event', { p_event_id: id });
      s = ev.settings;
      assert.equal(ev.event.title, '제목을 바꾼 샘플');
      assert.equal(ev.event.activities.length, 4);
      assert.equal(s['open:pledge2'], 'N');
      assert.equal(s['open:ox1'], 'Y');
      assert.equal(s['reveal:ox1'], 'Y');
      assert.equal(s.materials_open, 'Y');
      assert.equal((await call('lwb_admin_check', { p_event_id: id, p_passcode: passcode })).ok, true, '암호 유지');
    });

    it('비밀 파일에서 암호를 바꾸면 새 암호만 통한다', async () => {
      const next = testPasscode();
      writeEventFiles(dir, id, samplePublic(id), sampleSecret(next));
      const r = registerCli(id, dir);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((await call('lwb_admin_check', { p_event_id: id, p_passcode: next })).ok, true);
      assert.equal((await call('lwb_admin_check', { p_event_id: id, p_passcode: passcode })).ok, false);
    });
  });
});
