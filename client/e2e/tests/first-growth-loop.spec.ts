import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { unpack } from "@colyseus/msgpackr";
import { decode, Decoder } from "@colyseus/schema";
import { Protocol } from "@colyseus/shared-types";
import {
  RoomState, ServerMessage, type CurrencyChanged, type EquipmentChanged,
  type ItemGranted, type ItemRemoved, type MonsterHit, type QuestState,
} from "@zep-test/shared";
import { launchSharedBrowser } from "../helpers/browser";
import { waitForCanvasReady } from "../helpers/canvas";
import { dismissClassPicker, joinRoom } from "../helpers/flows";
import { holdKey } from "../helpers/input";

type WireEvent = { type: string | number; data: unknown };
type BagItem = { itemKey: string; quantity: number; equipped: boolean; sellValue?: number };

// Observe the same schema and ROOM_DATA bytes the browser receives. This decoder cannot send
// messages, access the running room, change RNG, or seed an account's currency/items/progress.
function observeGame(page: Page) {
  const events: WireEvent[] = [];
  const errors: string[] = [];
  const sessions: string[] = [];
  let state = new RoomState();
  page.on("pageerror", error => errors.push(error.message));
  page.on("websocket", socket => {
    const sessionId = new URL(socket.url()).searchParams.get("sessionId");
    if (sessionId) sessions.push(sessionId);
    const decoder = new Decoder(new RoomState());
    socket.on("framereceived", ({ payload }) => {
      if (!Buffer.isBuffer(payload)) return;
      if (payload[0] === Protocol.ROOM_STATE || payload[0] === Protocol.ROOM_STATE_PATCH) {
        decoder.decode(payload, { offset: 1 });
        state = decoder.state;
      } else if (payload[0] === Protocol.ROOM_DATA) {
        const iterator = { offset: 1 };
        const type = decode.stringCheck(payload, iterator)
          ? decode.string(payload, iterator) : decode.number(payload, iterator);
        events.push({ type, data: unpack(payload, { start: iterator.offset }) });
      }
    });
  });
  return {
    events, errors, sessions,
    state: () => state,
    messages: <T>(type: string): T[] => events.filter(event => event.type === type).map(event => event.data as T),
  };
}

async function position(page: Page): Promise<[number, number]> {
  const text = await page.locator(".region-guide__coordinates").innerText();
  const parts = text.split(",").map(Number);
  return [parts[0]!, parts[1]!];
}

async function step(page: Page, key: string): Promise<void> {
  await holdKey(page, key, 65);
  await page.waitForTimeout(180);
}

type TileMap = {
  width: number; height: number;
  layers: { name: string; data: number[] }[];
  tilesets: { firstgid: number; tiles: { id: number; properties?: { name: string; value: unknown }[] }[] }[];
};
const collisionMaps = new Map<string, TileMap>();

async function routeKey(page: Page, mapKey: string, x: number, y: number, targetX: number, targetY: number): Promise<string> {
  let map = collisionMaps.get(mapKey);
  if (!map) {
    const response = await page.request.get(`/maps/${mapKey}.json`);
    expect(response.ok()).toBe(true);
    map = await response.json() as TileMap;
    collisionMaps.set(mapKey, map);
  }
  const collision = map.layers.find(layer => layer.name === "collision")!.data;
  const tileset = map.tilesets[0]!;
  const blocked = new Set(tileset.tiles.filter(tile => tile.properties?.some(property =>
    property.name === "collides" && property.value === true)).map(tile => tile.id + tileset.firstgid));
  const start = y * map.width + x;
  const goal = targetY * map.width + targetX;
  const queue = [start];
  const directions = [[1, 0, "ArrowRight"], [-1, 0, "ArrowLeft"], [0, 1, "ArrowDown"], [0, -1, "ArrowUp"]] as const;
  const firstKey = new Map<number, string>([[start, ""]]);
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const [dx, dy, key] of directions) {
      const nextX = current % map.width + dx;
      const nextY = Math.floor(current / map.width) + dy;
      const next = nextY * map.width + nextX;
      if (nextX < 0 || nextY < 0 || nextX >= map.width || nextY >= map.height
        || firstKey.has(next) || blocked.has((collision[next]! & 0x1fffffff))) continue;
      const first = current === start ? key : firstKey.get(current)!;
      if (next === goal) return first;
      firstKey.set(next, first);
      queue.push(next);
    }
  }
  throw new Error(`No public-map path in ${mapKey} from ${x},${y} to ${targetX},${targetY}`);
}

async function walk(page: Page, targetX: number, targetY: number, mapKey = "plaza"): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    const [x, y] = await position(page);
    if (x === targetX && y === targetY) return;
    await step(page, await routeKey(page, mapKey, x, y, targetX, targetY));
  }
  throw new Error(`Walking to ${targetX},${targetY} stalled at ${await position(page)}`);
}

