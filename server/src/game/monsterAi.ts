import { Direction, type TilePosition } from "@zep-test/shared";
import type { MonsterType } from "../rooms/monsterDefinitions";
import { STEP_BY_DIRECTION } from "./movement";
import { chebyshevDistance } from "./proximity";

/**
 * How close a monster has to be to swing. Chebyshev 1, so the eight tiles around it plus the
 * tile it is standing on — monsters do not block players, so sharing a tile is reachable.
 *
 * Local rather than shared: nothing on the client mirrors it, and Pass E owns the player's own
 * `ATTACK_RANGE_TILES` (design §6.1). Whether the two should be one constant is that pass's call.
 */
export const MONSTER_ATTACK_RANGE_TILES = 1;

/**
 * The states of the monster FSM (design §7). No LLM is involved anywhere in this file, and not
 * only because the user has forbidden it (2026-08-28): decisions happen tens of times per room
 * per 200ms tick, and a non-deterministic call with a round trip in the hundreds of milliseconds
 * could neither meet that budget nor be unit-tested the way the rest of this codebase is.
 *
 * `wander` is the tick a wander step is actually taken; between steps the monster is `idle`.
 * A monster walking home after its leash broke is wandering too — the walk home is the same
 * greedy stepper aimed at the spawn tile, which is why it needs no state of its own.
 */
export const MonsterAiState = {
  Idle: "idle",
  Wander: "wander",
  Chase: "chase",
  Attack: "attack",
  Dead: "dead",
} as const;

export type MonsterAiState = (typeof MonsterAiState)[keyof typeof MonsterAiState];

/** What the room should do with one monster this tick. */
export const MonsterActionKind = {
  /** Nothing happens. The state and target in the action still apply. */
  Hold: "hold",
  /** Try {@link MonsterStep.directions} in order; the first walkable one is the step. */
  Step: "step",
  /** Swing at {@link MonsterAction.targetSessionId}. */
  Attack: "attack",
  /** The respawn delay has elapsed: put the monster back on its spawn tile. */
  Respawn: "respawn",
} as const;

export type MonsterActionKind = (typeof MonsterActionKind)[keyof typeof MonsterActionKind];

/**
 * Everything the FSM needs about one monster. Deliberately not the `Monster` schema object: this
 * function knows nothing about the room, so it is given plain numbers and hands back plain
 * instructions, and the whole transition table can be exercised without a room, a map or a socket.
 *
 * There is no `targetSessionId` here because target selection is stateless — the nearest player
 * inside the aggro radius, every tick — so there is no previous choice to carry forward and no
 * way for a stale one to linger.
 */
export interface MonsterSnapshot {
  /** The spawn row id. Used only as the wander seed, so wandering is per-monster but repeatable. */
  id: string;
  state: MonsterAiState;
  tileX: number;
  tileY: number;
  /** The spawn tile: the leash origin and the centre of the wander box. */
  spawn: TilePosition;
  /** Chebyshev half-extent of the wander box. 0 pins the monster to its spawn tile. */
  wanderRadiusTiles: number;
  /** Earliest server time another step may be taken. */
  nextStepAt: number;
  /** Earliest server time another swing may land. */
  nextAttackAt: number;
  /** Only meaningful while dead: when the corpse may come back. */
  respawnAt: number;
}

/** One candidate target, as the room reads it out of `state.players`. */
export interface MonsterTarget extends TilePosition {
  sessionId: string;
}

interface MonsterActionBase {
  /** The FSM state to store back on the monster, whatever else the action says. */
  readonly state: MonsterAiState;
  /** The chased or attacked session, or null outside those two states. */
  readonly targetSessionId: string | null;
}

export interface MonsterHold extends MonsterActionBase {
  readonly kind: typeof MonsterActionKind.Hold;
}

export interface MonsterStep extends MonsterActionBase {
  readonly kind: typeof MonsterActionKind.Step;
  /**
   * Candidate directions in preference order — greedy along the dominant axis first, then the
   * other one (design §7: no A*). The caller resolves them against the collision map, which is
   * what keeps this function free of any map dependency.
   *
   * Never empty.
   */
  readonly directions: readonly Direction[];
  /** The deadline to store, whether or not any of the directions turned out to be walkable. */
  readonly nextStepAt: number;
}

export interface MonsterSwing extends MonsterActionBase {
  readonly kind: typeof MonsterActionKind.Attack;
  /** Which way to turn to face the target, or null when the two share a tile. */
  readonly facing: Direction | null;
  readonly nextAttackAt: number;
}

export interface MonsterRespawn extends MonsterActionBase {
  readonly kind: typeof MonsterActionKind.Respawn;
}

export type MonsterAction = MonsterHold | MonsterStep | MonsterSwing | MonsterRespawn;

/** Rotation order for wandering. Fixed so a given seed always produces the same walk. */
const WANDER_ROTATION: readonly Direction[] = [
  Direction.Down,
  Direction.Left,
  Direction.Right,
  Direction.Up,
];

