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
    title: "남문 길 안내",
    body: "남쪽: 초보 들판\n북쪽: 대광장\n\n성문 앞 길잡이에게 임무를 받고 동쪽 상점에서 준비하세요. T 키로 지역 이동 목록을 확인할 수 있습니다.",
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
    // Guide beside the south gate, outside the main street.
    at: { room: "plaza", tiles: [{ tileX: 29, tileY: 22 }] },
    title: "남문 길잡이",
    body: "남쪽 성문을 지나면 초보 들판입니다. 들판에서 입장권을 얻으면 북쪽 바위 사냥굴로 들어갈 수 있습니다.\n\n동쪽 상점에서 약초와 장비를 준비하세요. 공격은 Space, 가방은 I입니다.",
    avatarSkin: 21, // 백발 / 파랑 고글 / 주황 코트 (assets/README.md 스킨표) — 안내인 인상, 교체 쉬움
    blocksMovement: false,
  },
  {
    id: "plaza-shop-npc",
    kind: InteractableKind.Npc,
    // East-side shop remains non-blocking on the home street.
    blocksMovement: false,
    at: { room: "plaza", tiles: [{ tileX: 35, tileY: 20 }] },
    title: "남문 상점",
    body: "약초와 사냥 장비를 팝니다. 첫 임무 보상으로 낡은 단검을 마련하고 더 강한 검과 갑옷을 준비하세요.\n\n전리품은 가방의 판매 버튼으로 바꿀 수 있습니다.",
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
    body: "남쪽 문을 나가면 남문 마을입니다.\n\n길잡이에게 임무를 보고하고 상점에서 장비를 준비하세요.",
    avatarSkin: 22, // 어두운 피부 / 갈색 머리 / 파랑 셔츠 (assets/README.md 스킨표) — 안내 NPC(21)·상점 NPC(16)와 겹치지 않는 인상
  },
];
