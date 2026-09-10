import { expect, test } from "@playwright/test";
import {
  launchSharedBrowser,
  openConcurrentClients,
  openFreshClient,
  type Client,
} from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { captureWebSocketFrames } from "../helpers/network";
import { holdKey, tapKey } from "../helpers/input";
import { completeAvatarPicker, joinRoom } from "../helpers/flows";

/**
 * Independent tester coverage for docs/design-phase-h-skin-skip-menu.md (items a-j) and
 * docs/design-phase-j-grand-plaza-cleanup.md (items 1-6), verified together because Phase H's
 * ui-engineer pass landed on top of files Phase J's pass had just changed (`WorldScene.ts`,
 * `avatarPicker.ts`).
 */

let browser: Awaited<ReturnType<typeof launchSharedBrowser>>;
let client: Client;

test.beforeAll(async () => {
  browser = await launchSharedBrowser();
});

test.afterAll(async () => {
  await browser.close();
});

test.beforeEach(async () => {
  client = await openFreshClient(browser);
});

test.afterEach(async () => {
  await client.close();
});

test.describe("Phase H (a)(b) — 부팅 시 피커 생략", () => {
  test("저장된 스킨이 있으면(ok:true,skin:3) 피커 없이 바로 입장하고, 캐릭터 메뉴에 그 스킨이 선택돼 있다", async () => {
    await client.page.route("**/api/profile", (route) => {
      if (route.request().method() !== "GET") {
        return route.continue();
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ avatarSkin: 3 }),
      });
    });

    await client.page.goto("/?room=plaza");
    // If the boot flow regressed to always showing the picker, this hangs until its own 30s
    // timeout instead of ever reaching "ready" — a clear, unambiguous failure for this bug.
    await waitForCanvasReady(client.page);
    await expect(client.page.locator("#avatar-picker")).toBeHidden();

    // Confirms the join actually used skin 3 (not just that the picker was skipped): reopening
    // the picker from the character menu pre-selects whatever the server has on file for us.
    await tapKey(client.page, "KeyC");
    await client.page.locator("#character-menu-change-skin").click();
    await expect(client.page.locator("#avatar-picker")).toBeVisible();
    await expect(client.page.getByRole("radio", { name: "4번 캐릭터", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await client.page.keyboard.press("Escape");
    await expect(client.page.locator("#avatar-picker")).toBeHidden();
  });

  test("계정은 있지만 고른 적 없으면(ok:true,skin:null) 오늘과 동일하게 피커가 뜬다", async () => {
    await client.page.route("**/api/profile", (route) => {
      if (route.request().method() !== "GET") {
        return route.continue();
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await client.page.goto("/?room=plaza");
    await expect(client.page.locator("#avatar-picker")).toBeVisible();
    await completeAvatarPicker(client.page, 0);
    await waitForCanvasReady(client.page);
  });

  test("프로필 조회 자체가 실패해도(ok:false) 피커가 뜨고, 실패 부팅에서는 저장도 되지 않는다 (Phase C 불변식)", async () => {
    let postCount = 0;
    await client.page.route("**/api/profile", (route) => {
      if (route.request().method() !== "GET") {
        postCount += 1;
        return route.fulfill({ status: 200 });
      }
      return route.fulfill({ status: 500 });
    });

    await client.page.goto("/?room=plaza");
    await expect(client.page.locator("#avatar-picker")).toBeVisible();
    await completeAvatarPicker(client.page, 2);
    await waitForCanvasReady(client.page);
    expect(postCount).toBe(0);
  });
});

test.describe("Phase H (c)(d) — 실시간 재스킨 (critical: silent no-op risk)", () => {
  test("재스킨 시 자기 화면과 상대 화면 둘 다 즉시 리페인트된다", async () => {
    const [alice, bob] = await openConcurrentClients(2);
    if (!alice || !bob) {
      await Promise.all([alice?.close(), bob?.close()]);
      throw new Error("Expected two browser clients for the live reskin test");
    }
    try {
      await joinRoom(alice.page, "plaza", { skinIndex: 0 });
      await joinRoom(bob.page, "plaza", { skinIndex: 0 });
      // Let both settle into view of each other and stop any join-cascade repainting.
      await alice.page.waitForTimeout(400);

      // 로컬 카메라 중앙 80×80. 좌표를 하드코딩하지 않고 실제 캔버스 사각형에서 계산한다 —
      // 2026-09-11 클래식 UI 병합으로 캔버스가 뷰포트 전체가 아니라 좌상단(우측 사이드바 제외)
      // 영역이 되면서, 예전 고정 좌표(472,248)는 플레이어가 아니라 배경 타일을 찍고 있었다.
      const canvasRect = (await alice.page.locator(".stage__canvas").boundingBox())!;
      const clip = {
        x: Math.round(canvasRect.x + canvasRect.width / 2 - 40),
        y: Math.round(canvasRect.y + canvasRect.height / 2 - 40),
        width: 80,
        height: 80,
      };
      const aliceBefore = await alice.page.screenshot({ clip });
      const bobBefore = await bob.page.screenshot({ clip });

      await tapKey(alice.page, "KeyC");
      await alice.page.locator("#character-menu-change-skin").click();
      await expect(alice.page.locator("#avatar-picker")).toBeVisible();
      await alice.page.getByRole("radio", { name: "6번 캐릭터", exact: true }).click();
      await alice.page.locator("#avatar-picker-start").click();
      await expect(alice.page.locator("#avatar-picker")).toBeHidden();

      // Round trip: WS send -> server mutate -> patch broadcast -> decode on both clients.
      // PATCH_RATE_MS is 100ms; well clear of it.
      await alice.page.waitForTimeout(600);

      const aliceAfter = await alice.page.screenshot({ clip });
      const bobAfter = await bob.page.screenshot({ clip });

      expect(
        aliceAfter.equals(aliceBefore),
        "(c) local player's own screen must repaint after changing its own skin",
      ).toBe(false);
      expect(
        bobAfter.equals(bobBefore),
        "(d) the OTHER client's view of the reskinned player must also repaint " +
          "(PlayerSprites.update() must diff+apply avatarSkin for remote players)",
      ).toBe(false);
    } finally {
      await alice.close();
      await bob.close();
    }
  });
});

test.describe("Phase H (e)(f)(g) — 재호출된 피커는 모달: 이동/홈을 막고, Escape로 취소된다", () => {
  async function openCharacterMenuPicker(page: Parameters<typeof tapKey>[0]): Promise<void> {
    await tapKey(page, "KeyC");
    await page.locator("#character-menu-change-skin").click();
    await expect(page.locator("#avatar-picker")).toBeVisible();
  }

  test("(e) 피커가 열려 있는 동안 방향키를 눌러도 move 메시지가 전송되지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    await openCharacterMenuPicker(client.page);

    const capture = captureWebSocketFrames(client.page);
    await holdKey(client.page, "ArrowRight", 300);
    await client.page.waitForTimeout(100);
    const sentWhileOpen = capture.frames.filter((f) => f.direction === "sent").length;
    capture.stop();

    expect(sentWhileOpen, "no client->server frame should be sent while the picker blocks input").toBe(0);
    await client.page.keyboard.press("Escape");
    await expect(client.page.locator("#avatar-picker")).toBeHidden();
  });

  test("(f) 피커가 열려 있는 동안 H를 눌러도 홈 워프가 시작되지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    await openCharacterMenuPicker(client.page);

    await client.page.keyboard.press("KeyH");
    await client.page.waitForTimeout(200);
    // Still the same picker, still up, and no wipe was ever raised.
    await expect(client.page.locator("#avatar-picker")).toBeVisible();
    await expect(client.page.locator("#transition")).toHaveAttribute("data-state", "clear");

    await client.page.keyboard.press("Escape");
    await expect(client.page.locator("#avatar-picker")).toBeHidden();
  });

  test("(g) Escape로 취소하면 스킨이 바뀌지 않는다(재전송 없음, 화면 무변화)", async () => {
    await joinRoom(client.page, "plaza", { skinIndex: 0 });
    await client.page.waitForTimeout(300);
    const clip = { x: 472, y: 248, width: 80, height: 80 };
    const before = await client.page.screenshot({ clip });

    const capture = captureWebSocketFrames(client.page);
    await openCharacterMenuPicker(client.page);
    await client.page.getByRole("radio", { name: "8번 캐릭터", exact: true }).click();
    await client.page.keyboard.press("Escape");
    await expect(client.page.locator("#avatar-picker")).toBeHidden();
    await client.page.waitForTimeout(300);
    const sent = capture.frames.filter((f) => f.direction === "sent").length;
    capture.stop();

    expect(sent, "cancelling must send nothing to the room").toBe(0);
    const after = await client.page.screenshot({ clip });
    expect(after.equals(before), "cancelling must leave the on-screen skin unchanged").toBe(true);
  });
});

test.describe("Phase H (j) — 키 바인딩 충돌", () => {
  test("채팅 입력 중 C를 입력해도 캐릭터 메뉴가 열리지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    const chatInput = client.page.locator("#chat-input");
    await chatInput.click();
    await expect(chatInput).toBeFocused();

    await client.page.keyboard.press("KeyC");
    await expect(client.page.locator("#character-menu")).toBeHidden();
    await expect(chatInput).toBeFocused();
  });

  test("Ctrl+C는 캐릭터 메뉴를 열지 않는다", async () => {
    await joinRoom(client.page, "plaza");
    await client.page.keyboard.down("Control");
    await client.page.keyboard.press("KeyC");
    await client.page.keyboard.up("Control");
    await expect(client.page.locator("#character-menu")).toBeHidden();
  });
});

