/**
 * 로컬 접속 정보(.env.local)와 Supabase 호출을 한곳에서 다룬다.
 *
 * - 토큰 값은 이 모듈 밖으로 문자열로 내보내지 않는다. 오류 메시지에 섞여 들어가도
 *   scrub()이 지운다. 호출하는 쪽도 토큰을 출력하지 않는다.
 * - 관리 API(SQL 실행)는 로컬 도구(마이그레이션·등록·테스트)만 쓴다.
 *   브라우저는 publishable key와 서버 함수(RPC)만 쓴다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** 저장소 루트 (tools/lib/ 의 두 단계 위) */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 참가자·현황판 주소의 기준 (GitHub Pages) */
export const SITE_URL = 'https://pblsketch.github.io/live-worksheet-busan/';

let cache = null;

/**
 * .env.local 을 읽어 키-값 객체로 돌려준다. 같은 이름의 환경 변수가 있으면 그것이 이긴다
 * (나중에 CI에서 환경 변수로 넣을 수 있게).
 */
export function loadEnv() {
  if (cache) return cache;
  const file = join(ROOT, '.env.local');
  const out = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  }
  for (const k of ['SUPABASE_PROJECT_REF', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ACCESS_TOKEN']) {
    if (process.env[k]) out[k] = process.env[k];
  }
  cache = out;
  return out;
}

function need(key) {
  const v = loadEnv()[key];
  if (!v) throw new Error(`.env.local 에 ${key} 가 없습니다.`);
  return v;
}

/** 오류 메시지 등에서 토큰(과 호출자가 넘긴 비밀 문자열)을 지운다. */
export function scrub(text, extra = []) {
  let s = String(text ?? '');
  const secrets = [loadEnv().SUPABASE_ACCESS_TOKEN, ...extra].filter((x) => x && x.length >= 4);
  for (const sec of secrets) s = s.split(sec).join('***');
  return s;
}

/**
 * 관리 API로 SQL을 실행하고 마지막 문장의 결과 행 배열을 돌려준다.
 * 실패하면 토큰이 지워진 메시지로 Error를 던진다.
 * @param {string} query
 * @param {{ secrets?: string[] }} [opt] 오류 메시지에서 지울 문자열(예: 관리자 암호)
 */
export async function runSql(query, opt = {}) {
  const ref = need('SUPABASE_PROJECT_REF');
  const token = need('SUPABASE_ACCESS_TOKEN');
  const extra = opt.secrets || [];
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
    } catch (e) {
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      throw new Error(scrub(`관리 API 연결 실패: ${e.message}`, extra));
    }
    // 요청 한도(429)나 일시 오류(5xx)는 잠깐 쉬었다가 두 번까지 다시 시도한다.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(res.status === 429 ? 5000 * (attempt + 1) : 1000 * (attempt + 1));
      continue;
    }
    break;
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* 본문 그대로 */ }
    const err = new Error(scrub(`관리 API HTTP ${res.status}: ${String(msg).slice(0, 2000)}`, extra));
    err.status = res.status;
    throw err;
  }
  try { return JSON.parse(text); } catch { return text; }
}

/** PostgREST 기준 주소와 publishable key 헤더 (브라우저와 같은 권한) */
export function restBase() {
  return {
    url: need('SUPABASE_URL').replace(/\/+$/, ''),
    headers: (() => {
      const k = need('SUPABASE_PUBLISHABLE_KEY');
      return { apikey: k, Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' };
    })()
  };
}

/** 서버 함수(RPC)를 publishable key로 부른다. { status, body } 를 돌려준다. */
export async function rpc(fn, args = {}) {
  const { url, headers } = restBase();
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 그대로 */ }
  return { status: r.status, body };
}

/** 공개 표를 publishable key로 읽는다. path 예: 'lwb_events?select=id&id=eq.x' */
export async function restGet(path) {
  const { url, headers } = restBase();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers });
  const text = await r.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* 그대로 */ }
  return { status: r.status, body };
}

/** SQL 문자열 리터럴. standard_conforming_strings=on(기본값) 기준 */
export function lit(v) {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  if (s.includes('\0')) throw new Error('NUL 문자는 쓸 수 없습니다.');
  return `'${s.replace(/'/g, "''")}'`;
}

/** jsonb 리터럴 */
export function jsonLit(obj) {
  return `${lit(JSON.stringify(obj))}::jsonb`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
