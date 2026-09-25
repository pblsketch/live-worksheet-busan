/**
 * 자동 익명화 검사 (spec 4.4, 4.6, 7-B1)
 * 날짜를 앞당긴 시험 연수로 lwb_anonymize_expired() 를 직접 불러 확인한다.
 *   - 날짜 + 30일이 지난 연수: 이름이 '익명', 정규화 이름은 식별 불가 값, 응답은 남는다
 *   - 경계(정확히 30일 전)와 최근 연수: 그대로
 *   - 여러 번 돌아도 결과가 같다
 *   - 익명화된 참가자는 이어하기·복원이 되지 않는다(같은 이름은 새 참가자)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  call, runSql, lit, testId, testPasscode, tmpDir, removeDir, writeEventFiles, registerCli,
  deleteEvents, dayOffset
} from './helpers.mjs';

const OLD = testId('old');
const EDGE = testId('edge');
const NEW = testId('new');
const PASS = testPasscode();
const created = [OLD, EDGE, NEW];
let dir;
const pids = {};

function pubFor(id, date) {
  return {
    id, title: `익명화 시험 ${id}`, date, listed: false,
    activities: [{ id: 's1', type: 'sentence', title: '한 줄', templates: [{ id: 't', before: '나는', after: '하겠다.' }] }]
  };
}

const participantsOf = (id) => runSql(
  `select id, name, norm_name, anonymized_at from public.lwb_participants where event_id = ${lit(id)} order by created_at`
);
const responsesOf = (id) => runSql(
  `select participant_id, payload from public.lwb_responses where event_id = ${lit(id)} order by id`
);

describe('자동 익명화', () => {
  before(async () => {
    dir = tmpDir();
    const dates = { [OLD]: dayOffset(-45), [EDGE]: dayOffset(-30), [NEW]: dayOffset(0) };
    for (const id of created) {
      writeEventFiles(dir, id, pubFor(id, dates[id]), { admin_passcode: PASS });
      const r = registerCli(id, dir);
      assert.equal(r.code, 0, `등록 실패 ${id}: ${r.stderr}`);
      assert.equal((await call('lwb_admin_set', { p_event_id: id, p_key: 'open:s1', p_value: 'Y', p_passcode: PASS })).ok, true);
      const j = await call('lwb_join', { p_event_id: id, p_name: '이름 있는 사람', p_mode: 'new' });
      pids[id] = j.participant.id;
      assert.deepEqual(await call('lwb_submit', {
        p_event_id: id, p_participant_id: pids[id], p_activity_id: 's1', p_payload: { template: 't', blank: '끝까지 읽게' }
      }), { ok: true });
    }
  });

  after(async () => {
    try { await deleteEvents(created); } finally { removeDir(dir); }
  });

  let firstStamp;

  it('30일이 지난 연수만 이름을 지우고 응답은 남긴다', async () => {
    const [{ n }] = await runSql('select public.lwb_anonymize_expired() as n');
    assert.ok(n >= 1, `익명화된 행 수 ${n}`);

    const [p] = await participantsOf(OLD);
    assert.equal(p.name, '익명');
    assert.ok(p.anonymized_at, 'anonymized_at 이 적혀야 합니다');
    assert.notEqual(p.norm_name, '이름 있는 사람');
    assert.ok(!p.norm_name.includes('이름'), '정규화 이름에 원래 이름이 남으면 안 됩니다');
    firstStamp = p.anonymized_at;

    const rs = await responsesOf(OLD);
    assert.equal(rs.length, 1);
    assert.deepEqual(rs[0].payload, { template: 't', blank: '끝까지 읽게' });

    for (const id of [EDGE, NEW]) {
      const [q] = await participantsOf(id);
      assert.equal(q.name, '이름 있는 사람', `${id} 는 그대로여야 합니다`);
      assert.equal(q.anonymized_at, null);
    }
  });

  it('여러 번 돌아도 결과가 같다', async () => {
    await runSql('select public.lwb_anonymize_expired()');
    const [p] = await participantsOf(OLD);
    assert.equal(p.name, '익명');
    assert.equal(p.anonymized_at, firstStamp, '두 번째 실행이 다시 고치면 안 됩니다');
    assert.equal((await responsesOf(OLD)).length, 1);
    const [q] = await participantsOf(NEW);
    assert.equal(q.name, '이름 있는 사람');
  });

  it('익명화된 참가자는 이어하기·복원·제출이 되지 않는다', async () => {
    const c = await call('lwb_join', { p_event_id: OLD, p_name: '이름 있는 사람', p_mode: 'check' });
    assert.equal(c.created, true, '같은 이름은 새 참가자가 된다');
    assert.notEqual(c.participant.id, pids[OLD]);
    const r = await call('lwb_restore', { p_event_id: OLD, p_participant_id: pids[OLD] });
    assert.equal(r.code, 'no_participant');
    const s = await call('lwb_submit', {
      p_event_id: OLD, p_participant_id: pids[OLD], p_activity_id: 's1', p_payload: { template: 't', blank: '다시 내기' }
    });
    assert.equal(s.code, 'no_participant');
  });

  it('예약 작업 lwb_anonymize 가 매일 한 번 돌도록 등록되어 있다', async () => {
    const jobs = await runSql(`select schedule, command, active from cron.job where jobname = 'lwb_anonymize'`);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].active, true);
    assert.match(jobs[0].schedule, /^\d+ \d+ \* \* \*$/);
    assert.match(jobs[0].command, /lwb_anonymize_expired\(\)/);
  });
});
