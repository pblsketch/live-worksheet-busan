/**
 * 점검 명령(snapshot) 비교 규칙 (명세 1): 원격 없이 비교 로직만 검사한다
 *   - lwb_ 아닌 객체의 추가·삭제가 없어야 한다
 *   - lwb_ 아닌 표·함수·예약 작업(반곡고 lw_)은 정의 해시까지 그대로여야 한다
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareSnapshot, namesOf, takeSnapshot } from '../../tools/lib/snapshot.mjs';

const BASE = {
  version: 2,
  objects: [
    'cron:lw_anonymize', 'function:lw_join(p_event_id text, p_name text, p_mode text)', 'index:lw_participants_event_norm_idx',
    'policy:lw_events.lw_read_all', 'publication:supabase_realtime:lw_settings', 'table:lw_events', 'table:lw_settings'
  ],
  defs: {
    'cron:lw_anonymize': 'c1',
    'function:lw_join(p_event_id text, p_name text, p_mode text)': 'f1',
    'table:lw_events': 't1',
    'table:lw_settings': 't2'
  }
};
const clone = (x) => JSON.parse(JSON.stringify(x));
/** 부산 마이그레이션 뒤: lwb_ 객체가 더해진 상태 */
function after() {
  const s = clone(BASE);
  s.objects.push('table:lwb_events', 'function:lwb_join(p_event_id text, p_name text, p_mode text)',
    'policy:lwb_events.lwb_read_all', 'publication:supabase_realtime:lwb_settings', 'cron:lwb_anonymize',
    'sequence:lwb_responses_id_seq', 'index:lwb_participants_event_norm_idx');
  s.objects.sort();
  return s;
}

describe('snapshot 비교 규칙', () => {
  it('lwb_ 객체만 더해지고 반곡고 정의가 그대로면 통과', () => {
    const c = compareSnapshot(BASE, after());
    assert.equal(c.ok, true);
    assert.equal(c.added.length, 7);
    assert.deepEqual([c.badAdded, c.badRemoved, c.changed], [[], [], []]);
  });

  it('lw_ 함수의 정의(본문 해시)가 바뀌면 실패', () => {
    const s = after();
    s.defs['function:lw_join(p_event_id text, p_name text, p_mode text)'] = 'f2';
    const c = compareSnapshot(BASE, s);
    assert.equal(c.ok, false);
    assert.deepEqual(c.changed, ['function:lw_join(p_event_id text, p_name text, p_mode text)']);
  });

  it('lw_ 표의 정의(열·정책 해시)나 예약 작업이 바뀌거나 없어지면 실패', () => {
    const s = after();
    s.defs['table:lw_settings'] = 'x';
    delete s.defs['cron:lw_anonymize'];
    assert.deepEqual(compareSnapshot(BASE, s).changed.sort(), ['cron:lw_anonymize', 'table:lw_settings']);
  });

  it('lwb_ 아닌 객체가 새로 생기거나 사라지면 실패', () => {
    const s = after();
    s.objects.push('table:lw_new', 'function:helper()', 'publication:supabase_realtime:lw_extra', 'policy:lwb_events.read_all');
    s.objects = s.objects.filter((x) => x !== 'index:lw_participants_event_norm_idx');
    const c = compareSnapshot(BASE, s);
    assert.equal(c.ok, false);
    assert.deepEqual(c.badAdded.sort(), ['function:helper()', 'policy:lwb_events.read_all', 'publication:supabase_realtime:lw_extra', 'table:lw_new']);
    assert.deepEqual(c.badRemoved, ['index:lw_participants_event_norm_idx']);
  });

  it('lwb_ 객체가 사라지는 것은 부산 판 일이라 괜찮다', () => {
    const c = compareSnapshot(after(), BASE);
    assert.equal(c.ok, true);
    assert.equal(c.removed.length, 7);
  });

  it('옛 형식(목록만) 기준 파일은 정의를 비교할 수 없어 실패로 본다', () => {
    const c = compareSnapshot(BASE.objects, after());
    assert.equal(c.legacy, true);
    assert.equal(c.ok, false);
    assert.equal(compareSnapshot([], after()).ok, false);
  });

  it('이름 뽑기: 정책은 표와 정책, 발행은 표, 함수는 인자 앞', () => {
    assert.deepEqual(namesOf('policy:lwb_events.lwb_read_all'), ['lwb_events', 'lwb_read_all']);
    assert.deepEqual(namesOf('publication:supabase_realtime:lwb_settings'), ['lwb_settings']);
    assert.deepEqual(namesOf('function:lwb_fail(p_code text, p_msg text)'), ['lwb_fail']);
    assert.deepEqual(namesOf('cron:lwb_anonymize'), ['lwb_anonymize']);
  });

  it('스냅숏은 넘겨준 실행 함수로 뜨고, 정의 해시는 lwb_ 아닌 것만 모은다', async () => {
    const calls = [];
    const run = async (sql) => {
      calls.push(sql);
      if (/as k, c\.relkind/.test(sql) || /'rel'::text/.test(sql)) {
        return [{ k: 'rel', sub: 'r', name: 'lwb_events' }, { k: 'rel', sub: 'r', name: 'lw_events' }, { k: 'function', sub: '', name: 'lw_ping()' }];
      }
      if (/md5\(pg_get_functiondef/.test(sql)) return [{ k: 'function:lw_ping()', h: 'aa' }, { k: 'table:lw_events', h: 'bb' }];
      if (/to_regclass\('cron\.job'\)/.test(sql)) return [{ ok: true }];
      if (/from cron\.job/.test(sql)) return [{ jobname: 'lw_anonymize', h: 'cc' }, { jobname: 'lwb_anonymize', h: 'dd' }];
      throw new Error(`모르는 SQL: ${sql.slice(0, 60)}`);
    };
    const s = await takeSnapshot(run);
    assert.equal(s.version, 2);
    assert.deepEqual(s.objects, ['cron:lw_anonymize', 'cron:lwb_anonymize', 'function:lw_ping()', 'table:lw_events', 'table:lwb_events']);
    assert.deepEqual(s.defs, { 'cron:lw_anonymize': 'cc', 'function:lw_ping()': 'aa', 'table:lw_events': 'bb' });
    assert.ok(calls.every((q) => !/\b(insert|update|delete|create|alter|drop)\b/i.test(q)), '읽기만 한다');
  });
});
