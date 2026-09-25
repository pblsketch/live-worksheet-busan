#!/usr/bin/env node
/**
 * 로컬 흉내 서버에 대고 검사를 돌린다(원격 Supabase 에는 닿지 않는다).
 *   node tests/local/run.mjs db         tests/db/*.test.mjs (서버 함수·등록·익명화·스키마·rewrite)
 *   node tests/local/run.mjs load [n]   tools/load-test.mjs --confirm-remote --n <n> (흉내 서버를 '원격' 삼아)
 *
 * 흉내 서버(tests/local/server.mjs)를 이 프로세스에서 띄우고, 접속 정보 환경 변수를 모두 127.0.0.1 로 바꿔
 * 자식 프로세스로 검사를 돌린다. 환경 변수가 .env.local 보다 우선하므로 원격으로 새지 않는다.
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startMock, MOCK_KEY } from './server.mjs';
import { ROOT } from './pg.mjs';

const [what = 'db', arg] = process.argv.slice(2);
const port = Number(process.env.LWB_LOCAL_PORT || 4176);

const mock = await startMock({ port });
const env = {
  ...process.env,
  SUPABASE_URL: mock.url,
  SUPABASE_API_URL: mock.url,
  SUPABASE_PUBLISHABLE_KEY: MOCK_KEY,
  SUPABASE_PROJECT_REF: 'local',
  SUPABASE_ACCESS_TOKEN: 'local-mock-token'
};
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(env.SUPABASE_URL)) throw new Error('흉내 서버 주소가 아닙니다.');
console.log(`로컬 흉내 Supabase ${mock.url} 에 대고 검사합니다.`);

let args;
if (what === 'db') {
  const files = readdirSync(join(ROOT, 'tests', 'db')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join('tests', 'db', f));
  args = ['--test', '--test-concurrency=1', ...files];
} else if (what === 'load') {
  args = [join('tools', 'load-test.mjs'), '--confirm-remote', '--n', String(arg || 100)];
} else {
  console.error('사용법: node tests/local/run.mjs db | load [n]');
  process.exit(2);
}

const code = await new Promise((resolve) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  p.on('exit', (c) => resolve(c ?? 1));
});
await mock.close();
process.exit(code);