test.describe("Phase H (h) — 재스킨한 스킨이 room hop 이후에도 유지된다 (identity.ts 갱신 확인)", () => {
  test("스킨 변경 후 실제 portal hop을 해도 새 room에서 그 스킨이 그대로다(부팅 시점 스킨으로 되돌아가지 않음)", async () => {
    await joinRoom(client.page, "plaza", { skinIndex: 0 });

    await tapKey(client.page, "KeyC");
    await client.page.locator("#character-menu-change-skin").click();
    await expect(client.page.locator("#avatar-picker")).toBeVisible();
    await client.page.getByRole("radio", { name: "10번 캐릭터", exact: true }).click();
    await client.page.locator("#avatar-picker-start").click();
    await expect(client.page.locator("#avatar-picker")).toBeHidden();
    await client.page.waitForTimeout(400); // let the ChangeSkin round trip land before we move

    // plaza(31,20) -> hunting-ground north door, the proven walk pattern from
    // pass-g-tester-verification.spec.ts's round-trip test.
    await holdKey(client.page, "ArrowUp", 160);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowLeft", 280);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowUp", 1350);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowRight", 280);
    await client.page.waitForTimeout(1500); // fade-out + reconnect + fade-in (hop())

    // If identity.ts's frozen join identity had reverted to the boot-time skin (index 0) instead
    // of the character-menu's choice (index 9), the rejoin here would carry skin 0 — reopening
    // the picker in the new room would show "1번 캐릭터" checked instead of "10번 캐릭터".
    await tapKey(client.page, "KeyC");
    await client.page.locator("#character-menu-change-skin").click();
    await expect(client.page.locator("#avatar-picker")).toBeVisible();
    await expect(
      client.page.getByRole("radio", { name: "10번 캐릭터", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await client.page.keyboard.press("Escape");
  });
});

test.describe("Phase J #1 — 동일 타일 스폰 닉네임 겹침 (white-box: 실제 nameTags.ts 모듈)", () => {
  test("같은 프레임에 여러 add()가 몰려도(초기 attach 리플레이) 최종 상태는 겹치지 않는다", async () => {
    await client.page.goto("/?room=plaza");
    // No need to reach the world at all: this drives the real module directly against a fake
    // scene stub, exactly like a plain unit test would, just inside a real DOM/window.
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/world/nameTags.ts");

      class FakeText {
        x = 0;
        y = 0;
        setOrigin(): FakeText {
          return this;
        }
        setDepth(): FakeText {
          return this;
        }
        setPosition(x: number, y: number): void {
          this.x = x;
          this.y = y;
        }
        destroy(): void {}
      }

      const fakeScene = {
        add: {
          text: (x: number, y: number): FakeText => {
            const t = new FakeText();
            t.x = x;
            t.y = y;
            return t;
          },
        },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tags = new (mod as any).NameTags(fakeScene);
      const spriteA = { x: 100, y: 200, displayHeight: 32, originY: 1 };
      const spriteB = { x: 100, y: 200, displayHeight: 52, originY: 0.96 };
      const spriteC = { x: 100, y: 200, displayHeight: 32, originY: 1 };

      // Three players already sharing a tile, added back-to-back in one synchronous burst —
      // exactly what WorldScene.create()'s attach() replay does for players already in view.
      tags.add("A", spriteA, "Alice");
      tags.add("B", spriteB, "Bob");
      tags.add("C", spriteC, "Carol");

      const activeAfterBurst = (tags as unknown as { active: Map<string, { text: FakeText }> })
        .active;
      const burstYs = ["A", "B", "C"].map((id) => activeAfterBurst.get(id)!.text.y);

      // The next render tick's update() must always self-heal to 3 distinct, stable positions.
      tags.update();
      const activeAfterUpdate = (tags as unknown as { active: Map<string, { text: FakeText }> })
        .active;
      const settledYs = ["A", "B", "C"].map((id) => activeAfterUpdate.get(id)!.text.y);

      return {
        burstDistinct: new Set(burstYs).size,
        burstYs,
        settledDistinct: new Set(settledYs).size,
        settledYs,
      };
    });

    // This is the actual bug surface: layout() is invoked once per add() without first resetting
    // every tracked label back to its sprite baseline, so a burst of adds on an already-stacked
    // tile double- and triple-subtracts the stack offset on the earlier labels.
    expect(
      result.burstDistinct,
      `add() burst produced overlapping/incorrect y positions: ${JSON.stringify(result.burstYs)}`,
    ).toBe(3);
    expect(result.settledDistinct, `update() should always settle to 3 distinct rows: ${JSON.stringify(result.settledYs)}`).toBe(3);
    expect(result.burstYs).toEqual(result.settledYs);
    expect(result.settledYs[0]! - result.settledYs[1]!).toBeCloseTo(13);
    expect(result.settledYs[1]! - result.settledYs[2]!).toBeCloseTo(13);
    expect(result.settledYs[0]).toBeLessThan(200 - 52 * 0.96);
  });
});

test.describe("Phase J #2 — homeButton.destroy() restores hidden/disabled (white-box)", () => {
  test("destroy() 이후 버튼은 disabled=true, hidden=true 로 복구된다", async () => {
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/homeButton.ts");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance = new (mod as any).HomeButton(() => {});
      instance.destroy();
      const btn = document.querySelector("#home-button") as HTMLButtonElement;
      return { disabled: btn.disabled, hidden: btn.hidden };
    });
    expect(result).toEqual({ disabled: true, hidden: true });
  });
});

