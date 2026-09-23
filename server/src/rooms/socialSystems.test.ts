import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { ServerMessage, type CraftResult, type PartyChanged, type PartyInvited, type TradeChanged, type TradeDenied } from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../db/currencyStore";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { InMemorySettlementStore } from "../db/settlementStore";
import { InMemoryTradeStore } from "../db/tradeStore";
import type { AtomicTradeOutcome, AtomicTradeRequest } from "./contracts";
import { CraftingSystem } from "./craftingSystem";
import { PartyRewards, splitPartyExp } from "./partyRewards";
import { PartySystem } from "./partySystem";
import { subscribeEconomy, type SocialActor, type SocialHost } from "./socialRuntime";
import { TradeSystem } from "./tradeSystem";

function fixture(count = 6) {
  const actors = new Map<string, SocialActor>();
  for (let index = 1; index <= count; index += 1) {
    const sessionId = `s${index}`;
    actors.set(sessionId, {
      sessionId, ownerKey: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      nickname: `플레이어${index}`, playerClass: null, hp: 100, maxHp: 100, mp: 50, maxMp: 50,
      level: 1, tileX: 10, tileY: 10,
    });
  }
  const sent: { sessionId: string; type: string; payload: unknown }[] = [];
  const host: SocialHost = {
    actor: (id) => actors.get(id),
    send: (sessionId, type, payload) => { if (actors.has(sessionId)) sent.push({ sessionId, type, payload }); },
  };
  function messages<T>(sessionId: string, type: string): T[] {
    return sent.filter((message) => message.sessionId === sessionId && message.type === type).map((message) => message.payload as T);
  }
  function latest<T>(sessionId: string, type: string): T {
    const result = messages<T>(sessionId, type).at(-1);
    assert.ok(result, `${sessionId} expected ${type}`);
    return result;
  }
  let rewards: PartyRewards;
  const party = new PartySystem(host, (id) => rewards.remove(id));
  rewards = new PartyRewards(host, party);
  function joinParty(member: string, now = 10_000) {
    party.invite("s1", { targetSessionId: member }, now);
    const invite = latest<PartyInvited>(member, ServerMessage.PartyInvited);
    party.respond(member, { inviteId: invite.inviteId, accept: true }, now);
  }
  return { actors, host, sent, latest, messages, party, rewards, joinParty };
}

const flush = async () => { for (let count = 0; count < 8; count += 1) await new Promise((resolve) => setImmediate(resolve)); };

describe("party lifecycle and private snapshots", () => {
  it("caps members and pending invitations, validates responders, and transfers leadership", () => {
    const f = fixture();
    f.party.create("s1", 1000);
    f.joinParty("s2", 2000);
    f.party.invite("s1", { targetSessionId: "s3" }, 3000);
    const invite = f.latest<PartyInvited>("s3", ServerMessage.PartyInvited);
    f.party.respond("s4", { inviteId: invite.inviteId, accept: true }, 3000);
    assert.equal(f.party.partyId("s4"), undefined);
    f.party.invite("s1", { targetSessionId: "s4" }, 4000);
    f.party.invite("s1", { targetSessionId: "s5" }, 5000);
    assert.deepEqual(f.latest("s1", ServerMessage.PartyDenied), { action: "invite", reason: "party-full" });
    f.party.respond("s3", { inviteId: invite.inviteId, accept: true }, 5000);
    const fourth = f.latest<PartyInvited>("s4", ServerMessage.PartyInvited);
    f.party.respond("s4", { inviteId: fourth.inviteId, accept: true }, 5000);
    assert.equal(f.latest<PartyChanged>("s1", ServerMessage.PartyChanged).party!.members.length, 4);
    f.party.remove("s1");
    assert.equal(f.latest<PartyChanged>("s2", ServerMessage.PartyChanged).party!.leaderSessionId, "s2");
    assert.equal(f.party.partyId("s1"), undefined);
    assert.equal(f.messages("s5", ServerMessage.PartyChanged).length, 0);
  });

  it("prevents duplicate account seats and publishes changing vitals only to members at 250ms", () => {
    const f = fixture();
    f.actors.get("s3")!.ownerKey = f.actors.get("s1")!.ownerKey;
    f.party.create("s1", 1000);
    f.joinParty("s2", 2000);
    f.party.invite("s1", { targetSessionId: "s3" }, 3000);
    assert.deepEqual(f.latest("s1", ServerMessage.PartyDenied), { action: "invite", reason: "same-owner" });
    f.party.tick(4000);
    f.sent.length = 0;
    f.actors.get("s1")!.hp = 50;
    f.party.tick(4100);
    assert.equal(f.sent.length, 0);
    f.party.tick(4250);
    assert.equal(f.latest<PartyChanged>("s2", ServerMessage.PartyChanged).party!.members[0]!.hp, 50);
    assert.equal(f.messages("s3", ServerMessage.PartyChanged).length, 0);
    assert.equal("ownerKey" in f.latest<PartyChanged>("s1", ServerMessage.PartyChanged).party!.members[0]!, false);
  });

  it("expires invitations and invalidates them when the leader leaves", () => {
    const f = fixture();
    f.party.create("s1", 1000);
    f.party.invite("s1", { targetSessionId: "s2" }, 2000);
    const invite = f.latest<PartyInvited>("s2", ServerMessage.PartyInvited);
    f.party.respond("s2", { inviteId: invite.inviteId, accept: true }, 32_000);
    assert.equal(f.party.partyId("s2"), undefined);
    f.party.invite("s1", { targetSessionId: "s2" }, 33_000);
    const next = f.latest<PartyInvited>("s2", ServerMessage.PartyInvited);
    f.party.remove("s1");
    f.party.respond("s2", { inviteId: next.inviteId, accept: true }, 34_000);
    assert.equal(f.party.partyId("s2"), undefined);
  });
});

