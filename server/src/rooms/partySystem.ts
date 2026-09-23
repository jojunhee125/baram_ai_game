import { randomUUID } from "node:crypto";
import { ServerMessage, type PartyDenied, type PartyMemberView, type PartyView } from "@zep-test/shared";
import { boundedId, objectPayload, ownerIdentity, SocialBudget, type SocialHost } from "./socialRuntime";

interface Party {
  id: string;
  leader: string;
  members: Set<string>;
  lastView: string;
}

interface Invite {
  id: string;
  partyId: string;
  inviter: string;
  target: string;
  expiresAt: number;
}

export class PartySystem {
  private readonly parties = new Map<string, Party>();
  private readonly membership = new Map<string, string>();
  private readonly invites = new Map<string, Invite>();
  private readonly budget = new SocialBudget();
  private nextVitalsAt = 0;

  constructor(private readonly host: SocialHost, private readonly onLeaveParty: (sessionId: string) => void) {}

  partyId(sessionId: string): string | undefined { return this.membership.get(sessionId); }

  sameParty(first: string, second: string): boolean {
    const id = this.partyId(first);
    return id !== undefined && id === this.partyId(second);
  }

  private deny(sessionId: string, action: PartyDenied["action"], reason: PartyDenied["reason"]): void {
    this.host.send(sessionId, ServerMessage.PartyDenied, { action, reason });
  }

  private allowed(sessionId: string, action: PartyDenied["action"], now: number): boolean {
    if (this.host.actor(sessionId) === undefined) return false;
    if (this.budget.take(sessionId, action, now)) return true;
    this.deny(sessionId, action, "rate-limited");
    return false;
  }

  create(sessionId: string, now: number): void {
    if (!this.allowed(sessionId, "create", now)) return;
    if (this.membership.has(sessionId)) return this.deny(sessionId, "create", "already-in-party");
    const party: Party = { id: randomUUID(), leader: sessionId, members: new Set([sessionId]), lastView: "" };
    this.parties.set(party.id, party);
    this.membership.set(sessionId, party.id);
    this.removeInvitesFor(sessionId);
    this.publish(party);
  }

  invite(sessionId: string, message: unknown, now: number): void {
    if (!this.allowed(sessionId, "invite", now)) return;
    this.expire(now);
    if (!objectPayload(message) || !boundedId(message.targetSessionId)) return this.deny(sessionId, "invite", "invalid-request");
    const party = this.parties.get(this.membership.get(sessionId) ?? "");
    if (party === undefined) return this.deny(sessionId, "invite", "not-in-party");
    if (party.leader !== sessionId) return this.deny(sessionId, "invite", "not-leader");
    const actor = this.host.actor(sessionId)!;
    const target = this.host.actor(message.targetSessionId);
    if (target === undefined || target.hp <= 0) return this.deny(sessionId, "invite", "unavailable");
    if (this.membership.has(target.sessionId)) return this.deny(sessionId, "invite", "already-in-party");
    if ([...party.members].some((id) => {
      const member = this.host.actor(id);
      return member !== undefined && ownerIdentity(member) === ownerIdentity(target);
    })) return this.deny(sessionId, "invite", "same-owner");
    if ([...this.invites.values()].some((invite) => invite.target === target.sessionId)) return this.deny(sessionId, "invite", "unavailable");
    if (party.members.size + [...this.invites.values()].filter((invite) => invite.partyId === party.id).length >= 4) {
      return this.deny(sessionId, "invite", "party-full");
    }
    const invite: Invite = { id: randomUUID(), partyId: party.id, inviter: sessionId, target: target.sessionId, expiresAt: now + 30_000 };
    this.invites.set(invite.id, invite);
    this.host.send(target.sessionId, ServerMessage.PartyInvited, {
      inviteId: invite.id, partyId: party.id, inviterSessionId: sessionId, inviterNickname: actor.nickname, expiresAt: invite.expiresAt,
    });
    this.publish(party);
  }

  respond(sessionId: string, message: unknown, now: number): void {
    if (!this.allowed(sessionId, "respond", now)) return;
    if (!objectPayload(message) || !boundedId(message.inviteId) || typeof message.accept !== "boolean") {
      return this.deny(sessionId, "respond", "invalid-request");
    }
    const invite = this.invites.get(message.inviteId);
    if (invite === undefined || invite.target !== sessionId) return this.deny(sessionId, "respond", "expired");
    this.invites.delete(invite.id);
    if (now >= invite.expiresAt) return this.deny(sessionId, "respond", "expired");
    const party = this.parties.get(invite.partyId);
    if (party === undefined || party.leader !== invite.inviter) return this.deny(sessionId, "respond", "unavailable");
    if (!message.accept) {
      this.host.send(sessionId, ServerMessage.PartyChanged, { party: null });
      this.publish(party);
      return;
    }
    if (this.membership.has(sessionId)) return this.deny(sessionId, "respond", "already-in-party");
    if (party.members.size >= 4) return this.deny(sessionId, "respond", "party-full");
    const actor = this.host.actor(sessionId)!;
    if ([...party.members].some((id) => {
      const member = this.host.actor(id);
      return member !== undefined && ownerIdentity(member) === ownerIdentity(actor);
    })) return this.deny(sessionId, "respond", "same-owner");
    party.members.add(sessionId);
    this.membership.set(sessionId, party.id);
    this.publish(party);
  }

  leave(sessionId: string, now: number): void {
    if (!this.allowed(sessionId, "leave", now)) return;
    if (!this.membership.has(sessionId)) return this.deny(sessionId, "leave", "not-in-party");
    this.remove(sessionId);
  }

  remove(sessionId: string): void {
    this.budget.remove(sessionId);
    this.removeInvitesFor(sessionId);
    const id = this.membership.get(sessionId);
    const party = id === undefined ? undefined : this.parties.get(id);
    this.membership.delete(sessionId);
    this.onLeaveParty(sessionId);
    if (party === undefined) return;
    party.members.delete(sessionId);
    this.host.send(sessionId, ServerMessage.PartyChanged, { party: null });
    if (party.members.size === 0) this.parties.delete(party.id);
    else {
      if (party.leader === sessionId) party.leader = party.members.values().next().value!;
      this.publish(party);
    }
  }

  private removeInvitesFor(sessionId: string): void {
    for (const [id, invite] of this.invites) {
      if (invite.inviter === sessionId || invite.target === sessionId) this.invites.delete(id);
    }
  }

  private expire(now: number): void {
    for (const [id, invite] of this.invites) if (now >= invite.expiresAt) this.invites.delete(id);
  }

  private view(party: Party): PartyView {
    const members: PartyMemberView[] = [];
    for (const id of party.members) {
      const actor = this.host.actor(id);
      if (actor !== undefined) {
        const { sessionId, nickname, playerClass, hp, maxHp, mp, maxMp, level } = actor;
        members.push({ sessionId, nickname, playerClass, hp, maxHp, mp, maxMp, level });
      }
    }
    return { partyId: party.id, leaderSessionId: party.leader, members };
  }

  private publish(party: Party, view = this.view(party)): void {
    party.lastView = JSON.stringify(view);
    for (const id of party.members) this.host.send(id, ServerMessage.PartyChanged, { party: view });
  }

  tick(now: number): void {
    this.expire(now);
    if (now < this.nextVitalsAt) return;
    this.nextVitalsAt = now + 250;
    for (const party of this.parties.values()) {
      const view = this.view(party);
      if (JSON.stringify(view) !== party.lastView) this.publish(party, view);
    }
  }

  dispose(): void {
    this.parties.clear(); this.membership.clear(); this.invites.clear(); this.budget.clear();
  }
}
