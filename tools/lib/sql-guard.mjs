/**
 * 마이그레이션 SQL 검사: 부산 판(lwb_)이 반곡고 판(lw_)이나 Supabase 기본 객체를 건드리지 않는가.
 * 같은 Supabase 프로젝트를 쓰므로, 부산 마이그레이션에는 lwb_ 아닌 객체를
 * 만들거나(create) 바꾸거나(alter) 지우거나(drop) 권한을 주거나 걷는(grant·revoke) 문장, 설명(comment on)이 없어야 한다.
 *
 * 예외(부산 객체만 더하는 것):
 *   - alter publication supabase_realtime add table public.lwb_…
 *   - cron.schedule('lwb_…', …)
 * 그 밖의 규칙:
 *   - 동적 SQL(execute …)은 이름을 검사할 수 없으므로 쓰지 않는다
 *   - 반곡고 이름(lw_…)은 어디에도(함수 본문 포함) 쓰지 않는다
 *   - 제약 이름(constraint …)도 lwb_
 * tests/unit/migrations.test.mjs 가 supabase/migrations/*.sql 모두에 돌린다.
 */

export const PREFIX = 'lwb_';

/** 주석(-- …, /* … *\/)을 지운다. 작은따옴표 문자열 안은 그대로 둔다 */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const j = endOfString(s, i);
      out += s.slice(i, j);
      i = j;
    } else if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      i = j < 0 ? s.length : j + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function endOfString(s, i) {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "'") {
      if (s[j + 1] === "'") { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return s.length;
}

/** 작은따옴표 문자열의 내용을 같은 길이의 공백으로 비운다(자리는 그대로) */
function blankStrings(s) {
  return s.replace(/'(?:[^']|'')*'/g, (m) => `'${' '.repeat(m.length - 2)}'`);
}

