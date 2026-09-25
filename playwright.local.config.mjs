/**
 * 브라우저 E2E를 로컬 흉내 Supabase(tests/local/server.mjs, PGlite)에 대고 돌린다. 원격에는 닿지 않는다.
 *   npm run test:local-e2e
 * - 검사 도구(시험 연수 등록·가짜 응답)가 쓰는 접속 정보를 모두 흉내 서버로 바꾼다(환경 변수가 .env.local 보다 우선).
 * - 브라우저는 127.0.0.1 말고는 이름을 풀지 못하게 해서(글꼴 CDN 포함) 바깥으로 요청이 나가지 않게 한다.
 * 실제 DB로 돌리는 설정은 playwright.config.mjs(npm run test:e2e)다.
 */
import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.LWB_LOCAL_PORT || 4175);
const BASE = `http://127.0.0.1:${PORT}`;

Object.assign(process.env, {
  SUPABASE_URL: BASE,
  SUPABASE_API_URL: BASE,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_mock',
  SUPABASE_PROJECT_REF: 'local',
  SUPABASE_ACCESS_TOKEN: 'local-mock-token',
  LWB_LOCAL_MOCK: BASE
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.mjs',
  use: {
    baseURL: `${BASE}/`,
    browserName: 'chromium',
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'] }
  },
  webServer: {
    command: `node tests/local/server.mjs ${PORT}`,
    url: `${BASE}/index.html`,
    reuseExistingServer: false,
    timeout: 90_000
  }
});
