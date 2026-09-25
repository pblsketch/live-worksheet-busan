#!/usr/bin/env node
/**
 * supabase/migrations/*.sql 을 이름 순서대로 관리 API(SQL 실행)로 적용한다.
 *
 *   node tools/apply-migrations.mjs              모든 마이그레이션 적용(여러 번 실행해도 안전)
 *   node tools/apply-migrations.mjs --snapshot   public 스키마 객체 목록·정의 해시를 출력하고
 *                                                supabase/baseline-snapshot.json 과 비교한다(읽기만)
 *   node tools/apply-migrations.mjs --snapshot --write <파일>  스냅숏을 파일로도 저장(기준 파일 만들기)
 *
 * 비교 규칙(부산 판): lwb_ 아닌 객체의 추가·삭제가 없고, lwb_ 아닌 표·함수·예약 작업(반곡고 lw_ 포함)은
 * 정의 해시까지 그대로여야 통과한다(tools/lib/snapshot.mjs).
 * 적용하기 전에 마이그레이션 SQL 을 검사해 lwb_ 아닌 객체를 건드리는 문장이 있으면 적용하지 않는다(tools/lib/sql-guard.mjs).
 *
 * 토큰은 .env.local 에서 읽고 절대 출력하지 않는다.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, runSql } from './lib/env.mjs';
import { takeSnapshot, compareSnapshot } from './lib/snapshot.mjs';
import { checkMigrationSql } from './lib/sql-guard.mjs';

const args = process.argv.slice(2);
const BASELINE = join(ROOT, 'supabase', 'baseline-snapshot.json');

async function applyAll() {
  const dir = join(ROOT, 'supabase', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) {
    console.error('마이그레이션 파일이 없습니다.');
    return 1;
  }
  // 하나라도 규칙을 어기면 아무것도 적용하지 않는다
  const sqls = files.map((f) => readFileSync(join(dir, f), 'utf8'));
  let bad = 0;
  files.forEach((f, i) => {
    for (const v of checkMigrationSql(sqls[i])) {
      bad++;
      console.error(`규칙 위반 ${f}: ${v.rule}${v.name ? ` (${v.name})` : ''} — ${v.text}`);
    }
  });
  if (bad) {
    console.error('lwb_ 아닌 객체를 건드리는 문장이 있어 적용하지 않았습니다.');
    return 1;
  }
  for (let i = 0; i < files.length; i++) {
    const t0 = Date.now();
    try {
      await runSql(sqls[i]);
      console.log(`ok    ${files[i]}  (${Date.now() - t0}ms)`);
    } catch (e) {
      console.log(`FAIL  ${files[i]}`);
      console.error(`      ${e.message}`);
      return 1;
    }
  }
  console.log(`\n${files.length}개 파일 적용 완료`);
  return 0;
}

async function snapshot() {
  const current = await takeSnapshot();
  console.log(JSON.stringify(current, null, 2));
  const wi = args.indexOf('--write');
  if (wi >= 0 && args[wi + 1]) {
    writeFileSync(args[wi + 1], JSON.stringify(current, null, 2) + '\n');
    console.error(`저장: ${args[wi + 1]}`);
    if (resolve(args[wi + 1]) === resolve(BASELINE)) {
      console.error('기준 파일을 새로 만들었습니다. 마이그레이션 뒤에 --write 없이 다시 돌려 비교합니다.');
      return 0;
    }
  }
  if (!existsSync(BASELINE)) {
    console.error(`\n기준 파일이 없습니다: 마이그레이션 전에 --write supabase/baseline-snapshot.json 으로 먼저 만드세요.`);
    return 1;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const cmp = compareSnapshot(baseline, current);
  console.error(`\n기준 대비: 추가 ${cmp.added.length}개, 삭제 ${cmp.removed.length}개`);
  if (cmp.legacy) {
    console.error('기준 파일이 옛 형식(정의 해시 없음)이라 비교할 수 없습니다. 마이그레이션 전 상태에서 다시 만드세요.');
    return 1;
  }
  if (!cmp.ok) {
    for (const x of cmp.badAdded) console.error(`  lwb_ 아닌 추가: ${x}`);
    for (const x of cmp.badRemoved) console.error(`  lwb_ 아닌 삭제: ${x}`);
    for (const x of cmp.changed) console.error(`  정의가 바뀜: ${x}`);
    console.error('규칙 위반: lwb_ 아닌 객체(반곡고 lw_ 포함)가 바뀌었습니다.');
    return 1;
  }
  const lw = Object.keys(current.defs).filter((k) => /^(function|table|cron):lw_/.test(k)).length;
  console.error(`규칙 통과: 새로 생긴 객체는 모두 lwb_ 이고, lwb_ 아닌 표·함수·예약 작업 ${Object.keys(baseline.defs).length}개(반곡고 lw_ ${lw}개)의 정의가 그대로입니다.`);
  return 0;
}

try {
  process.exitCode = args.includes('--snapshot') ? await snapshot() : await applyAll();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
