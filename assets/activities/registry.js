/**
 * 활동 부품 등록부 (클라이언트 쪽 종류 목록)
 *
 * 새 종류를 더할 때는 서버 검사(lwb_validate_<종류>, lwb_validate_payload)와
 * tools/lib/event-config.mjs 의 ACTIVITY_TYPES 에도 같은 이름을 더한다(supabase/README.md).
 *
 * 부품 하나가 내보내는 것 (default export):
 *   type            종류 이름 ('ox' 등). 설정의 activity.type 과 같다
 *   typeLabel       관리자 화면에 붙는 짧은 종류 이름
 *   summary(a)      메뉴·관리자 카드에 쓰는 한 줄(예: '3문항')
 *   participant(ctx) → { update(ctx), destroy() }
 *                   참가자 화면. ctx.root 안에 그린다. 데이터가 바뀌면 update(ctx)가 불린다.
 *                   ctx: { root, event, activity, index, isOpen, reveal, me, mine, mineOf(id), rows, names,
 *                          liveBadge, submit(payload)→Promise<boolean>, draft{load,save,clear},
 *                          need(kinds), toast(msg), goMenu() }
 *                   need(['responses'…]) 로 다른 사람 결과가 필요하다고 알리면, 참가자 기기는 이 활동의 응답만
 *                   제출 직후 한 번, 그 뒤 15~25초마다 다시 불러온다(실시간 구독은 진행 설정만).
 *                   mineOf(id): 이 참가자가 다른 활동에 낸 payload(없으면 null)
 *   adminCard(ctx)  관리자 활동 카드에 붙는 한 줄 HTML(없으면 '')
 *   adminResponse(ctx, row)  '지금 들어온 응답'에 보일 원문 HTML
 *   adminCell(ctx, row)      참가자 표 칸(제출했을 때). 기본 '✓'
 *                   관리자 ctx: { event, activity, index, isOpen, reveal, rows, rowsOf(id), names }
 *   board(ctx) → { update(ctx), destroy(), onKey?(key, event) → boolean }
 *                   현황판 화면(board.html). ctx.root 안에 그린다. 데이터가 바뀌면 update(ctx)가 불린다.
 *                   onKey 는 현황판 틀보다 먼저 키를 받는다(쪽 넘기기·보기 바꾸기 등). 쓰면 true 를 돌려주고,
 *                   false 면 틀이 처리한다(← → PageUp PageDown 화면 넘기기, F 전체화면).
 *                   한글 입력 상태에서도 되게 글자 키는 event.code('KeyN' 등)로도 본다.
 *                   ctx: { root, event, activity, index, isOpen, reveal, rows, rowsOf(id), names, participants, keep }
 *                     rows    이 활동의 응답(최근 제출 순). 불러오는 중이면 null
 *                     rowsOf  다른 활동의 응답(짝 활동 나란히 보기 등)
 *                     keep    화면을 넘겼다 돌아와도 남는 부품별 기억(보고 있던 보기 등)
 *   boardKeys       현황판 아래 막대에 보일 이 화면의 키 안내(선택, 예: '↑ ↓ 쪽')
 *                   정답·점수는 reveal 이 있을 때(공개된 뒤)만 그린다.
 */
import ox from './ox.js';
import stageCheck from './stage_check.js';
import sentence from './sentence.js';
import rewrite from './rewrite.js';

export const ACTIVITY_MODULES = {
  ox,
  stage_check: stageCheck,
  sentence,
  rewrite
};

/** 종류 이름 → 부품 (모르는 종류면 null) */
export function moduleFor(type) {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_MODULES, type) ? ACTIVITY_MODULES[type] : null;
}
