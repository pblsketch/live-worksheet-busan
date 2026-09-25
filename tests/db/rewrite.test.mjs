/**
 * rewrite 서버 검사 (lwb_validate_rewrite, 명세 3)
 *   npm run test:db   (실제 DB. 시험 연수 t-…-rw 를 만들고 끝나면 지운다)
 * 같은 검사를 원격 없이 돌리는 것은 tests/pglite/ 에 있다.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  call, restGet, testId, testPasscode, tmpDir, removeDir, samplePublic, sampleSecret,
  writeEventFiles, registerCli, deleteEvents
} from './helpers.mjs';

const EV = testId('rw');
const PASS = testPasscode();
let dir;

const PROMPTS = [
  { id: 'a', text: '예상 독자를 매우 잘 고려하여 건의문을 훌륭하게 작성함.' },
  { id: 'b', text: '복잡한 사회적 쟁점을 다루는 어려운 건의문을 완성도 높게 작성함.' }
];

const submit = (activity, payload, pid) =>
  call('lwb_submit', { p_event_id: EV, p_participant_id: pid, p_activity_id: activity, p_payload: payload });
const invalid = async (activity, payload, pid, msg) => {
  const r = await submit(activity, payload, pid);
  assert.deepEqual(r, { ok: false, code: 'invalid', msg }, JSON.stringify(payload));
};

describe('rewrite 서버 검사', () => {
  let pid;

  before(async () => {
    dir = tmpDir();
    const pub = samplePublic(EV);
    pub.activities.push(
      { id: 'rw1', type: 'rewrite', title: '1차', round: 1, level: '잘함', prompts: PROMPTS, maxLength: 20 },
      { id: 'rw2', type: 'rewrite', title: '2차', round: 2, pairOf: 'rw1', prompts: PROMPTS }
    );
    writeEventFiles(dir, EV, pub, sampleSecret(PASS));
    const r = registerCli(EV, dir);
    assert.equal(r.code, 0, `등록 실패: ${r.stderr}`);
    for (const k of ['open:rw1', 'open:rw2']) {
      assert.equal((await call('lwb_admin_set', { p_event_id: EV, p_key: k, p_value: 'Y', p_passcode: PASS })).ok, true);
    }
    pid = (await call('lwb_join', { p_event_id: EV, p_name: '시험 고쳐 쓰기', p_mode: 'new' })).participant.id;
  });

  after(async () => {
    try { await deleteEvents([EV]); } finally { removeDir(dir); }
  });

  it('정리해서 저장한다: 앞뒤 공백, 줄 바꿈·연속 공백은 공백 하나, 모르는 칸은 버린다', async () => {
    assert.deepEqual(await submit('rw1', { prompt: 'a', text: '  학생이\n질문을   미리 적음 ', x: 1 }, pid), { ok: true });
    const r = await restGet(`lwb_responses?select=payload&event_id=eq.${EV}&activity_id=eq.rw1&participant_id=eq.${pid}`);
    assert.deepEqual(r.body[0].payload, { prompt: 'a', text: '학생이 질문을 미리 적음' });
  });

  it('5자 미만, maxLength(여기서는 20) 초과, 모르는 문장, 글이 아닌 값은 거부', async () => {
    await invalid('rw1', { prompt: 'a', text: '네글자다' }, pid, '5자 이상 적어 주세요.');
    await invalid('rw1', { prompt: 'a', text: '가'.repeat(21) }, pid, '20자 이내로 적어 주세요.');
    await invalid('rw1', { prompt: 'z', text: '충분히 긴 문장' }, pid, '고쳐 쓸 문장을 골라 주세요.');
    await invalid('rw1', { text: '충분히 긴 문장' }, pid, '고쳐 쓸 문장을 골라 주세요.');
    await invalid('rw1', { prompt: 'a', text: 12345 }, pid, '고쳐 쓴 문장을 적어 주세요.');
    // maxLength 가 없으면 200
    assert.deepEqual(await submit('rw2', { prompt: 'b', text: '가'.repeat(200) }, pid), { ok: true });
    await invalid('rw2', { prompt: 'b', text: '가'.repeat(201) }, pid, '200자 이내로 적어 주세요.');
  });

  it('열려 있는 동안은 다시 내서 고친다((연수, 활동, 참가자)마다 1건)', async () => {
    assert.deepEqual(await submit('rw1', { prompt: 'b', text: '고쳐서 다시 낸 문장' }, pid), { ok: true });
    const r = await restGet(`lwb_responses?select=payload&event_id=eq.${EV}&activity_id=eq.rw1&participant_id=eq.${pid}`);
    assert.equal(r.body.length, 1);
    assert.deepEqual(r.body[0].payload, { prompt: 'b', text: '고쳐서 다시 낸 문장' });
  });

  it('닫히면 거부', async () => {
    assert.equal((await call('lwb_admin_set', { p_event_id: EV, p_key: 'open:rw1', p_value: 'N', p_passcode: PASS })).ok, true);
    const r = await submit('rw1', { prompt: 'a', text: '닫힌 뒤에 낸 문장' }, pid);
    assert.equal(r.code, 'closed');
  });
});
