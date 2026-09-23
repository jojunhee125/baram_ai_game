import { randomUUID } from "node:crypto";
import { ServerMessage, type TradeChanged, type TradeDenied, type TradeDenialReason, type TradeOffer } from "@zep-test/shared";
import { chebyshevDistance } from "../game/proximity";
import type { TradeStore } from "./contracts";
import { ITEM_DEFINITIONS, MAX_REQUEST_QUANTITY } from "./itemDefinitions";
import { boundedId, objectPayload, ownerIdentity, refreshEconomy, SocialBudget, type SocialActor, type SocialHost } from "./socialRuntime";

const itemsByKey = new Map(ITEM_DEFINITIONS.map((item) => [item.key, item]));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TradeParticipant {
  sessionId: string;
  ownerKey: string;
  nickname: string;
  offer: TradeOffer;
  confirmed: boolean;
}

interface Trade {
  id: string;
  revision: number;
  phase: TradeChanged["phase"];
  participants: [TradeParticipant, TradeParticipant];
  expiresAt: number;
  settlementPending: boolean;
  recoveryReason?: "storage-error";
}

function sanitizeOffer(value: unknown): TradeOffer | TradeDenialReason {
  if (!objectPayload(value) || typeof value.currency !== "number" || !Number.isSafeInteger(value.currency) ||
      value.currency < 0 || value.currency > 1_000_000_000 || !Array.isArray(value.items) || value.items.length > 6) return "invalid-offer";
  const keys = new Set<string>();
  const items: { itemKey: string; quantity: number }[] = [];
  for (const item of value.items) {
    if (!objectPayload(item) || typeof item.itemKey !== "string" || !itemsByKey.has(item.itemKey) ||
        keys.has(item.itemKey) || typeof item.quantity !== "number" || !Number.isSafeInteger(item.quantity) ||
        item.quantity < 1 || item.quantity > MAX_REQUEST_QUANTITY) return "invalid-offer";
    if (itemsByKey.get(item.itemKey)!.possession === true) return "restricted-item";
    keys.add(item.itemKey);
    items.push({ itemKey: item.itemKey, quantity: item.quantity });
  }
  items.sort((left, right) => left.itemKey < right.itemKey ? -1 : left.itemKey > right.itemKey ? 1 : 0);
  return { currency: value.currency, items };
}

export class TradeSystem {
  private readonly trades = new Map<string, Trade>();
  private readonly bySession = new Map<string, Trade>();
  private readonly byOwner = new Map<string, Trade>();
  private readonly budget = new SocialBudget();
  private disposed = false;

  constructor(private readonly host: SocialHost, private readonly store: TradeStore | null) {}

  join(sessionId: string): void {
    const actor = this.host.actor(sessionId);
    if (this.disposed || actor?.ownerKey == null || !UUID_PATTERN.test(actor.ownerKey)) return;
    const trade = this.byOwner.get(ownerIdentity(actor));
    if (trade?.phase !== "settling") return;
    const participant = trade.participants.find((member) => member.ownerKey === ownerIdentity(actor))!;
    if (this.host.actor(participant.sessionId) !== undefined) return;
    this.bySession.delete(participant.sessionId);
    participant.sessionId = sessionId;
    participant.nickname = actor.nickname;
    this.bySession.set(sessionId, trade);
    this.publish(trade);
  }

  private deny(sessionId: string, action: TradeDenied["action"], reason: TradeDenialReason, tradeId?: string): void {
    this.host.send(sessionId, ServerMessage.TradeDenied, { action, reason, ...(tradeId === undefined ? {} : { tradeId }) });
  }

  private allowed(sessionId: string, action: TradeDenied["action"], now: number): boolean {
    if (this.disposed || this.host.actor(sessionId) === undefined) return false;
    if (this.budget.take(sessionId, action, now)) return true;
    this.deny(sessionId, action, "rate-limited");
    return false;
  }