/**
 * Decides what one monster does this tick. Pure: same inputs, same action, no clock of its own
 * and no room, map or socket in sight.
 *
 * `now` is the tick's single timestamp. Every deadline it produces is `now + interval`, so with
 * the tick and the intervals both multiples of MONSTER_TICK_MS the deadlines land exactly on
 * ticks rather than a tick late.
 *
 * `nearbyPlayers` is whatever the caller's proximity query returned; the aggro radius is applied
 * again here, so a caller that queries wider (or hands in a hand-built list, as the tests do)
 * still gets the documented behaviour.
 */
export function decideMonsterAction(
  snapshot: MonsterSnapshot,
  nearbyPlayers: readonly MonsterTarget[],
  now: number,
  type: MonsterType,
): MonsterAction {
  if (snapshot.state === MonsterAiState.Dead) {
    return now >= snapshot.respawnAt
      ? { kind: MonsterActionKind.Respawn, state: MonsterAiState.Idle, targetSessionId: null }
      : { kind: MonsterActionKind.Hold, state: MonsterAiState.Dead, targetSessionId: null };
  }

  const target = selectTarget(snapshot, nearbyPlayers, type);
  if (target === null) {
    return decideUnaggroed(snapshot, now, type);
  }
  if (type.behavior === "timid") {
    return decideFlee(snapshot, target, now, type);
  }

  const distance = chebyshevDistance(snapshot, target);
  if (distance <= MONSTER_ATTACK_RANGE_TILES) {
    if (now < snapshot.nextAttackAt) {
      return {
        kind: MonsterActionKind.Hold,
        state: MonsterAiState.Attack,
        targetSessionId: target.sessionId,
      };
    }
    return {
      kind: MonsterActionKind.Attack,
      state: MonsterAiState.Attack,
      targetSessionId: target.sessionId,
      facing: facingToward(snapshot, target),
      nextAttackAt: now + type.attackCooldownMs,
    };
  }

  if (now < snapshot.nextStepAt) {
    return {
      kind: MonsterActionKind.Hold,
      state: MonsterAiState.Chase,
      targetSessionId: target.sessionId,
    };
  }
  // Non-empty because `distance` is at least 2 here, so at least one axis has a non-zero delta.
  return {
    kind: MonsterActionKind.Step,
    state: MonsterAiState.Chase,
    targetSessionId: target.sessionId,
    directions: greedyDirections(snapshot, target),
    nextStepAt: now + type.chaseStepIntervalMs,
  };
}

function decideFlee(snapshot: MonsterSnapshot, target: MonsterTarget, now: number, type: MonsterType): MonsterAction {
  if (now < snapshot.nextStepAt) {
    return { kind: MonsterActionKind.Hold, state: MonsterAiState.Wander, targetSessionId: null };
  }
  const distance = chebyshevDistance(snapshot, target);
  const axisDistance = Math.abs(snapshot.tileX - target.tileX) + Math.abs(snapshot.tileY - target.tileY);
  const directions = WANDER_ROTATION.map((direction) => {
    const delta = STEP_BY_DIRECTION[direction];
    const destination = { tileX: snapshot.tileX + delta.dx, tileY: snapshot.tileY + delta.dy };
    return {
      direction,
      distance: chebyshevDistance(destination, target),
      axisDistance: Math.abs(destination.tileX - target.tileX) + Math.abs(destination.tileY - target.tileY),
      homeDistance: chebyshevDistance(destination, snapshot.spawn),
    };
  }).filter((candidate) => candidate.homeDistance <= type.leashRadiusTiles
    && candidate.distance >= distance && candidate.axisDistance > axisDistance)
    .sort((left, right) => right.distance - left.distance || right.axisDistance - left.axisDistance)
    .map((candidate) => candidate.direction);
  if (directions.length === 0) {
    return { kind: MonsterActionKind.Hold, state: MonsterAiState.Idle, targetSessionId: null };
  }
  return {
    kind: MonsterActionKind.Step,
    state: MonsterAiState.Wander,
    targetSessionId: null,
    directions,
    nextStepAt: now + (type.fleeStepIntervalMs ?? type.wanderStepIntervalMs),
  };
}

/**
 * The nearest player inside the aggro radius, ties broken by session id so the choice is
 * reproducible. Null once the monster has been dragged past its leash radius: without that a
 * monster follows a player to the far wall and the whole field ends up queued behind one person.
 *
 * Re-acquisition is gated by the same leash distance, so a player who parks exactly on the leash
 * boundary can make a monster alternate between chasing and walking home. That is visible but
 * harmless — the monster stays on its tether either way — and the alternative is a "returning"
 * state that the design's FSM does not have.
 */
