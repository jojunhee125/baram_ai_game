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
];