test.describe("Phase J #3 — minimap.destroy() invariant: panelOpen survives a real room hop", () => {
  test("미니맵을 연 채로 실제 room hop을 해도 새 room에서 미니맵이 열린 채로 유지된다", async () => {
    await joinRoom(client.page, "plaza");
    await tapKey(client.page, "KeyM");
    await expect(client.page.locator("#minimap")).toBeVisible();
    await expect(client.page.locator("#minimap-button")).toHaveAttribute("aria-expanded", "true");

    // plaza(31,20) -> hunting-ground north door, same walk pattern already proven in
    // pass-g-tester-verification.spec.ts's round-trip test.
    await holdKey(client.page, "ArrowUp", 160);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowLeft", 280);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowUp", 1350);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowRight", 280);
    await client.page.waitForTimeout(1500); // fade-out + reconnect + fade-in (hop())

    // If destroy() ever regresses to also closing the panel or resetting panelOpen, this comes
    // back hidden instead — the exact regression the architect flagged as most dangerous.
    await expect(client.page.locator("#minimap")).toBeVisible();
    await expect(client.page.locator("#minimap-button")).toHaveAttribute("aria-expanded", "true");
    await expect(client.page.locator("#minimap-canvas")).toHaveAttribute(
      "aria-label",
      "hunting-ground 미니맵",
    );
  });
});