function selectTarget(
  snapshot: MonsterSnapshot,
  nearbyPlayers: readonly MonsterTarget[],
  type: MonsterType,
): MonsterTarget | null {
  if (chebyshevDistance(snapshot, snapshot.spawn) > type.leashRadiusTiles) {
    return null;
  }

  let best: MonsterTarget | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of nearbyPlayers) {
    const distance = chebyshevDistance(snapshot, candidate);
    if (distance > type.aggroRadiusTiles) {
      continue;
    }
    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate.sessionId < best.sessionId)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Idle, wander, or the walk home after a leash break — the three cases with no target. */
function decideUnaggroed(snapshot: MonsterSnapshot, now: number, type: MonsterType): MonsterAction {
  if (now < snapshot.nextStepAt) {
    return { kind: MonsterActionKind.Hold, state: MonsterAiState.Idle, targetSessionId: null };
  }

  // Outside its box, so it is on its way home. Walking home at the wander pace rather than the
  // chase pace is deliberate: the monster is no longer hunting anything.
  if (chebyshevDistance(snapshot, snapshot.spawn) > snapshot.wanderRadiusTiles) {
    return {
      kind: MonsterActionKind.Step,
      state: MonsterAiState.Wander,
      targetSessionId: null,
      directions: greedyDirections(snapshot, snapshot.spawn),
      nextStepAt: now + type.wanderStepIntervalMs,
    };
  }

  const directions = wanderDirections(snapshot, now);
  if (directions.length === 0) {
    // A radius-0 spawner, i.e. a monster that stands where it was put.
    return { kind: MonsterActionKind.Hold, state: MonsterAiState.Idle, targetSessionId: null };
  }
  return {
    kind: MonsterActionKind.Step,
    state: MonsterAiState.Wander,
    targetSessionId: null,
    directions,
    nextStepAt: now + type.wanderStepIntervalMs,
  };
}

/**
 * Greedy pursuit, one tile at a time: the dominant axis first and the other one as the fallback
 * for when the first is blocked. Not A* — the hunting ground is authored as open country
 * precisely so this suffices (design §4.1), and it is also what the monsters of the original
 * game do. Its known weakness is oscillating in a concave dead end, which the map avoids rather
 * than the code (design §11-5).
 *
 * Empty only when `from` and `to` are the same tile, which no caller does.
 */
function greedyDirections(from: TilePosition, to: TilePosition): readonly Direction[] {
  const dx = to.tileX - from.tileX;
  const dy = to.tileY - from.tileY;
  const horizontal = dx > 0 ? Direction.Right : dx < 0 ? Direction.Left : null;
  const vertical = dy > 0 ? Direction.Down : dy < 0 ? Direction.Up : null;
  // A tie goes to the vertical axis — `>` rather than `>=` — so equal deltas resolve the same
  // way every run. Which way it breaks matters less than that it never varies.
  const ordered = Math.abs(dx) > Math.abs(dy) ? [horizontal, vertical] : [vertical, horizontal];
  const directions: Direction[] = [];
  for (const direction of ordered) {
    if (direction !== null) {
      directions.push(direction);
    }
  }
  return directions;
}

/**
 * The four directions, rotated by a hash of the monster id and the tick, and filtered down to
 * those that stay inside the wander box. The caller walks the list until one is walkable, so a
 * monster in a corridor still moves instead of standing still until it happens to roll the open
 * direction.
 *
 * Hashed rather than drawn from an RNG so that the function keeps the four-argument shape the
 * design gives it and stays reproducible: a test can assert the exact walk of a given id from a
 * given tick, and two monsters never march in step because their ids differ.
 */
function wanderDirections(snapshot: MonsterSnapshot, now: number): readonly Direction[] {
  if (snapshot.wanderRadiusTiles <= 0) {
    return [];
  }
  const offset = hashDirectionSeed(snapshot.id, now) % WANDER_ROTATION.length;
  const directions: Direction[] = [];
  for (let index = 0; index < WANDER_ROTATION.length; index++) {
    const direction = WANDER_ROTATION[(offset + index) % WANDER_ROTATION.length];
    if (direction === undefined) {
      continue;
    }
    const delta = STEP_BY_DIRECTION[direction];
    const destination = { tileX: snapshot.tileX + delta.dx, tileY: snapshot.tileY + delta.dy };
    if (chebyshevDistance(destination, snapshot.spawn) <= snapshot.wanderRadiusTiles) {
      directions.push(direction);
    }
  }
  return directions;
}

/** Which way to turn to look at `to`, or null when there is nothing to turn towards. */
function facingToward(from: TilePosition, to: TilePosition): Direction | null {
  const [first] = greedyDirections(from, to);
  return first ?? null;
}

/**
 * FNV-1a over the id, salted with the tick and finished with an avalanche step. The finisher is
 * the part that matters: ticks arrive 200ms apart, so without it the low bits of `now` would walk
 * through the rotation in order and every monster would trace the same lockstep pattern.
 */
function hashDirectionSeed(id: string, now: number): number {
  let hash = (0x811c9dc5 ^ (now | 0)) >>> 0;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;
  return hash >>> 0;
}