async function readBag(page: Page): Promise<BagItem[]> {
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/inventory");
    if (!response.ok) throw new Error(`inventory read failed: ${response.status}`);
    return await response.json() as { items: BagItem[] };
  });
  return body.items.sort((left, right) => left.itemKey.localeCompare(right.itemKey));
}

test("first growth loop earns, sells, equips and survives a fresh session for the same account", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const browser = await launchSharedBrowser();
  // Local gateway fixture: production's existing onAuth derives the UUID from this header.
  // This exercises account hydration, not the separately unverified APISIX/SSO deployment.
  const ownerKey = randomUUID();
  const token = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${
    Buffer.from(JSON.stringify({ sub: ownerKey, preferred_username: "Growth E2E" })).toString("base64url")
  }.local-fixture`;
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:5173", viewport: { width: 1024, height: 576 },
    extraHTTPHeaders: { "x-auth-request-access-token": token },
  });
  context.setDefaultTimeout(10_000);
  // Local Vite and game-server ports are different origins; production's gateway is one origin.
  // Forward real matchmaking responses, permitting only this fixture header on its preflight.
  await context.route("**/matchmake/**", async route => {
    if (route.request().method() !== "OPTIONS") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: {
      ...response.headers(),
      "access-control-allow-headers": `${response.headers()["access-control-allow-headers"] ?? ""}, x-auth-request-access-token`,
    } });
  });
  let page = await context.newPage();
  const wire = observeGame(page);
  try {
    await joinRoom(page, "plaza");
    await expect.poll(() => wire.messages<CurrencyChanged>(ServerMessage.CurrencyChanged).at(-1)?.balance).toBe(0);
    expect(await readBag(page)).toEqual([]);
    expect([...wire.state().players.values()].map(player => player.nickname)).toContain("Growth E2E");

    await walk(page, 29, 20);
    await walk(page, 29, 22);
    await expect(page.locator(".object__quest-title")).toHaveText("첫 사냥");
    await page.locator(".object__quest-accept").click();
    await expect(page.locator(".quests__count")).toHaveText("0 / 3");
    await page.locator("#object-panel-close").click();
    await walk(page, 31, 24);
    await step(page, "ArrowDown");
    await expect(page.locator(".region-guide strong")).toHaveText("초보 들판");
    await dismissClassPicker(page);
    await expect(page.locator(".quests__count")).toHaveText("0 / 3");
    await walk(page, 35, 24, "hunting-ground");
    await page.locator("#game-root canvas").click({ position: { x: 400, y: 300 } });

    // Drops remain genuinely random. Continue actual hunting until three kills AND one saleable
    // drop, with an explicit bound instead of substituting a fake drop when unlucky.
    const kills = () => wire.messages<MonsterHit>(ServerMessage.MonsterHit)
      .filter(hit => hit.hpRemaining === 0 && hit.monsterId.startsWith("hg-squirrel-") && wire.sessions.includes(hit.bySessionId));
    const loot = () => wire.messages<ItemGranted>(ServerMessage.ItemGranted).find(item => (item.sellValue ?? 0) > 0);
    const huntDeadline = Date.now() + 90_000;
    while ((kills().length < 3 || !loot()) && kills().length < 15 && Date.now() < huntDeadline) {
      const [x, y] = await position(page);
      const target = [...wire.state().monsters.entries()]
        .filter(([, monster]) => monster.kind === "squirrel" && monster.tileY >= 21)
        .sort(([, a], [, b]) => Math.max(Math.abs(a.tileX - x), Math.abs(a.tileY - y))
          - Math.max(Math.abs(b.tileX - x), Math.abs(b.tileY - y)))[0];
      expect(target, "a live entrance-band squirrel must remain observable").toBeDefined();
      const monster = target![1];
      if (Math.max(Math.abs(monster.tileX - x), Math.abs(monster.tileY - y)) <= 1) {
        await holdKey(page, "Space", 2_100);
      } else {
        await step(page, await routeKey(page, "hunting-ground", x, y, monster.tileX, monster.tileY));
      }
    }
    expect(kills().length, "three real monster deaths are required").toBeGreaterThanOrEqual(3);
    const drop = loot();
    expect(drop, "real saleable loot must drop within the bounded hunt").toBeDefined();
    await expect.poll(() => wire.messages<QuestState>(ServerMessage.QuestUpdated).at(-1))
      .toMatchObject({ questId: "first-hunt", status: "completed", killCount: 3 });
    await expect.poll(() => wire.messages<CurrencyChanged>(ServerMessage.CurrencyChanged).filter(event => event.reason === "quest"))
      .toEqual([{ balance: 50, delta: 50, reason: "quest" }]);

    await walk(page, 35, 30, "hunting-ground");
    await step(page, "ArrowDown");
    await expect(page.locator(".region-guide strong")).toHaveText("남문 마을");
    await dismissClassPicker(page);
    await page.locator("#inventory-button").click();
    await expect(page.locator("#inventory-list")).toHaveAttribute("aria-busy", "false");
    const beforeSale = await readBag(page);
    const saleItem = beforeSale.find(item => item.itemKey === drop!.itemKey)!;
    expect(saleItem.quantity).toBeGreaterThan(0);
    await page.locator(`#inventory-list [data-item-key="${drop!.itemKey}"] .bag__sell`).click();
    const balanceAfterSale = 50 + drop!.sellValue!;
    await expect.poll(() => wire.messages<CurrencyChanged>(ServerMessage.CurrencyChanged).at(-1))
      .toEqual({ balance: balanceAfterSale, delta: drop!.sellValue, reason: "shop-sell" });
    expect(wire.messages<ItemRemoved>(ServerMessage.ItemRemoved).at(-1))
      .toMatchObject({ itemKey: drop!.itemKey, quantity: 1, total: saleItem.quantity - 1, reason: "shop-sell" });
    const afterSale = await readBag(page);
    expect(afterSale.find(item => item.itemKey === drop!.itemKey)?.quantity ?? 0).toBe(saleItem.quantity - 1);
    await page.locator("#inventory-close").click();
    await walk(page, 31, 20);
    await walk(page, 35, 20);
    const daggerListing = page.locator(".object__shop-row").filter({ has: page.locator(".object__shop-name", { hasText: "낡은 단검" }) });
    await expect(daggerListing.locator(".object__shop-price")).toHaveText("40전");
    await daggerListing.locator(".object__shop-buy").click();
    await expect.poll(() => wire.messages<CurrencyChanged>(ServerMessage.CurrencyChanged).at(-1))
      .toEqual({ balance: balanceAfterSale - 40, delta: -40, reason: "shop-buy" });
    await page.locator("#object-panel-close").click();
    await page.locator("#inventory-button").click();
    const dagger = page.locator('#inventory-list [data-item-key="old-dagger"]');
    await dagger.locator(".bag__equip").click();
    await expect(dagger).toHaveAttribute("data-equipped", "true");
    expect(wire.messages<EquipmentChanged>(ServerMessage.EquipmentChanged).at(-1))
      .toMatchObject({ slot: "weapon", itemKey: "old-dagger", applied: true });
    const beforeReconnect = await readBag(page);
    expect(beforeReconnect.find(item => item.itemKey === "old-dagger"))
      .toMatchObject({ quantity: 1, equipped: true });
    const expectedBalance = balanceAfterSale - 40;
    await expect(page.locator("#inventory-currency")).toContainText(String(expectedBalance));
    await page.screenshot({ path: testInfo.outputPath("earned-and-equipped.png") });

    // A new page makes a fresh room session; the same gateway identity must hydrate its assets.
    await page.close();
    page = await context.newPage();
    const reconnected = observeGame(page);
    await page.goto("/?room=plaza");
    await waitForCanvasReady(page);
    await dismissClassPicker(page);
    await expect.poll(() => reconnected.messages<CurrencyChanged>(ServerMessage.CurrencyChanged).at(-1))
      .toEqual({ balance: expectedBalance, delta: 0, reason: "sync" });
    await expect(page.locator('.quests__row[data-status="completed"] .quests__count')).toHaveText("3 / 3");
    await page.locator("#inventory-button").click();
    await expect(page.locator('#inventory-list [data-item-key="old-dagger"]')).toHaveAttribute("data-equipped", "true");
    await expect(page.locator('[data-slot="weapon"] .bag__slot-name')).toContainText("낡은 단검");
    expect(await readBag(page)).toEqual(beforeReconnect);
    expect(reconnected.sessions[0]).toBeTruthy();
    expect(wire.sessions).not.toContain(reconnected.sessions[0]);
    expect(reconnected.messages<CurrencyChanged>(ServerMessage.CurrencyChanged).filter(event => event.reason === "quest")).toEqual([]);
    expect([...wire.errors, ...reconnected.errors]).toEqual([]);
    const evidence = { ownerKey, kills: kills().length, sold: drop!.itemKey, expectedBalance,
      inventory: beforeReconnect, sessions: [...wire.sessions, ...reconnected.sessions] };
    await testInfo.attach("growth-loop-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    console.log("first growth loop evidence", JSON.stringify(evidence));
  } catch (error) {
    await testInfo.attach("growth-loop-failure", {
      body: JSON.stringify({ sessions: wire.sessions, errors: wire.errors, lastEvents: wire.events.slice(-15) }, null, 2),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
});
