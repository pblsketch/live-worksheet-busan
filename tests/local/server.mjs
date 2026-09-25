/**
 * 로컬 흉내 Supabase — 원격 없이 화면·서버 함수·실시간·DB 검사·E2E 를 돌려 보는 곳
 *   node tests/local/server.mjs [포트]   (기본 4175, 127.0.0.1)
 *
 * 한 포트에서
 *   /                                   저장소 정적 파일(GitHub Pages 처럼). assets/config.js 만 이 서버를 가리키게 바꿔 준다.
 *                                       점 파일·node_modules·*.secret.json 은 보여 주지 않는다
 *   POST /rest/v1/rpc/<함수>             PostgREST 흉내: anon 역할로 public.<함수>(이름 붙인 인자)
 *   GET·PATCH·POST·DELETE /rest/v1/<표>  PostgREST 흉내: select·조건(eq neq is gt gte lt lte in)·order. anon 권한 그대로
 *   POST /v1/projects/<ref>/database/query  관리 API 흉내: SQL 실행(마지막 문장의 행)
 *   /realtime/v1/websocket              Realtime(Phoenix 채널, vsn 1.0.0) 흉내: postgres_changes 만.
 *                                       발행된 표의 트리거 → pg_notify → 구독 조건(event_id=eq.…)이 맞는 채널에 보낸다
 *   GET /__mock/stats                   소켓별 구독 표와 받은 알림 수(역할별 구독 확인용)
 * DB 는 PGlite(메모리): Supabase 흉내 → 반곡고 lw_ → 부산 lwb_ 마이그레이션 (tests/local/pg.mjs)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createDb, ROOT } from './pg.mjs';

export const MOCK_KEY = 'sb_publishable_local_mock';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
const IDENT = /^[a-z_][a-z0-9_]*$/;

function blocked(rel) {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  return parts.some((p) => p.startsWith('.') || p === 'node_modules') || /\.secret\.json$/i.test(rel);
}

function status(e) {
  const code = e && e.code;
  if (code === '42501') return 401;            // 권한 없음(PostgREST: 익명이면 401)
  if (code === '42883' || code === '42P01') return 404; // 없는 함수·표
  return 400;
}

/**
 * 흉내 서버를 띄운다.
 * @returns {Promise<{ url: string, port: number, db: import('@electric-sql/pglite').PGlite, close: () => Promise<void> }>}
 */
