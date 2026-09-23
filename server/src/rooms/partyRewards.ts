import type { TilePosition } from "@zep-test/shared";
import { chebyshevDistance } from "../game/proximity";
import type { PartySystem } from "./partySystem";
import { ownerIdentity, type SocialActor, type SocialHost } from "./socialRuntime";

interface Contribution {
  sessionId: string;
  partyId: string;
  at: number;
  damageAt: number | null;
}

export class PartyRewards {
  private readonly encounters = new Map<string, Map<string, Contribution>>();
  private readonly consumed = new Set<string>();

  constructor(private readonly host: SocialHost, private readonly party: PartySystem) {}

  damage(monsterId: string, sessionId: string, amount: number, now: number): void {
    const actor = this.host.actor(sessionId);
    const partyId = this.party.partyId(sessionId);
    if (actor === undefined || actor.hp <= 0 || partyId === undefined || amount <= 0) return;
    const entries = this.encounters.get(monsterId) ?? new Map<string, Contribution>();
    entries.set(ownerIdentity(actor), { sessionId, partyId, at: now, damageAt: now });
    this.encounters.set(monsterId, entries);
  }

  heal(healerId: string, targetId: string, amount: number, now: number): void {
    if (amount <= 0 || !this.party.sameParty(healerId, targetId)) return;
    const healer = this.host.actor(healerId);
    const target = this.host.actor(targetId);
    if (healer === undefined || target === undefined || healer.hp <= 0 || target.hp <= 0) return;
    const partyId = this.party.partyId(healerId)!;
    for (const entries of this.encounters.values()) {
      const contribution = entries.get(ownerIdentity(target));
      if (contribution?.damageAt == null || contribution.sessionId !== targetId ||
          contribution.partyId !== partyId || now - contribution.damageAt > 15_000) continue;
      const previous = entries.get(ownerIdentity(healer));
      entries.set(ownerIdentity(healer), { sessionId: healerId, partyId, at: now, damageAt: previous?.damageAt ?? null });
    }
  }

  consume(monsterId: string, finisher: SocialActor, position: TilePosition, now: number): readonly SocialActor[] {
    if (this.consumed.has(monsterId)) return [];
    this.consumed.add(monsterId);
    const entries = this.encounters.get(monsterId);
    this.encounters.delete(monsterId);
    const partyId = this.party.partyId(finisher.sessionId);
    const eligible = new Map<string, SocialActor>([[ownerIdentity(finisher), finisher]]);
    if (partyId !== undefined) {
      for (const [ownerKey, entry] of entries ?? []) {
        const actor = this.host.actor(entry.sessionId);
        if (actor === undefined || actor.hp <= 0 || ownerIdentity(actor) !== ownerKey || entry.partyId !== partyId ||
            this.party.partyId(actor.sessionId) !== partyId || now - entry.at > 15_000 ||
            chebyshevDistance(actor, position) > 12) continue;
        eligible.set(ownerKey, actor);
      }
    }
    return [...eligible].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, actor]) => actor);
  }

  remove(sessionId: string): void {
    for (const entries of this.encounters.values()) {
      for (const [owner, entry] of entries) if (entry.sessionId === sessionId) entries.delete(owner);
    }
  }

  reset(monsterId: string): void { this.encounters.delete(monsterId); this.consumed.delete(monsterId); }
  clear(): void { this.encounters.clear(); this.consumed.clear(); }
}

export function splitPartyExp(total: number, count: number): readonly number[] {
  if (count === 0) return [];
  const share = Math.floor(total / count);
  return Array.from({ length: count }, (_, index) => share + (index < total % count ? 1 : 0));
}