  request(sessionId: string, message: unknown, now: number): void {
    if (!this.allowed(sessionId, "request", now)) return;
    this.tick(now);
    if (!objectPayload(message) || !boundedId(message.targetSessionId)) return this.deny(sessionId, "request", "invalid-request");
    if (this.store === null) return this.deny(sessionId, "request", "unavailable");
    const actor = this.host.actor(sessionId)!;
    const target = this.host.actor(message.targetSessionId);
    if (target === undefined || actor.hp <= 0 || target.hp <= 0) return this.deny(sessionId, "request", "unavailable");
    if (actor.ownerKey === null || target.ownerKey === null || !UUID_PATTERN.test(actor.ownerKey) || !UUID_PATTERN.test(target.ownerKey)) {
      return this.deny(sessionId, "request", "auth-required");
    }
    if (ownerIdentity(actor) === ownerIdentity(target)) return this.deny(sessionId, "request", "same-owner");
    if (chebyshevDistance(actor, target) > 4) return this.deny(sessionId, "request", "out-of-range");
    if (this.byOwner.has(ownerIdentity(actor)) || this.byOwner.has(ownerIdentity(target))) return this.deny(sessionId, "request", "busy");
    const participant = (member: SocialActor): TradeParticipant => ({
      sessionId: member.sessionId, ownerKey: ownerIdentity(member), nickname: member.nickname,
      offer: { currency: 0, items: [] }, confirmed: false,
    });
    const trade: Trade = {
      id: randomUUID(), revision: 0, phase: "invited", participants: [participant(actor), participant(target)], expiresAt: now + 30_000,
      settlementPending: false,
    };
    this.trades.set(trade.id, trade);
    for (const member of trade.participants) {
      this.bySession.set(member.sessionId, trade);
      this.byOwner.set(member.ownerKey, trade);
    }
    this.publish(trade);
  }

  private find(sessionId: string, action: TradeDenied["action"], message: unknown, now: number, allowSettling = false): Trade | undefined {
    if (!this.allowed(sessionId, action, now)) return;
    if (!objectPayload(message) || !boundedId(message.tradeId)) {
      this.deny(sessionId, action, "invalid-request"); return;
    }
    const trade = this.bySession.get(sessionId);
    if (trade === undefined || trade.id !== message.tradeId) {
      this.deny(sessionId, action, "unavailable", message.tradeId); return;
    }
    if (trade.phase === "settling") {
      if (allowSettling) return trade;
      this.deny(sessionId, action, "settling", trade.id); return;
    }
    const reason = this.invalidState(trade, now);
    if (reason !== undefined) {
      this.finish(trade, "cancelled", reason); return;
    }
    return trade;
  }

  respond(sessionId: string, message: unknown, now: number): void {
    const trade = this.find(sessionId, "respond", message, now);
    if (trade === undefined) return;
    if (!objectPayload(message) || typeof message.accept !== "boolean" || trade.phase !== "invited" ||
        trade.participants[1].sessionId !== sessionId) return this.deny(sessionId, "respond", "invalid-request", trade.id);
    if (!message.accept) return this.finish(trade, "cancelled", "declined");
    trade.phase = "negotiating";
    trade.expiresAt = now + 120_000;
    this.publish(trade);
  }

  offer(sessionId: string, message: unknown, now: number): void {
    const trade = this.find(sessionId, "offer", message, now);
    if (trade === undefined) return;
    if (!objectPayload(message) || trade.phase !== "negotiating") return this.deny(sessionId, "offer", "invalid-request", trade.id);
    if (message.revision !== trade.revision) return this.deny(sessionId, "offer", "stale-revision", trade.id);
    const offer = sanitizeOffer(message.offer);
    if (typeof offer === "string") return this.deny(sessionId, "offer", offer, trade.id);
    trade.participants.find((member) => member.sessionId === sessionId)!.offer = offer;
    trade.revision += 1;
    for (const member of trade.participants) member.confirmed = false;
    this.publish(trade);
  }

  confirm(sessionId: string, message: unknown, now: number): void {
    const trade = this.find(sessionId, "confirm", message, now, true);
    if (trade === undefined) return;
    if (trade.phase === "settling") {
      if (!objectPayload(message) || message.revision !== trade.revision) return this.deny(sessionId, "confirm", "stale-revision", trade.id);
      if (trade.settlementPending) return this.deny(sessionId, "confirm", "settling", trade.id);
      trade.settlementPending = true;
      trade.recoveryReason = undefined;
      this.publish(trade);
      void this.settle(trade);
      return;
    }
    if (!objectPayload(message) || trade.phase !== "negotiating") return this.deny(sessionId, "confirm", "invalid-request", trade.id);
    if (message.revision !== trade.revision) return this.deny(sessionId, "confirm", "stale-revision", trade.id);
    trade.participants.find((member) => member.sessionId === sessionId)!.confirmed = true;
    if (!trade.participants.every((member) => member.confirmed)) { this.publish(trade); return; }
    trade.phase = "settling";
    trade.settlementPending = true;
    this.publish(trade);
    void this.settle(trade);
  }