describe("party contribution rewards", () => {
  it("credits actual damage and heals of active damage contributors, conserves EXP, consumes once", () => {
    const f = fixture();
    f.party.create("s1", 1000); f.joinParty("s2", 2000); f.joinParty("s3", 3000);
    f.rewards.damage("boss", "s1", 4, 10_000);
    f.rewards.heal("s2", "s1", 20, 10_100);
    f.rewards.damage("boss", "s3", 1, 10_200);
    const winners = f.rewards.consume("boss", f.actors.get("s3")!, { tileX: 10, tileY: 10 }, 10_200);
    assert.deepEqual(winners.map((actor) => actor.sessionId), ["s1", "s2", "s3"]);
    assert.deepEqual(splitPartyExp(8, winners.length), [3, 3, 2]);
    assert.deepEqual(f.rewards.consume("boss", f.actors.get("s3")!, { tileX: 10, tileY: 10 }, 10_200), []);
    f.rewards.reset("boss");
    assert.equal(f.rewards.consume("boss", f.actors.get("s3")!, f.actors.get("s3")!, 11_000).length, 1);
  });

  it("excludes zero heals, idle, dead, distant, stale and departed contributors", () => {
    const f = fixture();
    f.party.create("s1", 1000); f.joinParty("s2", 2000); f.joinParty("s3", 3000); f.joinParty("s4", 4000);
    f.rewards.damage("boss", "s1", 4, 10_000);
    f.rewards.heal("s2", "s1", 0, 10_100);
    f.rewards.damage("boss", "s3", 4, 10_000);
    f.actors.get("s3")!.tileX = 30;
    const first = f.rewards.consume("boss", f.actors.get("s4")!, { tileX: 10, tileY: 10 }, 26_000);
    assert.deepEqual(first.map((actor) => actor.sessionId), ["s4"]);
    f.rewards.reset("boss");
    f.rewards.damage("boss", "s1", 1, 30_000);
    f.rewards.damage("boss", "s2", 1, 30_000);
    f.actors.get("s2")!.hp = 0;
    f.party.leave("s1", 30_001);
    assert.deepEqual(f.rewards.consume("boss", f.actors.get("s4")!, { tileX: 10, tileY: 10 }, 30_002).map((actor) => actor.sessionId), ["s4"]);
  });

  it("does not renew an old damage encounter indefinitely by self-healing", () => {
    const f = fixture();
    f.party.create("s1", 1000); f.joinParty("s2", 2000); f.joinParty("s3", 3000);
    f.rewards.damage("boss", "s1", 1, 10_000);
    f.rewards.heal("s1", "s1", 10, 24_000);
    f.rewards.heal("s2", "s1", 10, 26_000);
    assert.deepEqual(f.rewards.consume("boss", f.actors.get("s3")!, f.actors.get("s3")!, 26_001).map((actor) => actor.sessionId), ["s1", "s3"]);
  });
});

