/**
 * 서버 함수 검사 (spec 7-B1)
 * 입장·이어하기·새로 시작, 관리자 판별, 닫힌 활동 거부, 종류별 검사, 덮어쓰기,
 * 공개 전 정답·점수 비노출, 공개 후 정답, 비밀 비공개, 관리자 키 제한, 응답 비우기.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  call, rpc, restGet, restBase, runSql, lit, testId, testPasscode, tmpDir, removeDir,
  samplePublic, sampleSecret, writeEventFiles, registerCli, deleteEvents, containsText
} from './helpers.mjs';

const EV = testId('rpc');
const OTHER = testId('oth');
const PASS = testPasscode();
const OTHER_PASS = testPasscode();
const created = [EV, OTHER];
let dir;

const SECRET_TEXTS = ['시험라벨AI', '시험라벨사람', '시험해설하나', '시험해설셋', '시험패널갑'];

const submit = (activity, payload, pid, ev = EV) =>
  call('lwb_submit', { p_event_id: ev, p_participant_id: pid, p_activity_id: activity, p_payload: payload });
const setKey = (key, value, pass = PASS, ev = EV) =>
  call('lwb_admin_set', { p_event_id: ev, p_key: key, p_value: value, p_passcode: pass });
const join = (name, mode, ev = EV) =>
  call('lwb_join', { p_event_id: ev, p_name: name, ...(mode === undefined ? {} : { p_mode: mode }) });

function assertInvalid(res, label) {
  assert.equal(res.ok, false, `${label}: 거부되어야 합니다 (${JSON.stringify(res)})`);
  assert.equal(res.code, 'invalid', `${label}: code=invalid (${JSON.stringify(res)})`);
  assert.ok(typeof res.msg === 'string' && res.msg.length > 0, `${label}: 사유 메시지`);
  assert.ok(!('score' in res) && !('correct' in res), `${label}: 점수·정답 여부가 없어야 합니다`);
}

describe('서버 함수', () => {
  let alice; // 주 참가자
  let other; // 다른 연수의 참가자

  before(async () => {
    dir = tmpDir();
    writeEventFiles(dir, EV, samplePublic(EV), sampleSecret(PASS));
    // 다른 연수: 직접 적기를 끈 stage_check 변형
    const op = samplePublic(OTHER);
    op.activities[1].allowCustom = false;
    writeEventFiles(dir, OTHER, op, sampleSecret(OTHER_PASS));
    for (const id of [EV, OTHER]) {
      const r = registerCli(id, dir);
      assert.equal(r.code, 0, `등록 실패 ${id}: ${r.stderr}`);
    }
  });

  after(async () => {
    try { await deleteEvents(created); } finally { removeDir(dir); }
  });

  describe('연수 불러오기', () => {
    it('없는 연수는 ok:false', async () => {
      const r = await call('lwb_get_event', { p_event_id: 'no-such-event-x' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'no_event');
    });

    it('공개 설정과 진행 설정(모두 N)을 돌려주고, 공개 전용 내용은 없다', async () => {
      const r = await call('lwb_get_event', { p_event_id: EV });
      assert.equal(r.ok, true);
      assert.equal(r.event.id, EV);
      assert.equal(r.event.listed, false);
      assert.deepEqual(r.event.activities.map((a) => a.id), ['ox1', 'practice', 'pledge']);
      assert.equal(r.event.materials.length, 3);
      assert.deepEqual(r.settings, {
        'open:ox1': 'N', 'reveal:ox1': 'N', 'open:practice': 'N', 'open:pledge': 'N', materials_open: 'N'
      });
      assert.deepEqual(r.reveal, {});
      for (const t of SECRET_TEXTS) assert.ok(!containsText(r, t), `비밀 문구 "${t}" 노출`);
      assert.ok(!containsText(r, '"answers"'), 'answers 칸 노출');
    });
  });

  describe('입장', () => {
    it('처음 온 이름은 새 참가자가 된다(모드 생략 = check)', async () => {
      const r = await join('  김 하나  ');
      assert.equal(r.ok, true);
      assert.equal(r.created, true);
      assert.match(r.participant.id, /^[0-9a-f-]{36}$/);
      assert.equal(r.participant.name, '김 하나');
      alice = r.participant.id;
    });

    it('같은 정규화 이름: check는 묻고(참가자를 만들지 않음), resume은 이어서, new는 따로', async () => {
      const c = await join('김   하나', 'check');
      assert.deepEqual({ ok: c.ok, exists: c.exists }, { ok: true, exists: true });
      assert.ok(!c.participant, 'check 는 참가자를 돌려주지 않는다');

      const rs = await join('김 하나', 'resume');
      assert.equal(rs.resumed, true);
      assert.equal(rs.participant.id, alice);

      const n = await join('김 하나', 'new');
      assert.equal(n.created, true);
      assert.notEqual(n.participant.id, alice);

      const rows = await restGet(`lwb_participants?select=id&event_id=eq.${EV}&norm_name=eq.${encodeURIComponent('김 하나')}`);
      assert.equal(rows.status, 200);
      assert.equal(rows.body.length, 2, 'check 모드에서 참가자가 더 생기면 안 된다');
    });

    it('대소문자만 다른 영문 이름도 같은 사람으로 본다', async () => {
      await join('Park Minsu', 'new');
      const c = await join('park   MINSU', 'check');
      assert.equal(c.exists, true);
    });

    it('이름 길이: 빈 이름·21자 거부, 20자 허용', async () => {
      assert.equal((await join('   ', 'new')).code, 'bad_name');
      assert.equal((await join('가'.repeat(21), 'new')).code, 'bad_name');
      assert.equal((await join('가'.repeat(20), 'new')).created, true);
    });

    it('잘못된 모드·없는 연수 거부', async () => {
      assert.equal((await join('누군가', 'maybe')).code, 'bad_mode');
      assert.equal((await join('누군가', 'new', 'no-such-event-x')).code, 'no_event');
    });

    it('다른 연수의 참가자 만들기', async () => {
      other = (await join('다른 연수 사람', 'new', OTHER)).participant.id;
      assert.ok(other);
    });
  });

  describe('관리자 판별', () => {
    it('암호와 같은 이름은 관리자로 들어간다(앞뒤 공백은 뗀다)', async () => {
      for (const name of [PASS, `  ${PASS}\t`]) {
        const r = await join(name, 'check');
        assert.equal(r.ok, true);
        assert.equal(r.admin, true, `관리자 판별 실패: ${JSON.stringify(r)}`);
      }
    });

    it('대소문자가 다르면 관리자가 아니다(정규화 전에 비교)', async () => {
      const r = await join(PASS.toLowerCase(), 'new');
      assert.notEqual(r.admin, true);
      assert.equal(r.created, true);
      const r2 = await join(PASS.toUpperCase(), 'new');
      assert.notEqual(r2.admin, true);
    });

    it('다른 연수의 암호로는 관리자가 되지 않는다', async () => {
      const r = await join(OTHER_PASS, 'new');
      assert.notEqual(r.admin, true);
    });

    it('길이 검사보다 먼저 비교한다(20자를 넘는 암호 해시로 확인)', async () => {
      const longPass = `Lp${'x'.repeat(20)}9Z`; // 24자
      await runSql(`update public.lwb_event_secrets set admin_hash = extensions.crypt(${lit(longPass)}, extensions.gen_salt('bf', 8)) where event_id = ${lit(OTHER)}`);
      try {
        const r = await join(longPass, 'check', OTHER);
        assert.equal(r.admin, true, `긴 암호가 관리자로 판별되어야 합니다: ${JSON.stringify(r)}`);
        const notPass = `Lp${'y'.repeat(20)}9Z`;
        assert.equal((await join(notPass, 'check', OTHER)).code, 'bad_name', '암호가 아닌 긴 이름은 길이 검사에 걸린다');
      } finally {
        await runSql(`update public.lwb_event_secrets set admin_hash = extensions.crypt(${lit(OTHER_PASS)}, extensions.gen_salt('bf', 8)) where event_id = ${lit(OTHER)}`);
      }
      assert.equal((await call('lwb_admin_check', { p_event_id: OTHER, p_passcode: OTHER_PASS })).ok, true);
    });

    it('lwb_admin_check: 맞는 암호만 ok', async () => {
      assert.equal((await call('lwb_admin_check', { p_event_id: EV, p_passcode: PASS })).ok, true);
      assert.equal((await call('lwb_admin_check', { p_event_id: EV, p_passcode: PASS.toLowerCase() })).ok, false);
      assert.equal((await call('lwb_admin_check', { p_event_id: EV, p_passcode: '' })).ok, false);
      assert.equal((await call('lwb_admin_check', { p_event_id: EV, p_passcode: OTHER_PASS })).ok, false);
      assert.equal((await call('lwb_admin_check', { p_event_id: 'no-such-event-x', p_passcode: PASS })).ok, false);
    });
  });

  describe('제출 거부 규칙', () => {
    const okOx = { answers: ['O', 'X', 'O'] };

    it('닫힌 활동은 세 종류 모두 거부한다', async () => {
      const cases = [
        ['ox1', okOx],
        ['practice', { objective: { id: 'obj-a' }, items: { topic: { stage: 1 } } }],
        ['pledge', { template: 'student', blank: '스스로 생각' }]
      ];
      for (const [act, payload] of cases) {
        const r = await submit(act, payload, alice);
        assert.deepEqual(r, { ok: false, code: 'closed', msg: '아직 열리지 않은 과제입니다.' }, act);
      }
    });

    it('없는 연수·없는 참가자·다른 연수 참가자·없는 활동 거부', async () => {
      await setKey('open:ox1', 'Y');
      assert.equal((await submit('ox1', okOx, alice, 'no-such-event-x')).code, 'no_event');
      const msg = '참가자 정보를 찾을 수 없습니다. 새로고침해 주세요.';
      for (const pid of [randomUUID(), 'not-a-uuid', '', other]) {
        const r = await submit('ox1', okOx, pid);
        assert.deepEqual(r, { ok: false, code: 'no_participant', msg }, `pid=${pid}`);
      }
      assert.equal((await submit('nope', okOx, alice)).code, 'no_activity');
    });

    it('브라우저 키로 표에 직접 쓸 수 없다', async () => {
      const { url, headers } = restBase();
      const patch = await fetch(`${url}/rest/v1/lwb_settings?event_id=eq.${EV}&key=eq.open:pledge`, {
        method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify({ value: 'Y' })
      });
      assert.ok(patch.status >= 400, `PATCH 가 막혀야 합니다(HTTP ${patch.status})`);
      const ins = await fetch(`${url}/rest/v1/lwb_responses`, {
        method: 'POST', headers,
        body: JSON.stringify({ event_id: EV, activity_id: 'ox1', participant_id: alice, payload: okOx })
      });
      assert.ok(ins.status >= 400, `INSERT 가 막혀야 합니다(HTTP ${ins.status})`);
      const del = await fetch(`${url}/rest/v1/lwb_participants?event_id=eq.${EV}`, { method: 'DELETE', headers });
      assert.ok(del.status >= 400, `DELETE 가 막혀야 합니다(HTTP ${del.status})`);
      const s = await restGet(`lwb_settings?select=value&event_id=eq.${EV}&key=eq.open:pledge`);
      assert.equal(s.body[0].value, 'N');
      const p = await restGet(`lwb_participants?select=id&event_id=eq.${EV}`);
      assert.ok(p.body.length >= 1);
    });

    it('내부 도우미 함수는 브라우저에서 부를 수 없다', async () => {
      for (const [fn, args] of [
        ['lwb_anonymize_expired', {}],
        ['lwb_admin_ok', { p_event_id: EV, p_passcode: PASS }],
        ['lwb_validate_payload', { p_activity: {}, p_payload: {} }]
      ]) {
        const r = await rpc(fn, args);
        assert.ok(r.status >= 400, `${fn} 이 막혀야 합니다(HTTP ${r.status})`);
      }
    });
  });

  describe('관리자 설정 제한', () => {
    it('암호가 틀리면 거부', async () => {
      assert.equal((await setKey('open:pledge', 'Y', 'wrong-pass')).code, 'auth');
      assert.equal((await setKey('open:pledge', 'Y', PASS.toLowerCase())).code, 'auth');
      assert.equal((await setKey('open:pledge', 'Y', OTHER_PASS)).code, 'auth');
    });

    it('알 수 없는 키·없는 활동·ox 아닌 reveal 거부', async () => {
      for (const key of ['drop_table', 'open:nope', 'reveal:nope', 'reveal:practice', 'reveal:pledge',
        'open:', 'OPEN:ox1', 'materials_open ', 'require_both']) {
        assert.equal((await setKey(key, 'Y')).code, 'bad_key', key);
      }
    });

    it('값은 Y/N 만', async () => {
      for (const v of ['y', 'n', 'YES', '1', '', null]) {
        assert.equal((await setKey('open:ox1', v)).code, 'bad_value', String(v));
      }
    });

    it('허용된 키는 바뀐다', async () => {
      for (const key of ['open:practice', 'open:pledge', 'materials_open', 'reveal:ox1']) {
        assert.deepEqual(await setKey(key, 'Y'), { ok: true, key, value: 'Y' });
      }
      await setKey('materials_open', 'N');
      await setKey('reveal:ox1', 'N');
      const s = (await call('lwb_get_event', { p_event_id: EV })).settings;
      assert.deepEqual(s, {
        'open:ox1': 'Y', 'reveal:ox1': 'N', 'open:practice': 'Y', 'open:pledge': 'Y', materials_open: 'N'
      });
    });
  });

  describe('ox 검사·덮어쓰기·정답 은닉', () => {
    it('길이와 값이 틀리면 거부', async () => {
      const bad = [
        {}, { answers: null }, { answers: 'OXO' }, { answers: ['O', 'X'] }, { answers: ['O', 'X', 'O', 'X'] },
        { answers: ['o', 'x', 'o'] }, { answers: ['O', 'X', 'A'] }, { answers: ['O', 'X', 1] }, { answers: [] }
      ];
      for (const p of bad) assertInvalid(await submit('ox1', p, alice), JSON.stringify(p));
      assertInvalid(await submit('ox1', ['O', 'X', 'O'], alice), 'payload 가 배열');
    });

    it('통과하면 {ok:true} 만 돌려준다(점수·정답 여부 없음)', async () => {
      assert.deepEqual(await submit('ox1', { answers: ['O', 'X', 'O'] }, alice), { ok: true });
      assert.deepEqual(await submit('ox1', { answers: ['X', 'O', 'X'] }, alice), { ok: true });
    });

    it('다시 내면 덮어쓴다(한 건)', async () => {
      assert.deepEqual(await submit('ox1', { answers: ['X', 'X', 'X'], extra: 1 }, alice), { ok: true });
      const r = await restGet(`lwb_responses?select=*&event_id=eq.${EV}&activity_id=eq.ox1&participant_id=eq.${alice}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 1);
      assert.deepEqual(r.body[0].payload, { answers: ['X', 'X', 'X'] }, '정리된 payload 만 저장');
    });

    it('공개 전: 응답 표·연수 표·설정 표·연수 불러오기 어디에도 정답·점수가 없다', async () => {
      const responses = await restGet(`lwb_responses?select=*&event_id=eq.${EV}`);
      assert.equal(responses.status, 200);
      for (const row of responses.body) {
        assert.deepEqual(Object.keys(row).sort(),
          ['activity_id', 'created_at', 'event_id', 'id', 'participant_id', 'payload', 'updated_at']);
      }
      const events = await restGet(`lwb_events?select=*&id=eq.${EV}`);
      const settings = await restGet(`lwb_settings?select=*&event_id=eq.${EV}`);
      const participants = await restGet(`lwb_participants?select=*&event_id=eq.${EV}`);
      const ev = await call('lwb_get_event', { p_event_id: EV });
      for (const [label, obj] of [['lwb_responses', responses.body], ['lwb_events', events.body],
        ['lwb_settings', settings.body], ['lwb_participants', participants.body], ['lwb_get_event', ev]]) {
        for (const t of SECRET_TEXTS) assert.ok(!containsText(obj, t), `${label} 에 비밀 "${t}"`);
        assert.ok(!containsText(obj, '"score"'), `${label} 에 score`);
        assert.ok(!containsText(obj, '"panel"'), `${label} 에 panel`);
      }
      assert.deepEqual(ev.reveal, {});
    });

    it('비밀 표는 브라우저 키로 읽을 수 없다', async () => {
      const r = await restGet('lwb_event_secrets?select=*');
      const blocked = r.status !== 200 || (Array.isArray(r.body) && r.body.length === 0);
      assert.ok(blocked, `lwb_event_secrets 노출: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      const r2 = await restGet(`lwb_event_secrets?select=admin_hash,reveal&event_id=eq.${EV}`);
      assert.ok(r2.status !== 200 || r2.body.length === 0);
    });

    it('공개 후: 연수 불러오기에 정답·라벨·해설·패널이 내려오고, 끄면 다시 사라진다', async () => {
      await setKey('reveal:ox1', 'Y');
      const ev = await call('lwb_get_event', { p_event_id: EV });
      assert.deepEqual(ev.reveal.ox1.answers, ['O', 'X', 'O']);
      assert.deepEqual(ev.reveal.ox1.labels, ['시험라벨AI', '시험라벨사람', '시험라벨협업']);
      assert.equal(ev.reveal.ox1.notes.length, 3);
      assert.equal(ev.reveal.ox1.panel[0].name, '시험패널갑');
      assert.deepEqual(Object.keys(ev.reveal), ['ox1']);
      // 다른 연수에는 영향 없음
      assert.deepEqual((await call('lwb_get_event', { p_event_id: OTHER })).reveal, {});
      await setKey('reveal:ox1', 'N');
      assert.deepEqual((await call('lwb_get_event', { p_event_id: EV })).reveal, {});
    });
  });

  describe('stage_check 검사', () => {
    const item = { topic: { risk: '상', stage: 2, memo: '' } };

    it('학습목표는 반드시 고른다', async () => {
      for (const p of [
        { items: item }, { objective: null, items: item }, { objective: {}, items: item },
        { objective: { id: '' }, items: item }, { objective: 'obj-a', items: item }
      ]) {
        const r = await submit('practice', p, alice);
        assertInvalid(r, JSON.stringify(p));
        assert.equal(r.msg, '학습목표를 먼저 골라 주세요.');
      }
      assertInvalid(await submit('practice', { objective: { id: 'obj-zzz' }, items: item }, alice), '없는 보기');
    });

    it('직접 적기는 2~80자, 허용하지 않는 활동에서는 거부', async () => {
      assertInvalid(await submit('practice', { objective: { id: 'custom', text: '가' }, items: item }, alice), '1자');
      assertInvalid(await submit('practice', { objective: { id: 'custom', text: '  가  ' }, items: item }, alice), '공백 뗀 1자');
      assertInvalid(await submit('practice', { objective: { id: 'custom', text: '가'.repeat(81) }, items: item }, alice), '81자');
      assertInvalid(await submit('practice', { objective: { id: 'custom' }, items: item }, alice), '문장 없음');
      assert.deepEqual(await submit('practice', { objective: { id: 'custom', text: '가'.repeat(80) }, items: item }, alice), { ok: true });
      assert.deepEqual(await submit('practice', { objective: { id: 'custom', text: '가나' }, items: item }, alice), { ok: true });
      // 다른 연수(allowCustom:false)
      await setKey('open:practice', 'Y', OTHER_PASS, OTHER);
      assertInvalid(await submit('practice', { objective: { id: 'custom', text: '직접 적은 목표' }, items: item }, other, OTHER), '직접 적기 꺼짐');
      assert.deepEqual(await submit('practice', { objective: { id: 'obj-b' }, items: item }, other, OTHER), { ok: true });
    });

    it('적어도 한 항목은 채운다', async () => {
      for (const items of [undefined, {}, { topic: {} }, { topic: { risk: '', stage: null, memo: '   ' } }]) {
        const r = await submit('practice', { objective: { id: 'obj-a' }, items }, alice);
        assertInvalid(r, JSON.stringify(items));
        assert.equal(r.msg, '적어도 한 항목은 채워 주세요.');
      }
    });

    it('알 수 없는 항목·범위 밖 값 거부', async () => {
      const bad = [
        { nope: { stage: 1 } },
        { topic: { stage: 1 }, TOPIC: { stage: 1 } },
        { topic: { risk: '최상' } }, { topic: { risk: 1 } },
        { topic: { stage: 0 } }, { topic: { stage: 6 } }, { topic: { stage: 2.5 } }, { topic: { stage: '3' } },
        { topic: { memo: '가'.repeat(81) } }, { topic: { memo: 5 } },
        { topic: 'stage1' }, []
      ];
      for (const items of bad) {
        assertInvalid(await submit('practice', { objective: { id: 'obj-a' }, items }, alice), JSON.stringify(items));
      }
    });

    it('올바른 응답은 정리해서 저장한다', async () => {
      const payload = {
        objective: { id: 'obj-a', text: '무시됨' },
        items: {
          topic: { risk: '하', stage: 1, memo: '  스스로   정한다 ' },
          research: { risk: '상', stage: 3.0, memo: '가'.repeat(80) },
          draft: { risk: '', stage: null, memo: '' }
        },
        junk: true
      };
      assert.deepEqual(await submit('practice', payload, alice), { ok: true });
      const r = await restGet(`lwb_responses?select=payload&event_id=eq.${EV}&activity_id=eq.practice&participant_id=eq.${alice}`);
      assert.equal(r.body.length, 1);
      assert.deepEqual(r.body[0].payload, {
        objective: { id: 'obj-a' },
        items: {
          topic: { risk: '하', stage: 1, memo: '스스로 정한다' },
          research: { risk: '상', stage: 3, memo: '가'.repeat(80) },
          draft: { risk: '', stage: null, memo: '' }
        }
      });
    });
  });

  describe('sentence 검사', () => {
    it('틀 id 는 설정에 있는 것만', async () => {
      for (const p of [{ blank: '스스로 생각' }, { template: 'nope', blank: '스스로 생각' }, { template: 1, blank: '스스로 생각' }]) {
        assertInvalid(await submit('pledge', p, alice), JSON.stringify(p));
      }
    });

    it('빈칸은 2~60자', async () => {
      for (const blank of ['', '가', '  가  ', '가'.repeat(61), null, 12]) {
        assertInvalid(await submit('pledge', { template: 'student', blank }, alice), JSON.stringify(blank));
      }
      assert.deepEqual(await submit('pledge', { template: 'student', blank: '가'.repeat(60) }, alice), { ok: true });
      assert.deepEqual(await submit('pledge', { template: 'teacher', blank: '  근거를 먼저 모으게  ' }, alice), { ok: true });
      const r = await restGet(`lwb_responses?select=payload&event_id=eq.${EV}&activity_id=eq.pledge&participant_id=eq.${alice}`);
      assert.deepEqual(r.body[0].payload, { template: 'teacher', blank: '근거를 먼저 모으게' });
    });
  });

  describe('복원', () => {
    it('기기에 남은 id 로 다시 들어가면 내 응답이 함께 온다', async () => {
      const r = await call('lwb_restore', { p_event_id: EV, p_participant_id: alice });
      assert.equal(r.ok, true);
      assert.equal(r.participant.id, alice);
      assert.deepEqual(Object.keys(r.responses).sort(), ['ox1', 'pledge', 'practice']);
    });

    it('resume 은 같은 이름 가운데 가장 최근 참가자로 이어 가고 그 응답을 돌려준다', async () => {
      const first = (await join('복원 시험', 'new')).participant.id;
      const second = (await join('복원 시험', 'new')).participant.id;
      assert.deepEqual(await submit('pledge', { template: 'student', blank: '출처를 먼저 확인' }, second), { ok: true });
      const rs = await join('복원 시험', 'resume');
      assert.equal(rs.participant.id, second);
      assert.notEqual(rs.participant.id, first);
      assert.deepEqual(rs.responses, { pledge: { template: 'student', blank: '출처를 먼저 확인' } });
    });

    it('없는 id·형식 틀린 id·다른 연수 id 는 거부', async () => {
      for (const pid of [randomUUID(), 'ADMIN', 'x', other]) {
        assert.equal((await call('lwb_restore', { p_event_id: EV, p_participant_id: pid })).code, 'no_participant', pid);
      }
      assert.equal((await call('lwb_restore', { p_event_id: 'no-such-event-x', p_participant_id: alice })).code, 'no_event');
    });
  });

  describe('응답 비우기', () => {
    it('암호가 틀리면 거부하고 아무것도 지우지 않는다', async () => {
      assert.equal((await call('lwb_admin_reset', { p_event_id: EV, p_passcode: 'wrong' })).code, 'auth');
      assert.ok((await restGet(`lwb_participants?select=id&event_id=eq.${EV}`)).body.length > 0);
    });

    it('그 연수의 참가자·응답만 지우고 설정·진행 설정은 남긴다', async () => {
      const r = await call('lwb_admin_reset', { p_event_id: EV, p_passcode: PASS });
      assert.equal(r.ok, true);
      assert.ok(r.participants > 0 && r.responses > 0, JSON.stringify(r));
      assert.deepEqual((await restGet(`lwb_participants?select=id&event_id=eq.${EV}`)).body, []);
      assert.deepEqual((await restGet(`lwb_responses?select=id&event_id=eq.${EV}`)).body, []);
      const ev = await call('lwb_get_event', { p_event_id: EV });
      assert.equal(ev.ok, true);
      assert.equal(ev.event.activities.length, 3);
      assert.equal(ev.settings['open:ox1'], 'Y');
      assert.equal(ev.settings['open:practice'], 'Y');
      // 다른 연수는 그대로
      assert.equal((await restGet(`lwb_participants?select=id&event_id=eq.${OTHER}`)).body.length, 1);
      assert.equal((await restGet(`lwb_responses?select=id&event_id=eq.${OTHER}`)).body.length, 1);
      // 지운 참가자는 더 이상 제출할 수 없다
      assert.equal((await submit('ox1', { answers: ['O', 'O', 'O'] }, alice)).code, 'no_participant');
    });
  });

  describe('깨우기', () => {
    it('lwb_ping 은 가볍게 ok 를 돌려준다', async () => {
      const r = await call('lwb_ping', {});
      assert.equal(r.ok, true);
    });
  });
});