  private async settle(trade: Trade): Promise<void> {
    const [first, second] = trade.participants;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const outcome = await this.store!.exchange({
          tradeId: trade.id,
          first: { ownerKey: first.ownerKey, offer: first.offer },
          second: { ownerKey: second.ownerKey, offer: second.offer },
        });
        if (outcome.ok) {
          await refreshEconomy([first.ownerKey, second.ownerKey], "trade");
          this.finish(trade, "completed");
        } else this.finish(trade, "cancelled", outcome.reason);
        return;
      } catch (cause) { failure = cause; }
    }
    // A lost COMMIT response cannot establish cancellation. Keep the exact request reserved
    // until one participant retries this same ledger key and learns its committed outcome.
    trade.settlementPending = false;
    trade.recoveryReason = "storage-error";
    console.warn(`[zep-test] trade ${trade.id} awaits settlement recovery`, failure);
    this.publish(trade, "storage-error");
  }

  cancel(sessionId: string, message: unknown, now: number): void {
    const trade = this.find(sessionId, "cancel", message, now);
    if (trade !== undefined) this.finish(trade, "cancelled", "cancelled");
  }

  private invalidState(trade: Trade, now: number): TradeDenialReason | "disconnected" | undefined {
    if (now >= trade.expiresAt) return "expired";
    const first = this.host.actor(trade.participants[0].sessionId);
    const second = this.host.actor(trade.participants[1].sessionId);
    if (first === undefined || second === undefined) return "disconnected";
    if (first.hp <= 0 || second.hp <= 0) return "unavailable";
    if (chebyshevDistance(first, second) > 4) return "out-of-range";
    return undefined;
  }

  moved(sessionId: string, now: number): void {
    const trade = this.bySession.get(sessionId);
    if (trade === undefined || trade.phase === "settling") return;
    const reason = this.invalidState(trade, now);
    if (reason !== undefined) this.finish(trade, "cancelled", reason);
  }

  remove(sessionId: string): void {
    this.budget.remove(sessionId);
    const trade = this.bySession.get(sessionId);
    if (trade !== undefined && trade.phase !== "settling") this.finish(trade, "cancelled", "disconnected");
  }

  private publish(trade: Trade, reason: TradeChanged["reason"] = trade.recoveryReason): void {
    if (this.disposed) return;
    const payload: TradeChanged = {
      tradeId: trade.id, revision: trade.revision, phase: trade.phase,
      initiatorSessionId: trade.participants[0].sessionId, expiresAt: trade.expiresAt,
      participants: trade.participants.map(({ sessionId, nickname, offer, confirmed }) => ({
        sessionId, nickname, confirmed,
        offer: { currency: offer.currency, items: offer.items.map((item) => ({ ...item, name: itemsByKey.get(item.itemKey)!.name })) },
      })),
      ...(reason === undefined ? {} : { reason }),
    };
    for (const member of trade.participants) this.host.send(member.sessionId, ServerMessage.TradeChanged, payload);
  }

  private finish(trade: Trade, phase: "completed" | "cancelled", reason?: TradeChanged["reason"]): void {
    trade.phase = phase;
    trade.recoveryReason = undefined;
    this.publish(trade, reason);
    this.trades.delete(trade.id);
    for (const member of trade.participants) {
      if (this.bySession.get(member.sessionId) === trade) this.bySession.delete(member.sessionId);
      if (this.byOwner.get(member.ownerKey) === trade) this.byOwner.delete(member.ownerKey);
    }
  }

  tick(now: number): void {
    for (const trade of this.trades.values()) {
      if (trade.phase === "settling") continue;
      const reason = this.invalidState(trade, now);
      if (reason !== undefined) this.finish(trade, "cancelled", reason);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.trades.clear(); this.bySession.clear(); this.byOwner.clear(); this.budget.clear();
  }
}