describe("trade negotiation", () => {
  function negotiate(f: ReturnType<typeof fixture>, trade: TradeSystem) {
    trade.request("s1", { targetSessionId: "s2" }, 1000);
    const id = f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).tradeId;
    trade.respond("s2", { tradeId: id, accept: true }, 1000);
    return id;
  }

  it("requires each current revision, clears both confirmations, and sanitizes item names", async () => {
    const f = fixture();
    const calls: AtomicTradeRequest[] = [];
    let resolve!: (outcome: AtomicTradeOutcome) => void;
    const trade = new TradeSystem(f.host, { exchange: (request) => { calls.push(request); return new Promise((done) => { resolve = done; }); } });
    const id = negotiate(f, trade);
    trade.offer("s1", { tradeId: id, revision: 0, offer: { currency: 1, items: [{ itemKey: "acorn", quantity: 1, name: "fake" }] } }, 2000);
    trade.confirm("s1", { tradeId: id, revision: 1 }, 2000);
    trade.offer("s2", { tradeId: id, revision: 1, offer: { currency: 2, items: [] } }, 2000);
    assert.ok(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).participants.every((member) => !member.confirmed));
    assert.notEqual(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).participants[0]!.offer.items[0]!.name, "fake");
    trade.confirm("s1", { tradeId: id, revision: 1 }, 3000);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "stale-revision");
    trade.confirm("s1", { tradeId: id, revision: 2 }, 4000);
    trade.confirm("s2", { tradeId: id, revision: 2 }, 4000);
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).phase, "settling");
    trade.cancel("s1", { tradeId: id }, 4100);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "settling");
    trade.remove("s2"); f.actors.delete("s2");
    trade.confirm("s1", { tradeId: id, revision: 2 }, 5000);
    assert.equal(calls.length, 1);
    assert.equal("name" in calls[0]!.first.offer.items[0]!, false);
    resolve({ ok: true, participants: [] }); await flush();
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).phase, "completed");
  });

  it("rejects unauthenticated/self-owner/invalid offers and cancels movement, expiry, disconnect", () => {
    const f = fixture();
    const trade = new TradeSystem(f.host, { exchange: async () => { throw new Error("must not settle"); } });
    f.actors.get("s2")!.ownerKey = null;
    trade.request("s1", { targetSessionId: "s2" }, 1000);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "auth-required");
    f.actors.get("s2")!.ownerKey = f.actors.get("s1")!.ownerKey;
    trade.request("s1", { targetSessionId: "s2" }, 2000);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "same-owner");
    f.actors.get("s2")!.ownerKey = randomUUID();
    trade.request("s1", { targetSessionId: "s2" }, 3000);
    const id = f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).tradeId;
    trade.respond("s2", { tradeId: id, accept: true }, 3000);
    trade.offer("s1", { tradeId: id, revision: 0, offer: { currency: 0, items: [{ itemKey: "entry-pass", quantity: 1 }] } }, 3000);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "restricted-item");
    f.actors.get("s2")!.tileX = 15; trade.moved("s2", 4000);
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).reason, "out-of-range");
    f.actors.get("s2")!.tileX = 10;
    trade.request("s1", { targetSessionId: "s2" }, 5000); trade.tick(35_000);
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).reason, "expired");
    trade.request("s1", { targetSessionId: "s2" }, 36_000); trade.remove("s2");
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).reason, "disconnected");
  });

  it("refreshes all current account subscribers after an actual trade", async () => {
    const f = fixture();
    const currency = new InMemoryCurrencyStore(); const inventory = new InMemoryInventoryStore();
    await currency.credit(f.actors.get("s1")!.ownerKey!, 10);
    const trade = new TradeSystem(f.host, new InMemoryTradeStore(currency, inventory));
    const refreshed: string[] = [];
    const unsubscribe = [
      subscribeEconomy(f.actors.get("s1")!.ownerKey!, async (reason) => { refreshed.push(`first:${reason}`); }),
      subscribeEconomy(f.actors.get("s1")!.ownerKey!, async (reason) => { refreshed.push(`other-room:${reason}`); }),
      subscribeEconomy(f.actors.get("s2")!.ownerKey!, async (reason) => { refreshed.push(`second:${reason}`); }),
    ];
    try {
      const id = negotiate(f, trade);
      trade.offer("s1", { tradeId: id, revision: 0, offer: { currency: 5, items: [] } }, 2000);
      trade.confirm("s1", { tradeId: id, revision: 1 }, 2000);
      trade.confirm("s2", { tradeId: id, revision: 1 }, 2000);
      await flush();
      assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).phase, "completed");
      assert.deepEqual(refreshed.sort(), ["first:trade", "other-room:trade", "second:trade"]);
    } finally { unsubscribe.forEach((stop) => stop()); }
  });

  it("recovers a committed exchange with a lost response using the original ledger key", async () => {
    const f = fixture();
    const currency = new InMemoryCurrencyStore(); const inventory = new InMemoryInventoryStore();
    const owner = f.actors.get("s1")!.ownerKey!;
    await currency.credit(owner, 10);
    const backing = new InMemoryTradeStore(currency, inventory);
    const keys: string[] = [];
    const trade = new TradeSystem(f.host, { exchange: async (request) => {
      keys.push(request.tradeId);
      const outcome = await backing.exchange(request);
      if (keys.length === 1) throw new Error("COMMIT response lost");
      return outcome;
    } });
    const id = negotiate(f, trade);
    trade.offer("s1", { tradeId: id, revision: 0, offer: { currency: 5, items: [] } }, 2000);
    trade.confirm("s1", { tradeId: id, revision: 1 }, 2000);
    trade.confirm("s2", { tradeId: id, revision: 1 }, 2000);
    await flush();
    assert.deepEqual(keys, [id, id]);
    assert.equal(await currency.getBalance(owner), 5);
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).phase, "completed");
    assert.equal(f.messages<TradeChanged>("s1", ServerMessage.TradeChanged).some((view) => view.phase === "cancelled"), false);
  });

  it("rebinds a disconnected settling participant to the same authenticated owner only", async () => {
    const f = fixture();
    const keys: string[] = [];
    let available = false;
    const trade = new TradeSystem(f.host, { exchange: async (request) => {
      keys.push(request.tradeId);
      if (!available) throw new Error("connection unavailable");
      return { ok: true, participants: [] };
    } });
    const id = negotiate(f, trade);
    trade.offer("s1", { tradeId: id, revision: 0, offer: { currency: 1, items: [] } }, 2000);
    trade.confirm("s1", { tradeId: id, revision: 1 }, 2000);
    trade.confirm("s2", { tradeId: id, revision: 1 }, 2000);
    await flush();
    f.actors.get("s4")!.ownerKey = f.actors.get("s1")!.ownerKey;
    trade.join("s4");
    assert.equal(f.messages("s4", ServerMessage.TradeChanged).length, 0);
    trade.remove("s1"); f.actors.delete("s1");
    trade.join("s3");
    assert.equal(f.messages("s3", ServerMessage.TradeChanged).length, 0);
    trade.join("s4");
    const resumed = f.latest<TradeChanged>("s4", ServerMessage.TradeChanged);
    assert.equal(resumed.tradeId, id);
    assert.equal(resumed.phase, "settling"); assert.equal(resumed.reason, "storage-error");
    assert.equal(resumed.participants[0]!.sessionId, "s4");
    assert.equal(resumed.participants[0]!.offer.currency, 1);
    available = true;
    trade.confirm("s4", { tradeId: id, revision: 1 }, 3000);
    await flush();
    assert.deepEqual(keys, [id, id, id, id]);
    assert.equal(f.latest<TradeChanged>("s4", ServerMessage.TradeChanged).phase, "completed");
  });

  it("retains an uncertain trade and permits only a single same-ID recovery while settling", async () => {
    const f = fixture();
    const keys: string[] = [];
    let available = false;
    let resolve!: (result: AtomicTradeOutcome) => void;
    const trade = new TradeSystem(f.host, { exchange: async (request) => {
      keys.push(request.tradeId);
      if (!available) throw new Error("connection unavailable");
      return new Promise((done) => { resolve = done; });
    } });
    const id = negotiate(f, trade);
    trade.offer("s1", { tradeId: id, revision: 0, offer: { currency: 1, items: [] } }, 2000);
    trade.confirm("s1", { tradeId: id, revision: 1 }, 2000);
    trade.confirm("s2", { tradeId: id, revision: 1 }, 2000);
    await flush();
    const uncertain = f.latest<TradeChanged>("s1", ServerMessage.TradeChanged);
    assert.equal(uncertain.phase, "settling"); assert.equal(uncertain.reason, "storage-error");
    trade.cancel("s1", { tradeId: id }, 3000);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "settling");
    trade.request("s1", { targetSessionId: "s3" }, 3000);
    assert.equal(f.latest<TradeDenied>("s1", ServerMessage.TradeDenied).reason, "busy");
    available = true;
    trade.confirm("s1", { tradeId: id, revision: 1 }, 3000);
    trade.confirm("s2", { tradeId: id, revision: 1 }, 3000);
    assert.deepEqual(keys, [id, id, id, id]);
    resolve({ ok: true, participants: [] }); await flush();
    assert.equal(f.latest<TradeChanged>("s1", ServerMessage.TradeChanged).phase, "completed");
  });
});