/** 이름 하나(스키마.이름, 따옴표, 인자 목록 포함)에서 마지막 이름만 */
export function baseName(token) {
  const t = String(token).trim().replace(/\(.*$/s, '').trim();
  const last = t.split('.').pop() || '';
  return last.replace(/^"|"$/g, '').toLowerCase();
}

/** 괄호 밖의 쉼표로 나눈다 */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NAME = String.raw`((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))*)`;
const KINDS = String.raw`(?:table|function|procedure|index|policy|view|materialized\s+view|sequence|trigger|type|schema|extension|publication|role|domain|rule|aggregate|operator|event\s+trigger|cast|collation|conversion|language|server|foreign\s+table|statistics|subscription|text\s+search\s+\w+|default\s+privileges)`;

/**
 * 검사. 어긴 것마다 { rule, name?, text } 를 돌려준다(없으면 빈 배열).
 * @param {string} sql 마이그레이션 파일 하나의 내용
 */
export function checkMigrationSql(sql) {
  const bad = [];
  const add = (rule, text, name) => bad.push({ rule, name, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 160) });
  const noComments = stripComments(sql);
  const s = blankStrings(noComments);

  // 1) 예약 작업: cron.schedule('lwb_…', …) 만 허용(문자열 밖의 호출만 본다. 첫 인자는 원래 글에서 읽는다)
  for (const m of s.matchAll(/\bcron\s*\.\s*(\w+)\s*\(/gi)) {
    const fn = m[1].toLowerCase();
    const after = noComments.slice(m.index + m[0].length);
    const lit = /^\s*'((?:[^']|'')*)'/.exec(after);
    if (fn !== 'schedule') add('cron 은 schedule 로 lwb_ 작업을 더하기만 한다', m[0] + after.slice(0, 40));
    else if (!lit || !lit[1].startsWith(PREFIX)) add('cron 작업 이름은 lwb_ 로 시작해야 한다', m[0] + after.slice(0, 40), lit ? lit[1] : '');
  }

  // 2) 동적 SQL 금지(grant execute on … 는 권한 이름이라 괜찮다)
  for (const m of s.matchAll(/\bexecute\b(?!\s+on\b)/gi)) add('동적 SQL(execute)은 쓰지 않는다', s.slice(m.index, m.index + 60));

  // 3) 반곡고 이름(lw_…)은 어디에도 쓰지 않는다
  for (const m of s.matchAll(/\blw_\w*/gi)) add('반곡고 이름(lw_)을 쓰지 않는다', s.slice(Math.max(0, m.index - 30), m.index + 40), m[0]);

  // 4) 제약 이름
  for (const m of s.matchAll(new RegExp(String.raw`\bconstraint\s+${NAME}`, 'gi'))) {
    if (!baseName(m[1]).startsWith(PREFIX)) add('제약 이름은 lwb_ 로 시작해야 한다', m[0], baseName(m[1]));
  }

  // 5) create · alter · drop · grant · revoke · comment on
  const check = (name, rule, text) => {
    const n = baseName(name);
    if (!n.startsWith(PREFIX)) add(rule, text, n);
  };
  for (const m of s.matchAll(/\b(create|alter|drop|grant|revoke|comment\s+on)\b/gi)) {
    const end = s.indexOf(';', m.index);
    const stmt = s.slice(m.index, end < 0 ? s.length : end);
    const verb = m[1].toLowerCase().replace(/\s+/g, ' ');

    if (verb === 'create' || verb === 'alter' || verb === 'drop' || verb === 'comment on') {
      const head = new RegExp(String.raw`^${verb === 'comment on' ? 'comment\\s+on' : verb}\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:temp(?:orary)?\s+)?(?:concurrently\s+)?(${KINDS}|column)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?(?:concurrently\s+)?`, 'i');
      const h = head.exec(stmt);
      if (!h) { add(`${verb} 문장을 읽을 수 없다(검사할 수 없는 문장은 쓰지 않는다)`, stmt); continue; }
      const kind = h[1].toLowerCase().replace(/\s+/g, ' ');
      const rest = stmt.slice(h[0].length);
      if (kind === 'default privileges') { add('기본 권한(alter default privileges)은 바꾸지 않는다', stmt); continue; }

      // alter publication: supabase_realtime 에 lwb_ 표를 더하는 것만
      if (kind === 'publication') {
        const p = /^supabase_realtime\s+add\s+table\s+(?:only\s+)?(.+)$/is.exec(rest.trim());
        if (verb !== 'alter' || !p) { add('발행은 supabase_realtime 에 lwb_ 표를 더하기만 한다', stmt); continue; }
        for (const t of splitTop(p[1])) check(t, '발행에는 lwb_ 표만 더한다', stmt);
        continue;
      }
      if (verb === 'drop') {
        const names = rest.replace(/\s+(cascade|restrict)\s*$/i, '');
        const on = /^(.+?)\s+on\s+(.+)$/is.exec(names);
        if (on && (kind === 'policy' || kind === 'trigger' || kind === 'rule')) {
          check(on[1], `drop ${kind}: lwb_ 만`, stmt);
          check(on[2], `drop ${kind}: lwb_ 표만`, stmt);
        } else {
          for (const t of splitTop(names)) check(t, `drop ${kind}: lwb_ 만 지운다`, stmt);
        }
        continue;
      }
      const nm = new RegExp(`^${NAME}`).exec(rest.trim());
      if (!nm) { add(`${verb} ${kind}: 이름을 읽을 수 없다`, stmt); continue; }
      if (kind === 'column') { // comment on column 표.칸 → 표 이름
        const parts = nm[1].split('.');
        check(parts.length > 1 ? parts[parts.length - 2] : nm[1], 'comment on column: lwb_ 표만', stmt);
        continue;
      }
      check(nm[1], `${verb} ${kind}: 이름은 lwb_ 로 시작해야 한다`, stmt);
      if (kind === 'index' || kind === 'policy' || kind === 'trigger' || kind === 'rule') {
        const on = new RegExp(String.raw`\bon\s+(?:only\s+)?${NAME}`, 'i').exec(rest);
        if (!on) add(`${verb} ${kind}: 대상 표를 읽을 수 없다`, stmt);
        else check(on[1], `${verb} ${kind}: 대상 표는 lwb_ 여야 한다`, stmt);
      }
      continue;
    }

    // grant · revoke: on <종류> <이름들> to|from <역할들>
    const g = new RegExp(String.raw`^(?:grant|revoke)\s+(?:grant\s+option\s+for\s+)?(.+?)\s+on\s+(?:(all\s+(?:tables|functions|sequences|routines)\s+in\s+schema|table|function|procedure|routine|sequence|schema|database|domain|type|language|large\s+object|foreign\s+data\s+wrapper|foreign\s+server|tablespace)\s+)?(.+?)\s+(?:to|from)\s+(.+)$`, 'is').exec(stmt.trim());
    if (!g) { add(`${verb}: 객체 권한만 다룬다(역할 권한 주기·걷기 금지)`, stmt); continue; }
    const kind = (g[2] || 'table').toLowerCase().replace(/\s+/g, ' ');
    if (/^all /.test(kind) || kind === 'schema' || kind === 'database') { add(`${verb}: 스키마·데이터베이스 단위 권한은 다루지 않는다`, stmt); continue; }
    for (const t of splitTop(g[3])) check(t, `${verb} ${kind}: lwb_ 객체만`, stmt);
  }
  return bad;
}
