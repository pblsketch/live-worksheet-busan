/**
 * 실시간 구조 (명세 2): 역할별 구독 표, 참가자 기기의 재조회 방식, 알림 묶기
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Live, NS, dbName, subscribedTables, rowsQuery, peekDelay, PEEK_MS, BATCH_MS, keys
} from '../../assets/core.js';

describe('이름 접두어', () => {
  it('표·서버 함수는 lwb_, 기기 저장소 키는 lwb: (반곡고 lw_ · lw: 와 섞이지 않는다)', () => {
    assert.equal(NS, 'lwb');
    assert.equal(dbName('join'), 'lwb_join');
    assert.equal(keys.participant('busan1019'), 'lwb:busan1019:pid');
    assert.equal(keys.admin('x'), 'lwb:x:admin');
    assert.equal(keys.draft('x', 'rewrite1'), 'lwb:x:draft:rewrite1');
    assert.equal(keys.peek('x'), 'lwb:x:peek');
  });
});

describe('역할별 구독 표 (subscribedTables)', () => {
  const ALL = ['lwb_settings', 'lwb_participants', 'lwb_responses'];

  it('참가자 기기는 무엇이 필요하든 진행 설정만 구독한다', () => {
    assert.deepEqual(subscribedTables('participant', []), ['lwb_settings']);
    assert.deepEqual(subscribedTables('participant', ['responses', 'participants']), ['lwb_settings']);
  });

  it('관리자·현황판은 진행 설정 + 지금 필요한 것', () => {
    for (const role of ['admin', 'board']) {
      assert.deepEqual(subscribedTables(role, ['participants', 'responses']), ALL, role);
      assert.deepEqual(subscribedTables(role, ['responses']), ['lwb_settings', 'lwb_responses'], role);
      assert.deepEqual(subscribedTables(role, []), ['lwb_settings'], role);
    }
  });

  it('모르는 역할은 참가자처럼 진행 설정만', () => {
    assert.deepEqual(subscribedTables('nobody', ['responses']), ['lwb_settings']);
  });
});

describe('표 읽기 주소 (rowsQuery)', () => {
  it('참가자 기기는 보고 있는 활동의 응답만, 이름은 id·이름만 받는다', () => {
    const r = rowsQuery('responses', { eventId: 'busan1019', role: 'participant', activity: 'ox' });
    assert.equal(r.table, 'responses');
    assert.match(r.query, /&activity_id=eq\.ox&/);
    assert.match(r.query, /event_id=eq\.busan1019/);
    const p = rowsQuery('participants', { eventId: 'busan1019', role: 'participant' });
    assert.match(p.query, /^select=id,name&/);
  });

  it('관리자·현황판은 모든 활동의 응답과 참가자 전체 칸', () => {
    for (const role of ['admin', 'board']) {
      assert.doesNotMatch(rowsQuery('responses', { eventId: 'e', role, activity: 'ox' }).query, /activity_id=eq/);
      assert.match(rowsQuery('participants', { eventId: 'e', role }).query, /^select=id,name,created_at,last_seen&/);
    }
  });
});

describe('참가자 기기의 재조회 간격 (peekDelay)', () => {
  it('15~25초 사이', () => {
    assert.deepEqual([...PEEK_MS], [15000, 25000]);
    assert.equal(peekDelay(0), 15000);
    assert.equal(peekDelay(1), 25000);
    assert.equal(peekDelay(0.5), 20000);
    for (let i = 0; i < 50; i++) {
      const d = peekDelay();
      assert.ok(d >= 15000 && d <= 25000, String(d));
    }
  });
});

describe('Live', () => {
  const setting = (key, value, event_id = 'ev') => ({ eventType: 'UPDATE', new: { event_id, key, value } });

  it('참가자 기기: 진행 설정 알림은 다시 불러오지 않고 바로 반영한다(정답 공개는 다시 불러온다)', () => {
    const l = new Live('ev');
    const seen = [];
    l.on((c) => seen.push([...c]));
    assert.equal(l.applySetting(setting('open:ox', 'Y')), true);
    assert.equal(l.isOpen('open:ox'), true);
    assert.deepEqual(seen, [['settings']]);
    assert.equal(l.applySetting(setting('open:ox', 'Y')), true); // 같은 값이면 알리지 않는다
    assert.equal(seen.length, 1);
    assert.equal(l.applySetting(setting('reveal:ox', 'Y')), false);
    assert.equal(l.applySetting(setting('open:ox', 'N', 'other')), false);
    assert.equal(l.applySetting({ eventType: 'DELETE', new: {} }), false);
    assert.equal(l.isOpen('open:ox'), true);
  });

  it('관리자·현황판은 진행 설정 알림도 다시 불러와 확인한다', () => {
    const l = new Live('ev', { role: 'board' });
    assert.equal(l.applySetting(setting('open:ox', 'Y')), false);
    l.setRole('admin');
    assert.equal(l.applySetting(setting('open:ox', 'Y')), false);
  });

  it('관리자·현황판: 응답 알림이 몰려와도 창 하나에 한 번만 다시 불러온다', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const l = new Live('ev', { role: 'board' });
    const calls = [];
    l.refresh = (kinds) => { calls.push(kinds); };
    l.needs = new Set(['participants', 'responses']);
    for (let i = 0; i < 40; i++) l.onChange('lwb_responses', { eventType: 'INSERT', new: { event_id: 'ev' } });
    assert.deepEqual(calls, []);
    t.mock.timers.tick(BATCH_MS - 1);
    assert.deepEqual(calls, []);
    t.mock.timers.tick(1);
    assert.deepEqual(calls, [['responses']]);
    // 창이 끝난 뒤에 온 알림은 다음 창에 묶인다
    l.onChange('lwb_responses', { eventType: 'UPDATE', new: { event_id: 'ev' } });
    l.onChange('lwb_responses', { eventType: 'UPDATE', new: { event_id: 'ev' } });
    t.mock.timers.tick(BATCH_MS);
    assert.deepEqual(calls, [['responses'], ['responses']]);
    assert.ok(BATCH_MS >= 300 && BATCH_MS <= 800);
  });

  it('지금 안 쓰는 데이터의 알림은 버려 두고 다시 필요할 때 받는다', () => {
    const l = new Live('ev', { role: 'admin' });
    l.refresh = () => { throw new Error('부르면 안 된다'); };
    l.data.responses = [];
    l.onChange('lwb_responses', { eventType: 'INSERT', new: {} });
    assert.equal(l.data.responses, null);
  });

  it('참가자 기기: 다른 활동으로 옮기면 들고 있던 응답을 버리고 새로 받는다', () => {
    const l = new Live('ev');
    const calls = [];
    l.refresh = (kinds) => { calls.push(kinds); };
    l.need(['responses'], { activity: 'ox' });
    assert.equal(l.scope, 'ox');
    assert.deepEqual(calls, [['responses']]);
    l.data.responses = [{ activity_id: 'ox' }];
    l.need(['responses'], { activity: 'ox' });            // 같은 화면을 다시 그림: 다시 받지 않는다
    assert.deepEqual(calls, [['responses']]);
    l.need(['responses'], { activity: 'grow' });
    assert.equal(l.data.responses, null);
    assert.deepEqual(calls, [['responses'], ['responses']]);
    // 관리자에게는 활동 범위가 없다
    l.setRole('admin');
    l.need(['responses'], { activity: 'grow' });
    assert.equal(l.scope, null);
  });

  it('제출 직후 한 번 다시 불러오되, 방금(1초 안) 불러온 것은 건너뛴다', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const l = new Live('ev');
    const calls = [];
    l.refresh = (kinds) => { calls.push(kinds); };
    l.needs = new Set(['responses', 'participants']);
    l.fetchedAt = { responses: Date.now() - 5000, participants: Date.now() };
    l.submitted();
    t.mock.timers.tick(0);
    assert.deepEqual(calls, [['responses']]);
  });
});
