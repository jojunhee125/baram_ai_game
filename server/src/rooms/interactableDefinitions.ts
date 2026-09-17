import { InteractableKind } from "@zep-test/shared";
import type { InteractableDefinition } from "./contracts";

/**
 * The fixed objects an author has placed. Content lives here rather than in the map file or in a
 * runtime admin API; both alternatives and the reasons they lose are in
 * `docs/design-fixed-objects.md` §2 and §4.
 *
 * Coordinates are authored here rather than read from the map, so they are also recorded in
 * `assets/README.md` beside each map's portal tiles. Boot refuses to start on an unwalkable tile,
 * a tile shared with another object or with a portal trigger (`validateRoomMaps`), but nothing can
 * check that an object sits where the map art draws a signboard — that stays an eyeball check.
 *
 * Tiles deliberately avoid plaza's spawn row and the route to its south door:
 * `metaverseRoom.integration.test.ts` walks the whole of row 20 between x=16 and x=47, the column
 * at x=16, and the column at x=31 down to the door, and an object on any of those would open a
 * panel in the middle of an unrelated test. They also sit in dead ends rather than on through
 * routes, because entering one gates the client's movement until the panel is closed.
 *
 * grand-plaza deliberately has no rows: it is the 500-CCU load-test map, and a bot from
 * `tools/loadtest-poc2.mjs` wandering onto an object would put messages into the PoC #2
 * measurement that production traffic at that scale would not have.
 *
 * Every content string below is a placeholder pending real content from the user; the tiles and
 * ids are the parts meant to survive that swap.
 */
export const INTERACTABLE_DEFINITIONS: readonly InteractableDefinition[] = [
  {
    id: "plaza-link-board",
    kind: InteractableKind.Link,
    // South-west nook: boxed in by the crates at (18,23) and the shrub at (17,24).
    at: { room: "plaza", tiles: [{ tileX: 17, tileY: 23 }] },
    title: "안내 링크 (자리표시)",
    url: "https://example.com/zep-test-placeholder",
  },
  {
    id: "plaza-notice-board",
    kind: InteractableKind.Notice,
    // Two tiles wide, against the shrub row at y=22: one board, not two rows to keep in step.
    at: {
      room: "plaza",
      tiles: [
        { tileX: 44, tileY: 23 },
        { tileX: 45, tileY: 23 },
      ],
    },
    title: "공지사항 (자리표시)",
    body: "여기에 공지 내용이 들어갑니다.\n\n줄바꿈은 그대로 유지되며, 관리자가 코드 테이블에서 작성합니다.",
  },
  {
    id: "plaza-quiz-stand",
    kind: InteractableKind.Quiz,
    // North-east corner, a dead end against two walls.
    at: { room: "plaza", tiles: [{ tileX: 47, tileY: 8 }] },
    title: "퀴즈 (자리표시)",
    // Choice text deliberately does not spell out which one is correct — the point of grading
    // server-side is defeated if the label does the grading for us.
    question: "이 서비스의 실시간 서버는 어떤 프레임워크로 만들어졌을까요?",
    choices: ["Colyseus", "Socket.IO", "Firebase"],
    answerIndex: 0,
    explanation: "이 서비스의 실시간 서버는 Colyseus로 구현되어 있습니다.",
  },
  {
    id: "plaza-hunting-ground-npc",
    kind: InteractableKind.Npc,
    // One tile west of the north door's west trigger tile (31,8) — right beside the gate. Row 8
    // has no shrub decorations (unlike rows 9/11), so this is open ground, not a boxed dead end;
    // deliberate, since a guide NPC should be seen, not tucked away — see "좌표 확정 근거" above.
    at: { room: "plaza", tiles: [{ tileX: 30, tileY: 8 }] },
    title: "사냥터 안내",
    body: "여기는 사냥터입니다. 몬스터가 서식하니 전투를 준비하세요.\n\n공격은 스페이스바, 가방은 I 키로 엽니다.",
    avatarSkin: 21, // 백발 / 파랑 고글 / 주황 코트 (assets/README.md 스킨표) — 안내인 인상, 교체 쉬움
    // On the north-door through-route, not a dead end (Phase T's own placement reasoning) — the
    // BFS'd walk pattern client/e2e uses (pass-g/h/j specs) crosses this tile on every west-side
    // detour around the fountain. Blocking movement here froze real travel, not just tests; this
    // NPC is read-and-close only (no quiz-style follow-up state), so nothing is lost by letting a
    // step carry straight through. docs/design-npc-movement-block-fix.md.
    blocksMovement: false,
  },
  {
    id: "plaza-shop-npc",
    kind: InteractableKind.Npc,
    // South-east corner of the interior (x=47 is the last interior column, y=25 the last interior
    // row) — bounded by the border band on both S and E, the same "corner against two walls" dead
    // end plaza-quiz-stand already uses, just the opposite corner. Clear of the south door
    // (trigger (31,25)/(32,25), 16 tiles west) and of every avoided band in this file's header
    // comment (spawn row 20, column 16, the column-31 route to the south door).
    at: { room: "plaza", tiles: [{ tileX: 47, tileY: 25 }] },
    title: "상점 (자리표시)",
    body:
      "회복 소모품과 기본 장비를 준비 중입니다.\n\n" +
      "구매는 아직 열리지 않았습니다 — 정산 기능이 갖춰지면 이곳에서 살 수 있습니다.",
    avatarSkin: 16, // 갈색 머리 / 빨강 상의 (assets/README.md 스킨표) — 안내 NPC(21)와 겹치지 않는 인상
  },
  {
    id: "hunting-ground-return-npc",
    kind: InteractableKind.Npc,
    // Npc, not Notice, to match plaza-hunting-ground-npc's "a guide should be seen" choice rather
    // than the static-board convention (link/notice/quiz) — a standing figure reads as a welcome
    // right where a player's own south-door arrival (35,30) lands them, which a board blends into
    // the scenery against. One tile east of the door/trail column (x35-36) so it never sits on the
    // BFS'd path pass-f-qol.spec.ts and pass-g-tester-verification.spec.ts walk straight up/down
    // that column; also clear of the room's own join-spawn spread (x33-37, y25-29,
    // server/src/rooms/definitions.ts) and every monster's spawn-plus-wander box
    // (monsterDefinitions.ts: nearest is hg-squirrel-04 at (41,24) wander 2, y22-26 only).
    // Non-blocking, unlike every plaza object and despite sitting off the trail: this is the first
    // object placed in a room that has monsters in it, and freezing movement there means a player
    // a squirrel is already chasing gets held still while it hits them. Same rule the bag and the
    // drop table follow in this room (`WorldScene.update`, docs/design-hunting-inventory.md §3.4)
    // — a fight in progress must not stop because a panel is up. Read-and-close only, so nothing
    // is lost by letting a step carry straight through (docs/design-npc-movement-block-fix.md).
    blocksMovement: false,
    at: { room: "hunting-ground", tiles: [{ tileX: 39, tileY: 29 }] },
    title: "마을로 돌아가는 길",
    body: "남쪽 문을 나가면 마을 광장입니다.\n\n다치셨다면 광장으로 돌아가 회복하세요.",
    avatarSkin: 22, // 어두운 피부 / 갈색 머리 / 파랑 셔츠 (assets/README.md 스킨표) — 안내 NPC(21)·상점 NPC(16)와 겹치지 않는 인상
  },
];
