/**
 * DB 검사 공용 도구.
 * - 서버 함수와 공개 표는 브라우저와 같은 publishable key로 부른다(PostgREST).
 * - 시험 연수 만들기·지우기 같은 준비와 정리는 관리 API(SQL 실행)로 직접 한다.
 * - 시험 연수 id 는 모두 "t-" 로 시작하고, 각 파일의 after() 가 만든 것을 모두 지운다.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ROOT, runSql, rpc, restGet, restBase, lit } from '../../tools/lib/env.mjs';

export { runSql, rpc, restGet, restBase, lit, ROOT };

const REGISTER = join(ROOT, 'tools', 'register-event.mjs');

/** 시험 연수 id: t-<시각>-<난수>-<꼬리표> (id 형식 3~40자 안) */
export function testId(tag) {
  const base = `t-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  return `${base}-${tag}`.slice(0, 40).replace(/-+$/, '');
}

/** 시험용 관리자 암호: 대소문자가 섞인 12자 */
export function testPasscode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  let s = 'Tq';
  for (const b of bytes) s += chars[b % chars.length];
  return s + '7z'; // 대문자·소문자·숫자가 모두 들어간다
}

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'lwb-test-'));
}

export function removeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 무시 */ }
}

/** 저장소의 events/sample.json 을 읽어 id 만 바꾼 공개 설정 */
export function samplePublic(id) {
  const pub = JSON.parse(readFileSync(join(ROOT, 'events', 'sample.json'), 'utf8'));
  pub.id = id;
  return pub;
}

/** 샘플(ox1 문항 3개)에 맞춘 비밀 설정 */
export function sampleSecret(passcode) {
  return {
    ...(passcode ? { admin_passcode: passcode } : {}),
    reveal: {
      ox1: {
        answers: ['O', 'X', 'O'],
        labels: ['시험라벨AI', '시험라벨사람', '시험라벨협업'],
        notes: ['시험해설하나', '시험해설둘', '시험해설셋'],
        panel: [
          { name: '시험패널갑', desc: '설명 갑', picks: ['O', 'O', 'O'], score: '2/3' },
          { name: '시험패널을', desc: '설명 을', picks: ['X', 'O', 'X'], score: '0/3' }
        ]
      }
    }
  };
}

/** 설정 파일 두 개를 폴더에 쓴다(secret 이 null 이면 비밀 파일을 만들지 않는다) */
export function writeEventFiles(dir, id, pub, secret) {
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(pub, null, 2));
  if (secret !== null && secret !== undefined) {
    writeFileSync(join(dir, `${id}.secret.json`), JSON.stringify(secret, null, 2));
  }
}

/** 등록 명령을 실제로 실행한다 */
export function registerCli(id, dir, extra = []) {
  const args = [REGISTER, id, ...(dir ? ['--dir', dir] : []), ...extra];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 서버 함수를 부르고 HTTP 200 인지 확인한 뒤 본문을 돌려준다 */
export async function call(fn, args) {
  const r = await rpc(fn, args);
  if (r.status !== 200) throw new Error(`${fn} HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
}

/** 시험 연수와 딸린 것 모두 지우기(비밀·참가자·응답·설정은 on delete cascade) */
export async function deleteEvents(ids) {
  const list = [...ids].filter((x) => typeof x === 'string' && x.startsWith('t-'));
  if (!list.length) return;
  await runSql(`delete from public.lwb_events where id = any(array[${list.map(lit).join(', ')}]::text[])`);
}

/** 오늘 날짜(UTC, DB의 current_date 기준)에서 n일 더한 YYYY-MM-DD */
export function dayOffset(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 객체 안 어디든 이 문자열이 들어 있는지 */
export function containsText(obj, text) {
  return JSON.stringify(obj).includes(text);
}