export async function startMock({ port = 4175, host = '127.0.0.1', bangok = true } = {}) {
  const db = await createDb({ bangok, busan: true, realtime: true });
  const base = `http://${host}:${port}`;
  const fnCache = new Map();

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const fail = (res, e) => json(res, status(e), { code: e.code || 'mock', message: String(e.message || e) });
  const asAnon = (sql, params) => db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, params)).rows;
  });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    return JSON.parse(text);
  }

  /* ─── 서버 함수 ─── */
  async function rpc(res, fn, body) {
    if (!IDENT.test(fn)) return json(res, 404, { code: 'PGRST202', message: '함수 이름' });
    if (!fnCache.has(fn)) {
      const r = await db.query(`select p.proargnames as names,
                                       array(select format_type(t, null) from unnest(p.proargtypes) t) as types
                                  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                 where n.nspname = 'public' and p.proname = $1 limit 1`, [fn]);
      fnCache.set(fn, r.rows[0] || null);
    }
    const def = fnCache.get(fn);
    const args = body && typeof body === 'object' ? body : {};
    if (!def) return json(res, 404, { code: 'PGRST202', message: `없는 함수: ${fn}` });
    const names = def.names || [];
    const keys = Object.keys(args);
    if (keys.some((k) => !names.includes(k))) return json(res, 404, { code: 'PGRST202', message: '인자가 맞는 함수가 없습니다' });
    const params = [];
    const list = keys.map((k, i) => {
      const t = def.types[names.indexOf(k)];
      const v = args[k];
      params.push(v === null || v === undefined ? null : (t === 'jsonb' || t === 'json' ? JSON.stringify(v) : String(v)));
      return `${k} => $${i + 1}::${t}`;
    });
    try {
      const rows = await asAnon(`select public.${fn}(${list.join(', ')}) as r`, params);
      json(res, 200, rows[0] ? rows[0].r : null);
    } catch (e) { fail(res, e); }
  }

  /* ─── 표 ─── */
  function where(sp, params) {
    const conds = [];
    for (const [k, raw] of sp) {
      if (k === 'select' || k === 'order' || k === 'limit') continue;
      if (!IDENT.test(k)) throw Object.assign(new Error(`칸 이름: ${k}`), { code: 'PGRST100' });
      const m = /^(eq|neq|is|gt|gte|lt|lte|in)\.(.*)$/s.exec(raw);
      if (!m) throw Object.assign(new Error(`조건: ${raw}`), { code: 'PGRST100' });
      const [, op, v] = m;
      if (op === 'is') {
        if (!['true', 'false', 'null'].includes(v)) throw Object.assign(new Error(`is 값: ${v}`), { code: 'PGRST100' });
        conds.push(`${k} is ${v}`);
      } else if (op === 'in') {
        params.push(v.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim().replace(/^"|"$/g, '')));
        conds.push(`${k}::text = any($${params.length}::text[])`);
      } else {
        params.push(v);
        const sym = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
        conds.push(`${k}::text ${sym} $${params.length}::text`);
      }
    }
    return conds.length ? ` where ${conds.join(' and ')}` : '';
  }

  async function table(req, res, name, sp) {
    if (!IDENT.test(name)) return json(res, 404, { message: '표 이름' });
    const params = [];
    try {
      const cond = where(sp, params);
      if (req.method === 'GET' || req.method === 'HEAD') {
        const sel = (sp.get('select') || '*').split(',').map((s) => s.trim());
        if (!(sel.length === 1 && sel[0] === '*') && !sel.every((c) => IDENT.test(c))) return json(res, 400, { message: 'select' });
        const order = (sp.get('order') || '').split(',').filter(Boolean).map((o) => {
          const [c, dir = 'asc'] = o.split('.');
          if (!IDENT.test(c) || !['asc', 'desc'].includes(dir)) throw Object.assign(new Error(`order: ${o}`), { code: 'PGRST100' });
          return `${c} ${dir}`;
        });
        const cols = sel[0] === '*' ? '*' : sel.join(', ');
        const lim = /^\d+$/.test(sp.get('limit') || '') ? ` limit ${Number(sp.get('limit'))}` : '';
        const sql = `select coalesce(jsonb_agg(to_jsonb(x) - '__n' order by x.__n), '[]'::jsonb) as rows from (
                       select ${cols}, row_number() over (${order.length ? `order by ${order.join(', ')}` : ''}) as __n
                         from public.${name}${cond}${order.length ? ` order by ${order.join(', ')}` : ''}${lim}) x`;
        const rows = await asAnon(sql, params);
        return json(res, 200, rows[0].rows);
      }
      const body = await readBody(req);
      if (req.method === 'DELETE') {
        await asAnon(`delete from public.${name}${cond}`, params);
        return json(res, 204);
      }
      const obj = Array.isArray(body) ? body[0] || {} : body || {};
      const keys = Object.keys(obj);
      if (!keys.length || !keys.every((k) => IDENT.test(k))) return json(res, 400, { message: '본문' });
      params.push(JSON.stringify(obj));
      const p = `$${params.length}::jsonb`;
      if (req.method === 'PATCH') {
        await asAnon(`update public.${name} set ${keys.map((k) => `${k} = (select ${k} from jsonb_populate_record(null::public.${name}, ${p}))`).join(', ')}${cond}`, params);
        return json(res, 204);
      }
      if (req.method === 'POST') {
        await asAnon(`insert into public.${name} (${keys.join(', ')}) select ${keys.join(', ')} from jsonb_populate_record(null::public.${name}, ${p})`, params);
        return json(res, 201);
      }
      return json(res, 405, { message: req.method });
    } catch (e) { fail(res, e); }
  }

  /* ─── 관리 API: SQL 실행 ─── */
  async function query(res, body) {
    try {
      const results = await db.exec(String((body && body.query) || ''));
      const last = results.length ? results[results.length - 1] : { rows: [] };
      json(res, 201, last.rows || []);
    } catch (e) {
      json(res, 400, { message: String(e.message || e) });
    }
  }

  /* ─── 정적 파일 ─── */
  async function file(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/assets/config.js') {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end(`/* 로컬 흉내 서버가 준 접속 정보 */\nexport const CONFIG = { supabaseUrl: ${JSON.stringify(base)}, supabaseKey: ${JSON.stringify(MOCK_KEY)}, pollMs: 20000 };\n`);
      return;
    }
    const f = normalize(join(ROOT, rel));
    if (!(f.startsWith(resolve(ROOT) + sep) || f === resolve(ROOT)) || blocked(rel)) { res.writeHead(404).end('not found'); return; }
    const st = await stat(f).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const data = await readFile(f);
    res.writeHead(200, { 'Content-Type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  /* ─── 실시간 ─── */
  const sockets = new Set();
  let seq = 0;
  let bindSeq = 0;
  const sendWs = (ws, msg) => { try { ws.send(JSON.stringify(msg)); } catch { /* 닫힘 */ } };

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    const sock = { id: ++seq, ws, channels: new Map(), received: {} };
    sockets.add(sock);
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      const { topic, event, payload, ref } = m;
      const joinRef = m.join_ref;
      const reply = (st, response = {}) => sendWs(ws, { topic, event: 'phx_reply', payload: { status: st, response }, ref, join_ref: joinRef });
      if (topic === 'phoenix' && event === 'heartbeat') { reply('ok'); return; }
      if (event === 'phx_join') {
        const pcs = (payload && payload.config && Array.isArray(payload.config.postgres_changes)) ? payload.config.postgres_changes : [];
        const bindings = pcs.map((pc) => ({ id: ++bindSeq, event: pc.event, schema: pc.schema, table: pc.table, filter: pc.filter }));
        sock.channels.set(topic, { bindings });
        reply('ok', { postgres_changes: bindings });
        return;
      }
      if (event === 'phx_leave') { sock.channels.delete(topic); reply('ok'); return; }
      if (event === 'access_token') return;
      if (ref) reply('ok');
    });
    ws.on('close', () => sockets.delete(sock));
  });

  const matchFilter = (filter, row) => {
    if (!filter) return true;
    const m = /^(\w+)=eq\.(.*)$/.exec(filter);
    if (!m) return false;
    return row && row[m[1]] != null && String(row[m[1]]) === m[2];
  };
  const totals = {};
  await db.listen('mock_rt', (raw) => {
    let c;
    try { c = JSON.parse(raw); } catch { return; }
    const row = c.type === 'DELETE' ? c.old : c.new;
    for (const sock of sockets) {
      for (const [topic, ch] of sock.channels) {
        const ids = ch.bindings
          .filter((b) => b.schema === 'public' && b.table === c.table &&
            (b.event === '*' || String(b.event).toUpperCase() === c.type) && matchFilter(b.filter, row))
          .map((b) => b.id);
        if (!ids.length) continue;
        sendWs(sock.ws, {
          topic, event: 'postgres_changes', ref: null,
          payload: { ids, data: { schema: 'public', table: c.table, commit_timestamp: c.at, type: c.type, columns: [], record: c.new || {}, old_record: c.old || {}, errors: null } }
        });
        sock.received[c.table] = (sock.received[c.table] || 0) + 1;
        totals[c.table] = (totals[c.table] || 0) + 1;
      }
    }
  });

  /* ─── 요청 나누기 ─── */
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, base);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, prefer, accept-profile, content-profile'
        });
        res.end();
        return;
      }
      if (u.pathname === '/__mock/stats') {
        json(res, 200, {
          sockets: [...sockets].map((s) => ({
            id: s.id, received: s.received,
            tables: [...new Set([...s.channels.values()].flatMap((ch) => ch.bindings.map((b) => b.table)))].sort()
          })),
          totals
        });
        return;
      }
      let m;
      if ((m = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(u.pathname)) && req.method === 'POST') { await rpc(res, m[1], await readBody(req)); return; }
      if ((m = /^\/rest\/v1\/([^/]+)$/.exec(u.pathname))) { await table(req, res, m[1], u.searchParams); return; }
      if (/^\/v1\/projects\/[^/]+\/database\/query$/.test(u.pathname) && req.method === 'POST') { await query(res, await readBody(req)); return; }
      if (req.method === 'GET' || req.method === 'HEAD') { await file(req, res, u.pathname); return; }
      res.writeHead(405).end();
    } catch (e) {
      try { json(res, 500, { message: String(e.message || e) }); } catch { /* 이미 보냄 */ }
    }
  });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url, base);
    if (u.pathname !== '/realtime/v1/websocket') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise((r) => server.listen(port, host, r));

  return {
    url: base, port, db,
    async close() {
      for (const s of sockets) { try { s.ws.terminate(); } catch { /* 무시 */ } }
      await new Promise((r) => server.close(() => r()));
      await db.close();
    }
  };
}

// 명령으로 돌렸을 때
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.LWB_LOCAL_PORT || 4175);
  startMock({ port }).then((m) => {
    console.log(`로컬 흉내 Supabase: ${m.url}/ (DB: PGlite 메모리 · 반곡고 lw_ + 부산 lwb_)`);
  }, (e) => {
    console.error(e);
    process.exit(1);
  });
}
