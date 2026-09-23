import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, describe, it } from "node:test";
import { ColyseusSDK } from "@colyseus/sdk";
import { ColyseusTestServer } from "@colyseus/testing";
import { ClientMessage as C, ServerMessage as S, type ServerMessagePayload } from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { InMemoryTradeStore } from "../db/tradeStore";
import { InMemoryClassStore } from "../db/classStore";
import { InMemoryProgressStore } from "../db/progressStore";
import { InMemoryQuestStore } from "../db/questStore";
import { createGameServer } from "../server";
import type { MetaverseRoom } from "./metaverseRoom";
import { refreshEconomy } from "./socialRuntime";

const PORT = 27177;
const currency = new InMemoryCurrencyStore();
const inventory = new InMemoryInventoryStore();
const classes = new InMemoryClassStore();
const progress = new InMemoryProgressStore();
const quests = new InMemoryQuestStore();
let server: ColyseusTestServer;

async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, `timed out: ${label}`);
    await delay(10);
  }
}

async function connect(room: MetaverseRoom, owner = randomUUID(), upper = false) {
  const token = `header.${Buffer.from(JSON.stringify({ sub: upper ? owner.toUpperCase() : owner })).toString("base64url")}.sig`;
  const sdk = new ColyseusSDK(`ws://127.0.0.1:${PORT}`, { headers: { "x-auth-request-access-token": token } });
  const client = await sdk.joinById(room.roomId, { nickname: owner.slice(0, 8) });
  const messages: { type: string; data: unknown }[] = [];
  client.onMessage("*", (type, data) => messages.push({ type: String(type), data }));
  await until(() => room.clients.find((entry) => entry.sessionId === client.sessionId)?.userData?.questRowsHydrated === true, "session hydration");
  return {
    owner, client, messages,
    session: () => room.clients.find((entry) => entry.sessionId === client.sessionId)!.userData!,
    async send<T extends keyof ServerMessagePayload>(type: string, payload: unknown, response: T,
      matches: (value: ServerMessagePayload[T]) => boolean = () => true): Promise<ServerMessagePayload[T]> {
      const offset = messages.length;
      client.send(type, payload);
      const found = () => messages.slice(offset).find((entry) => entry.type === response && matches(entry.data as ServerMessagePayload[T]));
      await until(() => found() !== undefined, response);
      return found()!.data as ServerMessagePayload[T];
    },
  };
}
type Peer = Awaited<ReturnType<typeof connect>>;

async function party(first: Peer, second: Peer): Promise<void> {
  await first.send(C.CreateParty, undefined, S.PartyChanged, (event) => event.party !== null);
  first.client.send(C.InviteParty, { targetSessionId: second.client.sessionId });
  await until(() => second.messages.some((entry) => entry.type === S.PartyInvited), "party invitation");
  const invitation = second.messages.find((entry) => entry.type === S.PartyInvited)!.data as ServerMessagePayload[typeof S.PartyInvited];
  await second.send(C.RespondPartyInvite, { inviteId: invitation.inviteId, accept: true }, S.PartyChanged,
    (event) => event.party?.members.length === 2);
}

async function trade(first: Peer, second: Peer) {
  const invited = await first.send(C.RequestTrade, { targetSessionId: second.client.sessionId }, S.TradeChanged);
  return second.send(C.RespondTrade, { tradeId: invited.tradeId, accept: true }, S.TradeChanged,
    (event) => event.phase === "negotiating");
}

