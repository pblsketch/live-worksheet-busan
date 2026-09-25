/**
 * 부하 시험 도구 (명세 6): 원격 없이 볼 수 있는 것만
 *   npm run test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { quantile, fakePayload } from '../../tools/load-test.mjs';
import { tidy } from '../../assets/activities/rewrite.js';

const SCRIPT = fileURLToPath(new URL('../../tools/load-test.mjs', import.meta.url));
const PUB = JSON.parse(readFileSync(new URL('../../events/busan1019.json', import.meta.url), 'utf8'));

describe('부하 시험 도구', () => {
  it('--confirm-remote 가 없으면 아무 요청도 보내지 않고 사용법만 출력한다', () => {
    // 접속 정보를 일부러 틀리게 줘도(요청을 보내면 실패할 곳) 0 으로 끝나야 한다
    const env = { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ACCESS_TOKEN: 'x', SUPABASE_PROJECT_REF: 'x' };
    const r = spawnSync(process.execPath, [SCRIPT, '--n', '5'], { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--confirm-remote 가 없어 아무 요청도 보내지 않았습니다/);
    const bad = spawnSync(process.execPath, [SCRIPT, '--n', '0', '--confirm-remote'], { encoding: 'utf8', env, timeout: 10000 });
    assert.equal(bad.status, 2);
  });

  it('분위 계산', () => {
    const xs = [5, 1, 4, 2, 3, 6, 7, 8, 9, 10];
    assert.equal(quantile(xs, 0.5), 5);
    assert.equal(quantile(xs, 0.95), 10);
    assert.equal(quantile(xs, 1), 10);
    assert.equal(quantile([], 0.5), null);
  });

  it('흉내 payload 는 busan1019 활동마다 서버 규칙에 맞는다', () => {
    for (const a of PUB.activities) {
      for (let i = 0; i < 5; i++) {
        const p = fakePayload(a, i);
        if (a.type === 'ox') {
          assert.equal(p.answers.length, a.questions.length);
          assert.ok(p.answers.every((x) => x === 'O' || x === 'X'));
        } else if (a.type === 'sentence') {
          assert.ok(a.templates.some((t) => t.id === p.template));
          assert.ok([...p.blank].length >= 2 && [...p.blank].length <= 60);
        } else if (a.type === 'rewrite') {
          assert.deepEqual(tidy(a, p), { ok: true, payload: p });
        }
      }
    }
  });
});