describe("crafting settlement", () => {
  it("consumes the authored materials/currency atomically and replays a nonce without duplicate output", async () => {
    const f = fixture(); const owner = f.actors.get("s1")!.ownerKey!;
    const currency = new InMemoryCurrencyStore(); const inventory = new InMemoryInventoryStore();
    await currency.credit(owner, 100); await inventory.add(owner, "padded-armor", 1); await inventory.add(owner, "bear-hide", 3);
    const craft = new CraftingSystem(f.host, new InMemorySettlementStore(currency, inventory));
    const nonce = randomUUID();
    craft.join("s1");
    craft.craft("s1", { recipeId: "reinforced-armor", nonce }, 1000); await flush();
    assert.equal(f.latest<CraftResult>("s1", ServerMessage.CraftResult).ok, true);
    assert.equal(await currency.getBalance(owner), 70);
    assert.deepEqual(await inventory.list(owner), [{ itemKey: "reinforced-armor", quantity: 1, equipped: false }]);
    craft.craft("s1", { recipeId: "reinforced-armor", nonce }, 2000); await flush();
    assert.equal(f.latest<CraftResult>("s1", ServerMessage.CraftResult).ok, true);
    assert.equal(await currency.getBalance(owner), 70);
    craft.craft("s1", { recipeId: "reinforced-armor", nonce: randomUUID() }, 3000); await flush();
    assert.equal(f.latest<CraftResult>("s1", ServerMessage.CraftResult).reason, "insufficient-item");
    assert.equal(await currency.getBalance(owner), 70);
  });

  it("rejects invalid nonce, guest, unknown recipe and equipped ingredient without asset loss", async () => {
    const f = fixture(); const owner = f.actors.get("s1")!.ownerKey!;
    const currency = new InMemoryCurrencyStore(); const inventory = new InMemoryInventoryStore();
    await currency.credit(owner, 100); await inventory.add(owner, "padded-armor", 1); await inventory.add(owner, "bear-hide", 3);
    await inventory.equip(owner, "padded-armor", "armor");
    const craft = new CraftingSystem(f.host, new InMemorySettlementStore(currency, inventory));
    craft.craft("s1", { recipeId: "reinforced-armor", nonce: "invalid" }, 1000);
    assert.equal(f.latest<CraftResult>("s1", ServerMessage.CraftResult).reason, "invalid-request");
    craft.craft("s1", { recipeId: "unknown", nonce: randomUUID() }, 2000);
    assert.equal(f.latest<CraftResult>("s1", ServerMessage.CraftResult).reason, "unknown-recipe");
    f.actors.get("s2")!.ownerKey = null;
    craft.craft("s2", { recipeId: "reinforced-armor", nonce: randomUUID() }, 2000);
    assert.equal(f.latest<CraftResult>("s2", ServerMessage.CraftResult).reason, "auth-required");
    craft.craft("s1", { recipeId: "reinforced-armor", nonce: randomUUID() }, 3000); await flush();
    assert.equal(f.latest<CraftResult>("s1", ServerMessage.CraftResult).reason, "equipped-item");
    assert.equal(await currency.getBalance(owner), 100);
    assert.equal(inventory.peekBag(owner).get("bear-hide"), 3);
  });
});
