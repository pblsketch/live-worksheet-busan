/**
 * 현황판 카드 공용 도구: 쪽 나누기(넘김), 새 카드 강조
 *
 * 카드 100장이 와도 모두 볼 수 있게, 화면에 들어가는 만큼 한 쪽에 두고 PageDown·PageUp(↓·↑)으로 넘긴다.
 * 카드는 처음 낸 순서로 끝에 붙으므로 앞쪽은 새 카드가 들어와도 바뀌지 않는다(보고 있는 쪽이 튀지 않는다).
 * 순수 함수(paginate · pageOf · freshKeys)는 tests/unit 에서 검사한다.
 */

/** 새 카드를 노란 테두리로 보이는 시간(밀리초) */
export const FRESH_MS = 12000;

/**
 * 새로 들어온 카드 고르기. seen(Map: key → 처음 본 시각)을 고친다.
 * 처음 그릴 때(first) 이미 있던 카드는 새것으로 치지 않는다. 처음 본 뒤 ttl 동안 새것이다.
 * @returns {Set<string>} 지금 강조할 key
 */
export function freshKeys(seen, keys, now, { first = false, ttl = FRESH_MS } = {}) {
  for (const k of keys) if (!seen.has(k)) seen.set(k, first ? 0 : now);
  const out = new Set();
  for (const k of keys) {
    const t = seen.get(k);
    if (t > 0 && now - t < ttl) out.add(k);
  }
  return out;
}

/**
 * 쪽 나누기. 카드를 순서대로 지금 쪽의 가장 짧은 칸(같으면 왼쪽)에 넣고,
 * 그 칸에도 들어가지 않으면 새 쪽을 연다. 빈 칸에는 높이와 상관없이 넣는다(너무 긴 카드는 혼자 한 칸).
 * 앞의 카드만으로 쪽이 정해지므로, 뒤에 카드가 붙어도 앞쪽은 그대로다.
 * @param {number[]} heights 카드 높이(순서대로)
 * @param {{ cols?: number, height: number, gap?: number }} box 칸 수, 칸 높이, 카드 사이 간격
 * @returns {number[][][]} 쪽마다 칸마다 카드 번호. 카드가 없으면 []
 */
export function paginate(heights, { cols = 1, height, gap = 0 }) {
  const n = Math.max(1, cols | 0);
  const pages = [];
  let page = null;
  let fill = null;
  const open = () => {
    page = Array.from({ length: n }, () => []);
    fill = new Array(n).fill(0);
    pages.push(page);
  };
  heights.forEach((h, i) => {
    if (!page) open();
    let c = 0;
    for (let k = 1; k < n; k++) if (fill[k] < fill[c]) c = k;
    const add = (page[c].length ? gap : 0) + h;
    if (page[c].length && fill[c] + add > height) {
      open();
      c = 0;
    }
    fill[c] += (page[c].length ? gap : 0) + h;
    page[c].push(i);
  });
  return pages;
}

/** 카드 번호가 들어 있는 쪽(없으면 -1) */
export function pageOf(pages, index) {
  return pages.findIndex((p) => p.some((col) => col.includes(index)));
}

/** 쪽 번호를 0 ~ (쪽 수 - 1) 안으로 */
export function clampPage(page, count) {
  return Math.min(Math.max(0, page | 0), Math.max(0, count - 1));
}

/**
 * 카드 높이 재기(화면). host 안에 폭 width(px)의 보이지 않는 칸을 잠깐 만들어 카드 HTML 을 넣고 잰다.
 * @param {HTMLElement} host   재는 동안 칸을 붙일 곳(카드와 같은 글꼴 크기가 적용되는 곳)
 * @param {string[]} htmls     카드 HTML(카드 하나가 맨 위 요소 하나)
 * @param {number} width       칸 폭(px)
 * @param {string} className   재는 칸의 클래스(실제 칸과 같은 클래스 + 재기용)
 */
export function measureHeights(host, htmls, width, className) {
  const box = document.createElement('div');
  box.className = className;
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;height:auto;width:${width}px`;
  box.innerHTML = htmls.join('');
  host.appendChild(box);
  const hs = [...box.children].map((el) => el.getBoundingClientRect().height);
  box.remove();
  return hs;
}

/**
 * 칸들의 크기 재기: 폭·높이(px)와 카드 사이 간격(칸의 row-gap)
 * @param {HTMLElement} col 실제 칸 하나(비어 있어야 한다)
 */
export function columnBox(col) {
  const st = getComputedStyle(col);
  const gap = parseFloat(st.rowGap) || 0;
  return { width: col.clientWidth, height: col.clientHeight, gap };
}

/** 쪽 표시 HTML: ‹ 2 / 5쪽 · 87장 › (쪽이 하나면 넘김 단추를 뺀다) */
export function pagerHTML(page, count, total, unit = '장') {
  const many = count > 1;
  return `<span class="pg${many ? '' : ' one'}" data-page="${page + 1}" data-pages="${count}">` +
    (many ? `<button type="button" class="pgb" data-turn="-1" aria-label="앞 쪽"${page > 0 ? '' : ' disabled'}>‹</button>` : '') +
    `<span class="pgt">${many ? `<b>${page + 1}</b> / ${count}쪽 · ` : ''}${total}${unit}</span>` +
    (many ? `<button type="button" class="pgb" data-turn="1" aria-label="다음 쪽"${page < count - 1 ? '' : ' disabled'}>›</button>` : '') +
    '</span>';
}
