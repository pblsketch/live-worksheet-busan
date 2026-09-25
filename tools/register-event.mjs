#!/usr/bin/env node
/**
 * 연수 등록 명령
 *
 *   node tools/register-event.mjs <id>             검사하고 DB에 넣거나 갱신한다
 *   node tools/register-event.mjs <id> --dry-run   검사만 한다(DB에 접속하지 않는다)
 *   --dir <폴더>   설정 파일 폴더(기본: 저장소의 events/). 테스트용.
 *
 * 읽는 파일: <폴더>/<id>.json (공개, 저장소에 올림) + <폴더>/<id>.secret.json (비밀, 올리지 않음)
 * 하는 일:
 *   - 형식 검사. 틀리면 이유를 출력하고 1로 끝낸다.
 *   - lwb_events · lwb_event_secrets 를 넣거나 갱신한다(관리자 암호는 DB에서 pgcrypto로 해시).
 *   - 빠진 진행 설정만 N으로 만든다. 이미 있는 값은 덮어쓰지 않는다.
 *   - 비밀 파일에 암호가 없으면 12자 암호를 만들어 비밀 파일에 적고 한 번 출력한다.
 *   - 참가자 주소와 현황판 주소를 출력한다.
 * 종료 코드: 0 성공 · 1 검사 실패 · 2 사용법 오류 · 3 DB 오류
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT, SITE_URL, runSql } from './lib/env.mjs';
import { registerSql } from './lib/register-sql.mjs';
import {
  EVENT_ID_RE, validatePublic, validateSecret, settingKeys, generatePasscode
} from './lib/event-config.mjs';

function usage(msg) {
  if (msg) console.error(msg);
  console.error('사용법: node tools/register-event.mjs <연수 id> [--dry-run] [--dir <설정 폴더>]');
  process.exit(2);
}

const argv = process.argv.slice(2);
let id = null;
let dryRun = false;
let dir = join(ROOT, 'events');
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--dir') { if (!argv[i + 1]) usage('--dir 뒤에 폴더가 필요합니다.'); dir = resolve(argv[++i]); }
  else if (a.startsWith('--')) usage(`알 수 없는 옵션: ${a}`);
  else if (id === null) id = a;
  else usage(`인자가 너무 많습니다: ${a}`);
}
if (!id) usage();

const show = (p) => relative(process.cwd(), p) || p;
const fail = (title, list) => {
  console.error(`검사 실패: ${title}`);
  for (const e of list) console.error(`  - ${e}`);
  process.exit(1);
};

if (!EVENT_ID_RE.test(id)) fail(`연수 id "${id}"`, ['소문자·숫자·하이픈 3~40자여야 합니다.']);

const pubPath = join(dir, `${id}.json`);
const secPath = join(dir, `${id}.secret.json`);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    fail(show(path), [`JSON을 읽을 수 없습니다: ${e.message}`]);
  }
}

if (!existsSync(pubPath)) fail(show(pubPath), ['공개 설정 파일이 없습니다.']);
const pub = readJson(pubPath);
const pv = validatePublic(id, pub);
for (const w of pv.warnings) console.warn(`주의: ${w}`);
if (pv.errors.length) fail(show(pubPath), pv.errors);

const hasSecret = existsSync(secPath);
const sec = hasSecret ? readJson(secPath) : {};
if (!hasSecret && dryRun) {
  console.warn(`주의: 비밀 파일(${show(secPath)})이 없어 공개 설정만 검사했습니다. 실제 등록에는 비밀 파일이 필요합니다.`);
} else {
  const sv = validateSecret(pub, sec);
  for (const w of sv.warnings) console.warn(`주의: ${w}`);
  if (sv.errors.length) fail(show(secPath), sv.errors);
}

const keys = settingKeys(pub);
const siteLinks = () => {
  console.log(`참가자 주소: ${SITE_URL}?e=${id}`);
  console.log(`현황판 주소: ${SITE_URL}board.html?e=${id}`);
};

if (dryRun) {
  console.log(`검사 통과: ${id} (활동 ${pub.activities.length}개, 진행 설정 키 ${keys.length}개) — --dry-run 이라 DB에는 쓰지 않았습니다.`);
  siteLinks();
  process.exit(0);
}

// 암호가 없으면 새로 만들어 비밀 파일에 적는다(DB 반영보다 먼저: 잃어버리지 않게)
let passcode = typeof sec.admin_passcode === 'string' ? sec.admin_passcode : '';
let generated = false;
if (!passcode) {
  passcode = generatePasscode(12);
  generated = true;
  const { admin_passcode: _old, ...restSec } = sec;
  writeFileSync(secPath, JSON.stringify({ admin_passcode: passcode, ...restSec }, null, 2) + '\n', 'utf8');
}

const sql = registerSql(id, pub, sec, passcode);

let result;
try {
  result = await runSql(sql, { secrets: [passcode] });
} catch (e) {
  console.error(`DB 반영 실패: ${e.message}`);
  if (generated) console.error(`(새로 만든 관리자 암호는 ${show(secPath)} 에 적혀 있습니다. 다시 실행하면 그 암호를 씁니다.)`);
  process.exit(3);
}

const row = Array.isArray(result) ? result[0] : null;
if (!row || row.secrets !== 1) {
  console.error('DB 반영 결과를 확인할 수 없습니다.');
  process.exit(3);
}

console.log(`등록 완료: ${id} · ${pub.title.trim()} (${pub.date}, 목록 노출 ${pub.listed === true ? '예' : '아니오'})`);
console.log(`활동 ${pub.activities.length}개: ${pub.activities.map((a) => `${a.id}(${a.type})`).join(', ')}`);
console.log(row.inserted.length
  ? `새로 만든 진행 설정(N): ${row.inserted.join(', ')}`
  : '진행 설정: 모두 이미 있어 그대로 두었습니다.');
if (row.stale.length) console.log(`참고: 설정에 없는 활동의 진행 설정이 남아 있습니다(쓰이지 않음): ${row.stale.join(', ')}`);
if (generated) {
  console.log(`관리자 암호(새로 만듦, ${show(secPath)} 에 저장됨 — 한 번만 보여 줍니다): ${passcode}`);
}
siteLinks();