describe("social features across real authenticated WebSocket clients", { concurrency: false }, () => {
  before(async () => {
    const game = createGameServer(undefined, inventory, undefined, progress, quests, new Set(), currency,
      new InMemorySettlementStore(currency, inventory), classes, new InMemoryTradeStore(currency, inventory));
    await game.listen(PORT, "127.0.0.1");
    server = new ColyseusTestServer(game);
  });
  afterEach(async () => { await server.cleanup(); });
  after(async () => { await server.shutdown(); });

  it("requires both current revisions, conserves assets, and refreshes another tab with uppercase SSO", async () => {
    const room = await server.createRoom<MetaverseRoom>("plaza");
    const first = await connect(room, "abcdef12-3456-4789-abcd-abcdefabcdef", true);
    const second = await connect(room);
    const siblingRoom = await server.createRoom<MetaverseRoom>("plaza");
    const sibling = await connect(siblingRoom, first.owner);
    await currency.credit(first.owner, 100); await currency.credit(second.owner, 50);
    await inventory.add(first.owner, "herb", 2);
    assert.equal(first.session().ownerKey, first.owner);
    const active = await trade(first, second);
    const offer = await first.send(C.UpdateTradeOffer, { tradeId: active.tradeId, revision: 0,
      offer: { currency: 0, items: [{ itemKey: "herb", quantity: 1 }] } }, S.TradeChanged, (event) => event.revision === 1);
    const stale = await second.send(C.ConfirmTrade, { tradeId: active.tradeId, revision: 0 }, S.TradeDenied);
    assert.equal(stale.reason, "stale-revision");
    const revised = await second.send(C.UpdateTradeOffer, { tradeId: active.tradeId, revision: offer.revision,
      offer: { currency: 10, items: [] } }, S.TradeChanged, (event) => event.revision === 2);
    await first.send(C.ConfirmTrade, { tradeId: active.tradeId, revision: revised.revision }, S.TradeChanged,
      (event) => event.participants.some((member) => member.sessionId === first.client.sessionId && member.confirmed));
    assert.equal(await currency.getBalance(first.owner), 100);
    await delay(260);
    await second.send(C.ConfirmTrade, { tradeId: active.tradeId, revision: revised.revision }, S.TradeChanged, (event) => event.phase === "completed");
    assert.equal(await currency.getBalance(first.owner), 110); assert.equal(await currency.getBalance(second.owner), 40);
    assert.equal((await inventory.list(second.owner)).find((item) => item.itemKey === "herb")?.quantity, 1);
    await until(() => sibling.messages.some((event) => event.type === S.CurrencyChanged &&
      (event.data as { balance: number }).balance === 110), "sibling currency refresh");
    await delay(260);
    assert.equal((await second.send(C.ConfirmTrade, { tradeId: active.tradeId, revision: 2 }, S.TradeDenied)).reason, "unavailable");
    assert.equal(await currency.getBalance(first.owner), 110);
  });

  it("cancels a pending trade on disconnect and transfers party leadership", async () => {
    const room = await server.createRoom<MetaverseRoom>("plaza");
    const first = await connect(room); const second = await connect(room);
    await party(first, second);
    await trade(first, second);
    await first.client.leave();
    await until(() => second.messages.some((entry) => entry.type === S.TradeChanged &&
      (entry.data as { reason?: string }).reason === "disconnected"), "disconnect cancellation");
    await until(() => second.messages.some((entry) => entry.type === S.PartyChanged &&
      (entry.data as ServerMessagePayload[typeof S.PartyChanged]).party?.leaderSessionId === second.client.sessionId), "leader transfer");
    assert.equal((await second.send(C.LeaveParty, undefined, S.PartyChanged)).party, null);
  });

  it("does not overwrite a committed shop balance with an older delayed trade refresh", async (context) => {
    for (const suppressWriteVersion of [false, true]) {
      const room = await server.createRoom<MetaverseRoom>("plaza");
      const owner = randomUUID();
      await currency.credit(owner, 100);
      const peer = await connect(room, owner);
      await until(() => peer.session().currencyBalance === 100, "initial currency hydration");
      let releaseRead!: () => void;
      const released = new Promise<void>((resolve) => { releaseRead = resolve; });
      let captured = false;
      const originalRead = currency.getBalance.bind(currency);
      const readMock = context.mock.method(currency, "getBalance", async (key: string) => {
        const balance = await originalRead(key);
        if (key === owner && !captured) {
          captured = true;
          assert.equal(balance, 100);
          await released;
        }
        return balance;
      });
      const refreshing = refreshEconomy([owner], "trade");
      const versions = (room as unknown as { currencySyncVersions: Map<string, number> }).currencySyncVersions;
      let undoVersionMock: (() => void) | undefined;
      try {
        await until(() => captured, "trade refresh read captured before the purchase");
        if (suppressWriteVersion) {
          // Test-only negative control removes exactly the new write-version invalidation.
          const versionMock = context.mock.method(versions, "set", () => versions);
          undoVersionMock = () => versionMock.mock.restore();
        }
        const purchased = await peer.send(C.BuyItem, {
          npcObjectId: "plaza-shop-npc", itemKey: "old-dagger", quantity: 1, nonce: randomUUID(),
        }, S.CurrencyChanged, (event) => event.reason === "shop-buy");
        assert.equal(purchased.balance, 60);
        assert.equal(peer.session().currencyBalance, 60);
        assert.equal(await originalRead(owner), 60);
        undoVersionMock?.(); undoVersionMock = undefined;
        releaseRead();
        await refreshing;
        // A later ordinary round trip is a wire barrier for any stale currency notification.
        await peer.send(C.Chat, { text: "currency-race-barrier" }, S.Chat);
        const currencyMessages = peer.messages.filter((entry) => entry.type === S.CurrencyChanged);
        const finalWireBalance = (currencyMessages.at(-1)!.data as { balance: number }).balance;
        assert.equal(peer.session().currencyBalance, suppressWriteVersion ? 100 : 60);
        assert.equal(finalWireBalance, suppressWriteVersion ? 100 : 60);
        assert.equal(await originalRead(owner), 60, "the authoritative store never regresses");
        assert.equal((await inventory.list(owner)).find((item) => item.itemKey === "old-dagger")?.quantity, 1);
      } finally {
        undoVersionMock?.(); releaseRead();
        await refreshing;
        readMock.mock.restore();
      }
    }
  });

  it("crafts once for a repeated nonce and declines a new unaffordable request without consuming items", async () => {
    const room = await server.createRoom<MetaverseRoom>("plaza");
    const peer = await connect(room);
    await currency.credit(peer.owner, 30);
    await inventory.add(peer.owner, "padded-armor", 2); await inventory.add(peer.owner, "den-fur", 6);
    const request = { recipeId: "reinforced-armor", nonce: randomUUID() };
    assert.equal((await peer.send(C.CraftItem, request, S.CraftResult)).ok, true);
    await delay(260);
    assert.equal((await peer.send(C.CraftItem, { ...request, nonce: request.nonce.toUpperCase() }, S.CraftResult)).ok, true);
    assert.equal(await currency.getBalance(peer.owner), 0);
    const bag = await inventory.list(peer.owner);
    assert.equal(bag.find((item) => item.itemKey === "reinforced-armor")?.quantity, 1);
    await delay(260);
    assert.equal((await peer.send(C.CraftItem, { ...request, nonce: randomUUID() }, S.CraftResult)).reason, "insufficient-balance");
    assert.deepEqual(await inventory.list(peer.owner), bag);
  });

  it("restricts ally healing to party membership and shares contribution EXP/accepted quests only", async () => {
    const room = await server.createRoom<MetaverseRoom>("hunting-ground");
    const healerId = randomUUID(); await classes.chooseOnce(healerId, "cleric");
    const first = await connect(room); const healer = await connect(room, healerId);
    const idle = await connect(room);
    // Seed combat conditions through the existing room fixture seam; party/skill actions travel on the wire.
    const internals = room as unknown as {
      applyMonsterDamage(client: unknown, session: unknown, monsterId: string, damage: number, now: number): void;
      proximityIndex: { move(id: string, position: { tileX: number; tileY: number }): void };
    };
    await until(() => healer.session().playerClass === "cleric", "class hydration");
    const targetId = room.state.monsters.keys().next().value!;
    const target = room.state.monsters.get(targetId)!;
    for (const peer of [first, healer, idle]) {
      const player = room.state.players.get(peer.client.sessionId)!;
      player.tileX = target.tileX; player.tileY = target.tileY;
      internals.proximityIndex.move(peer.client.sessionId, player);
    }
    first.session().hp = 30;
    assert.equal((await healer.send(C.UseSkill, { skillKey: "heal", targetSessionId: first.client.sessionId }, S.SkillDenied)).reason, "no-target");
    await party(first, healer);
    await delay(260);
    first.client.send(C.InviteParty, { targetSessionId: idle.client.sessionId });
    await until(() => idle.messages.some((entry) => entry.type === S.PartyInvited), "idle invitation");
    const invited = idle.messages.find((entry) => entry.type === S.PartyInvited)!.data as { inviteId: string };
    await idle.send(C.RespondPartyInvite, { inviteId: invited.inviteId, accept: true }, S.PartyChanged);
    await quests.accept(first.owner, "first-hunt"); await quests.accept(healer.owner, "first-hunt");
    first.session().questRowsHydrated = false; healer.session().questRowsHydrated = false;
    const firstServerClient = room.clients.find((entry) => entry.sessionId === first.client.sessionId)!;
    internals.applyMonsterDamage(firstServerClient, first.session(), targetId, 1, Date.now());
    healer.session().skillCooldowns.clear();
    const healed = await healer.send(C.UseSkill, { skillKey: "heal", targetSessionId: first.client.sessionId }, S.PlayerHealed);
    assert.ok(healed.healAmount > 0);
    internals.applyMonsterDamage(firstServerClient, first.session(), targetId, 10000, Date.now());
    await until(() => [...first.messages, ...healer.messages].some((entry) => entry.type === S.ExpGranted), "shared EXP");
    assert.equal((await progress.getExp(first.owner) ?? 0) + (await progress.getExp(healer.owner) ?? 0), 1,
      "a one-EXP squirrel must not create EXP when shared between two contributors");
    assert.equal(await progress.getExp(idle.owner), null);
    assert.equal((await quests.list(first.owner))[0]?.killCount, 1);
    assert.equal((await quests.list(healer.owner))[0]?.killCount, 1);
    assert.deepEqual(await quests.list(idle.owner), []);
    await healer.send(C.LeaveParty, undefined, S.PartyChanged);
    healer.session().skillCooldowns.clear(); await delay(160);
    assert.equal((await healer.send(C.UseSkill, { skillKey: "heal", targetSessionId: first.client.sessionId }, S.SkillDenied)).reason, "no-target");
  });
});
