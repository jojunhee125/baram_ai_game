import type { PartyMemberView, ServerMessagePayload, TilePosition } from "@zep-test/shared";

export interface SocialActor extends PartyMemberView, TilePosition {
  ownerKey: string | null;
}

export interface SocialHost {
  actor(sessionId: string): SocialActor | undefined;
  send<T extends keyof ServerMessagePayload>(sessionId: string, type: T, payload: ServerMessagePayload[T]): void;
}

export function objectPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

export function ownerIdentity(actor: SocialActor): string {
  return actor.ownerKey?.toLowerCase() ?? actor.sessionId;
}

export class SocialBudget {
  private readonly deadlines = new Map<string, Map<string, number>>();

  take(sessionId: string, action: string, now: number): boolean {
    const actions = this.deadlines.get(sessionId) ?? new Map<string, number>();
    if ((actions.get(action) ?? 0) > now) return false;
    actions.set(action, now + 250);
    this.deadlines.set(sessionId, actions);
    return true;
  }

  remove(sessionId: string): void { this.deadlines.delete(sessionId); }
  clear(): void { this.deadlines.clear(); }
}

type EconomyRefresh = (reason: "trade" | "craft") => Promise<void>;
const economySubscribers = new Map<string, Set<EconomyRefresh>>();

export function subscribeEconomy(ownerKey: string, refresh: EconomyRefresh): () => void {
  const key = ownerKey.toLowerCase();
  const subscribers = economySubscribers.get(key) ?? new Set<EconomyRefresh>();
  subscribers.add(refresh);
  economySubscribers.set(key, subscribers);
  return () => {
    subscribers.delete(refresh);
    if (subscribers.size === 0) economySubscribers.delete(key);
  };
}

export async function refreshEconomy(ownerKeys: readonly string[], reason: "trade" | "craft"): Promise<void> {
  await Promise.all([...new Set(ownerKeys.map((key) => key.toLowerCase()))].flatMap((key) =>
    [...(economySubscribers.get(key) ?? [])].map(async (refresh) => {
      try { await refresh(reason); }
      catch (cause) { console.warn(`[zep-test] could not refresh ${reason} balance for ${key}`, cause); }
    })));
}