test.describe("Phase J #5 — 홈 쿨다운이 cross-room hop 성공 뒤에도 유지된다", () => {
  test("cross-room 홈 hop 성공 직후, 새로 지어진 HomeButton도 즉시 disabled 상태다", async () => {
    await joinRoom(client.page, "plaza"); // home = plaza
    await holdKey(client.page, "ArrowUp", 160);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowLeft", 280);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowUp", 1350);
    await client.page.waitForTimeout(80);
    await holdKey(client.page, "ArrowRight", 280);
    await client.page.waitForTimeout(1500); // now in hunting-ground

    await client.page.keyboard.press("KeyH"); // cross-room hop back home (plaza)
    await client.page.waitForTimeout(1500); // fade + rejoin + fade

    // A freshly constructed HomeButton for the new plaza WorldScene instance must already read
    // the module-scope cooldown deadline and start disabled — proving it survived destroy()
    // and reconstruction rather than resetting on the new instance (docs §1.5).
    await expect(client.page.locator("#home-button")).toBeDisabled();
  });
});

test.describe("Phase J #6 — 아바타 피커 방향키가 행 경계에서 wrap 대신 clamp된다", () => {
  test("행 끝에서 오른쪽/왼쪽으로 계속 눌러도 다음/이전 행으로 넘어가지 않고, 위아래는 정상 동작한다", async () => {
    await joinRoom(client.page, "plaza", { skinIndex: 0 });
    await tapKey(client.page, "KeyC");
    await client.page.locator("#character-menu-change-skin").click();
    await expect(client.page.locator("#avatar-picker")).toBeVisible();

    const grid = client.page.locator("#avatar-picker-grid");
    // COLUMNS = 6 (avatarPicker.ts): index 0 is row0/col0. 6x ArrowRight would wrap into row1/col0
    // (index 6, "7번 캐릭터") under the old wrap bug; clamped, it must stop at row0/col5 ("6번").
    for (let i = 0; i < 6; i += 1) {
      await grid.press("ArrowRight");
    }
    await expect(client.page.getByRole("radio", { name: "6번 캐릭터", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // Row axis must be unaffected by the column fix: one ArrowDown from row0/col5 goes to
    // row1/col5 (index 11, "12번 캐릭터").
    await grid.press("ArrowDown");
    await expect(client.page.getByRole("radio", { name: "12번 캐릭터", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // All the way left from row1/col5 (index 11) must clamp at col0 of that same row (index 6,
    // "7번 캐릭터"), never underflowing into row0 — deliberately not pressing ArrowUp first,
    // since that would move back to row0 and make this assert the wrong row's clamp.
    for (let i = 0; i < 6; i += 1) {
      await grid.press("ArrowLeft");
    }
    await expect(client.page.getByRole("radio", { name: "7번 캐릭터", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await client.page.keyboard.press("Escape");
  });
});
