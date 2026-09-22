import { ok } from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { launchSharedBrowser, openFreshClient, type Client } from "../helpers/browser";

/**
 * White-box coverage for the client half of roadmap R04-c (docs/r04-settlement.md §9): the shop
 * block inside the NPC panel, and the 판매/사용 buttons inside the bag.
 *
 * The server's `shop:buy`/`shop:sell`/`item:use` handlers were still being implemented alongside
 * this work, so there is no live round trip here the way `quest-ui.spec.ts`'s first test drives one
 * through a real join — everything below constructs the panels directly and feeds them the messages
 * a server would send, `quest-ui.spec.ts`'s own two white-box `describe` blocks. What this cannot
 * confirm: that a real `shop:buy` reaches `metaverseRoom.ts` and comes back as the messages these
 * tests assume, or that the price/denial reasons these fixtures use match what the server actually
 * authors in `shopDefinitions.ts`/`itemDefinitions.ts`.
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

test.describe("ObjectPanel 상점 블록 — 구매 nonce와 재오픈 (white-box)", () => {
  test("첫 클릭은 새 nonce를 보내고, 응답 전 재클릭은 무시하며, 재오픈은 진행 중 상태를 되살린다", async () => {
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      const mod = await import("/src/ui/objectPanel.ts");
      const sent: { npcObjectId: string; itemKey: string; quantity: number; nonce: string }[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const panel = new (mod as any).ObjectPanel(
        () => {},
        () => {},
        (npcObjectId: string, itemKey: string, quantity: number, nonce: string) =>
          sent.push({ npcObjectId, itemKey, quantity, nonce }),
      );
      const listing = { itemKey: "herb", name: "약초", icon: "herb", price: 15 };
      const npcPayload = {
        kind: "npc",
        objectId: "plaza-shop-npc",
        title: "상점",
        body: "회복 소모품을 팝니다.",
        blocksMovement: false,
        shop: { listings: [listing] },
      };
      const buy = () => document.querySelector<HTMLButtonElement>(".object__shop-buy")!;
      const price = () => document.querySelector<HTMLElement>(".object__shop-price")!.textContent;
      const name = () => document.querySelector<HTMLElement>(".object__shop-name")!.textContent;

      panel.open(npcPayload);
      const offered = { name: name(), price: price(), label: buy().textContent, disabled: buy().disabled };

      buy().click();
      const firstClick = { sent: [...sent], disabled: buy().disabled, label: buy().textContent };

      // Disabled while in flight — a second press before a reply must not send a second request.
      buy().click();
      const secondClickIgnored = sent.length;

      // A denial for a different item must not touch this row.
      panel.applyShopDenied({ action: "buy", itemKey: "carrot", reason: "unknown-item" });
      const afterForeignDenial = { disabled: buy().disabled, label: buy().textContent };

      panel.applyShopDenied({ action: "buy", itemKey: "herb", reason: "insufficient-balance" });
      const afterDenial = { disabled: buy().disabled, label: buy().textContent };

      // Resolved: a fresh click now must mint a different nonce, not resend the settled one.
      buy().click();
      const freshPurchase = { sent: [...sent] };

      // Stepping off the tile and back on while this second purchase is still unanswered must
      // redraw the row already mid-attempt — the dropped-reply retry design §9 D8 asks for — and a
      // click on that redrawn button must resend the *same* nonce, not mint a third one.
      panel.close();
      panel.open(npcPayload);
      const reopenedPending = { disabled: buy().disabled, label: buy().textContent };
      buy().click();
      const afterReopenClick = { sent: [...sent] };

      // Resolving via a grant (the buy-success gap design §9 D12 documents) clears it the same way.
      panel.resolveShopAttempt("herb");
      const afterGrantResolve = { disabled: buy().disabled, label: buy().textContent };

      // An NPC with nothing to sell renders exactly what it did before shops existed.
      panel.open({ ...npcPayload, shop: undefined });
      const plainNpc = document.querySelectorAll(".object__shop").length;

      return {
        offered,
        firstClick,
        secondClickIgnored,
        afterForeignDenial,
        afterDenial,
        freshPurchase,
        reopenedPending,
        afterReopenClick,
        afterGrantResolve,
        plainNpc,
      };
    });

    expect(result.offered).toEqual({ name: "약초", price: "15전", label: "구매", disabled: false });
    expect(result.firstClick.sent).toHaveLength(1);
    const firstPurchase = result.firstClick.sent[0];
    ok(firstPurchase, "the first buy click must send a request");
    expect(firstPurchase).toMatchObject({ npcObjectId: "plaza-shop-npc", itemKey: "herb", quantity: 1 });
    expect(typeof firstPurchase.nonce).toBe("string");
    expect(firstPurchase.nonce.length).toBeGreaterThan(0);
    expect(result.firstClick).toMatchObject({ disabled: true, label: "구매하는 중…" });
    expect(result.secondClickIgnored, "a disabled button must not send twice").toBe(1);
    expect(result.afterForeignDenial, "a denial for another item must not reset this row").toEqual({
      disabled: true,
      label: "구매하는 중…",
    });
    expect(result.afterDenial, "a denial for this item resets it to pressable").toEqual({
      disabled: false,
      label: "구매",
    });

    const firstNonce = firstPurchase.nonce;
    expect(result.freshPurchase.sent).toHaveLength(2);
    const secondPurchase = result.freshPurchase.sent[1];
    ok(secondPurchase, "buying after a denial must send a second request");
    expect(secondPurchase.nonce, "a purchase after resolution is a fresh attempt").not.toBe(
      firstNonce,
    );

    expect(result.reopenedPending, "a reopen must redraw an unresolved attempt as still in flight").toEqual({
      disabled: true,
      label: "구매하는 중…",
    });
    expect(result.afterReopenClick.sent, "a disabled reopened button still must not resend").toHaveLength(2);

    expect(result.afterGrantResolve).toEqual({ disabled: false, label: "구매" });
    expect(result.plainNpc, "an NPC without a shop draws no shop block").toBe(0);
  });
});

test.describe("InventoryPanel 판매/사용 버튼 — nonce, 재오픈, 0개 소진 (white-box)", () => {
  test("판매/사용은 독립된 nonce를 쓰고, 재오픈은 진행 중 상태를 되살리며, 0개가 되면 행이 사라진다", async () => {
    await client.page.route("**/api/inventory", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              itemKey: "herb",
              name: "약초",
              icon: "herb",
              quantity: 5,
              equipped: false,
              sellValue: 12,
              consumable: true,
            },
          ],
        }),
      }),
    );
    await client.page.goto("/?room=plaza");
    const result = await client.page.evaluate(async () => {
      async function waitFor<T>(check: () => T | null, timeoutMs = 2000): Promise<T> {
        const start = Date.now();
        for (;;) {
          const value = check();
          if (value) {
            return value;
          }
          if (Date.now() - start > timeoutMs) {
            throw new Error("timed out waiting for condition");
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      const mod = await import("/src/ui/inventoryPanel.ts");
      const sent = {
        sell: [] as { itemKey: string; quantity: number; nonce: string }[],
        use: [] as { itemKey: string; nonce: string }[],
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const panel = new (mod as any).InventoryPanel(
        () => {},
        () => {},
        (itemKey: string, quantity: number, nonce: string) => sent.sell.push({ itemKey, quantity, nonce }),
        (itemKey: string, nonce: string) => sent.use.push({ itemKey, nonce }),
      );
      const button = document.querySelector<HTMLButtonElement>("#inventory-button")!;
      const closeButton = document.querySelector<HTMLButtonElement>("#inventory-close")!;
      const sell = () => document.querySelector<HTMLButtonElement>(".bag__sell");
      const use = () => document.querySelector<HTMLButtonElement>(".bag__use");
      const count = () => document.querySelector<HTMLElement>(".bag__count")?.textContent ?? null;
      const statusText = () => document.querySelector<HTMLElement>("#inventory-status-text")!.textContent;

      button.click();
      await waitFor(() => sell());
      const initial = { count: count(), sellLabel: sell()!.textContent, useLabel: use()!.textContent };

      sell()!.click();
      const firstSell = { sent: [...sent.sell], disabled: sell()!.disabled, label: sell()!.textContent };

      // Close and reopen while the sale is unanswered — a dropped reply, not a new attempt.
      closeButton.click();
      button.click();
      await waitFor(() => sell());
      const reopenedPending = { disabled: sell()!.disabled, label: sell()!.textContent };
      sell()!.click(); // disabled: must not resend
      const stillOneSent = sent.sell.length;

      panel.applyShopDenied({ action: "sell", itemKey: "herb", reason: "insufficient-item" });
      const afterDenial = { disabled: sell()!.disabled, label: sell()!.textContent };

      sell()!.click();
      const secondSell = { sent: [...sent.sell] };

      panel.applyItemRemoved({
        itemKey: "herb",
        name: "약초",
        icon: "herb",
        quantity: 1,
        total: 4,
        reason: "shop-sell",
      });
      const afterSaleSettled = { disabled: sell()!.disabled, label: sell()!.textContent, count: count() };

      use()!.click();
      const afterUseClick = {
        sent: [...sent.use],
        useDisabled: use()!.disabled,
        useLabel: use()!.textContent,
        // Selling and using are independent attempts on the same row (design §9 D8).
        sellLabel: sell()!.textContent,
      };

      panel.applyItemRemoved({
        itemKey: "herb",
        name: "약초",
        icon: "herb",
        quantity: 1,
        total: 0,
        reason: "consume",
      });
      const afterConsumedToZero = { rows: document.querySelectorAll(".bag__row").length, statusText: statusText() };

      return {
        initial,
        firstSell,
        reopenedPending,
        stillOneSent,
        afterDenial,
        secondSell,
        afterSaleSettled,
        afterUseClick,
        afterConsumedToZero,
      };
    });

    expect(result.initial).toEqual({ count: "5", sellLabel: "판매", useLabel: "사용" });
    expect(result.firstSell.sent).toHaveLength(1);
    expect(result.firstSell.sent[0]).toMatchObject({ itemKey: "herb", quantity: 1 });
    expect(result.firstSell).toMatchObject({ disabled: true, label: "판매하는 중…" });

    expect(
      result.reopenedPending,
      "reopening the bag must redraw an unresolved sale as still in flight",
    ).toEqual({ disabled: true, label: "판매하는 중…" });
    expect(result.stillOneSent, "a disabled reopened button must not resend").toBe(1);

    expect(result.afterDenial, "a denial resets the row to pressable").toEqual({
      disabled: false,
      label: "판매",
    });

    const firstSale = result.firstSell.sent[0];
    ok(firstSale, "the first sell click must send a request");
    const firstNonce = firstSale.nonce;
    expect(result.secondSell.sent).toHaveLength(2);
    const secondSale = result.secondSell.sent[1];
    ok(secondSale, "selling after a denial must send a second request");
    expect(secondSale.nonce, "a sale after resolution is a fresh attempt").not.toBe(firstNonce);

    expect(result.afterSaleSettled, "a settled sale resolves the button and patches the count").toEqual({
      disabled: false,
      label: "판매",
      count: "4",
    });

    expect(result.afterUseClick.sent).toHaveLength(1);
    expect(result.afterUseClick.sent[0]).toMatchObject({ itemKey: "herb" });
    expect(result.afterUseClick).toMatchObject({
      useDisabled: true,
      useLabel: "사용하는 중…",
      sellLabel: "판매",
    });

    expect(result.afterConsumedToZero, "a stack that hits zero drops its row and the bag goes empty").toEqual({
      rows: 0,
      statusText: "가방이 비어 있습니다.",
    });
  });
});
