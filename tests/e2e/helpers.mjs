/**
 * E2E 공용 도구: 실제 DB에 시험 연수(t-…-e2e)를 등록하고 끝나면 지운다.
 * 등록은 저장소의 등록 명령(tools/register-event.mjs)을 그대로 쓰고,
 * 지우기는 DB 검사와 같은 도구(관리 API)로 한다. 토큰은 .env.local 에서 도구가 직접 읽는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  testId, testPasscode, tmpDir, removeDir, samplePublic, sampleSecret,
  writeEventFiles, registerCli, deleteEvents, runSql, call, ROOT
} from '../db/helpers.mjs';

/**
 * 시험 연수에 가짜 참가자·응답을 넣는 도구. 브라우저와 같은 서버 함수(publishable key)를 그대로 부른다.
 *   const s = seeder(EV);  await s.open('ox1');  const pid = await s.join('이름');  await s.submit(pid, 'ox1', {...})
 */
export function seeder(ev) {
  const ok = (fn) => async (args) => {
    const r = await call(fn, args);
    if (!r || r.ok !== true) throw new Error(`${fn} 실패: ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  };
  const set = ok('lwb_admin_set');
  const join = ok('lwb_join');
  const submit = ok('lwb_submit');
  return {
    set: (key, value) => set({ p_event_id: ev.id, p_key: key, p_value: value, p_passcode: ev.passcode }),
    open: (activityId) => set({ p_event_id: ev.id, p_key: `open:${activityId}`, p_value: 'Y', p_passcode: ev.passcode }),
    join: async (name) => (await join({ p_event_id: ev.id, p_name: name, p_mode: 'new' })).participant.id,
    submit: (pid, activityId, payload) =>
      submit({ p_event_id: ev.id, p_participant_id: pid, p_activity_id: activityId, p_payload: payload })
  };
}

/**
 * events/sample.json 으로 시험 연수를 만든다(관리자 암호는 새로 만든 것).
 * 등록 중에 실패해도 만든 것은 지운다.
 * @returns {Promise<{ id: string, passcode: string, title: string }>}
 */
export async function createTestEvent(tag = 'e2e') {
  const id = testId(tag);
  const passcode = testPasscode();
  const dir = tmpDir();
  const pub = samplePublic(id);
  try {
    writeEventFiles(dir, id, pub, sampleSecret(passcode));
    const r = registerCli(id, dir);
    if (r.code !== 0) throw new Error(`시험 연수 등록 실패 (종료 코드 ${r.code}): ${r.stderr.slice(0, 500)}`);
  } catch (e) {
    await deleteEvents([id]).catch(() => {});
    throw e;
  } finally {
    removeDir(dir);
  }
  return { id, passcode, title: pub.title };
}

/**
 * events/busan1019.json 의 활동 다섯(grow · ox · rewrite1 · rewrite2 · pledge)으로 시험 연수를 만든다.
 * 비밀 파일은 읽지 않고 시험용 정답(모두 O)과 새 암호로 만든다.
 * @returns {Promise<{ id: string, passcode: string, title: string, pub: object }>}
 */
export async function createBusanTestEvent(tag = 'bsn') {
  const id = testId(tag);
  const passcode = testPasscode();
  const dir = tmpDir();
  const pub = JSON.parse(readFileSync(join(ROOT, 'events', 'busan1019.json'), 'utf8'));
  pub.id = id;
  pub.listed = false;
  const reveal = {};
  for (const a of pub.activities) if (a.type === 'ox') reveal[a.id] = { answers: a.questions.map(() => 'O') };
  try {
    writeEventFiles(dir, id, pub, { admin_passcode: passcode, reveal });
    const r = registerCli(id, dir);
    if (r.code !== 0) throw new Error(`시험 연수 등록 실패 (종료 코드 ${r.code}): ${r.stderr.slice(0, 500)}`);
  } catch (e) {
    await deleteEvents([id]).catch(() => {});
    throw e;
  } finally {
    removeDir(dir);
  }
  return { id, passcode, title: pub.title, pub };
}

export async function deleteTestEvent(id) {
  await deleteEvents([id]);
}

/** 강제로 끊긴 지난 실행이 남긴 E2E 시험 연수(2시간 넘은 것)를 지운다 */
export async function sweepStaleTestEvents() {
  await runSql(
    "delete from public.lwb_events where id like 't-%-e2e' and created_at < now() - interval '2 hours'"
  );
}
