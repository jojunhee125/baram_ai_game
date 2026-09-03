import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Direction, MONSTER_TICK_MS } from "@zep-test/shared";
import { MonsterKind, type MonsterType } from "../rooms/monsterDefinitions";
import {
  decideMonsterAction,
  MonsterActionKind,
  MonsterAiState,
  MONSTER_ATTACK_RANGE_TILES,
  type MonsterAction,
  type MonsterSnapshot,
  type MonsterTarget,
} from "./monsterAi";

/**
 * Squirrel's real numbers. Kept as a literal rather than read out of MONSTER_TYPES so that a
 * balance change to the table cannot silently rewrite what these cases claim to prove.
 */
const SQUIRREL: MonsterType = {
  kind: MonsterKind.Squirrel,
  maxHp: 12,
  damage: 2,
  attackCooldownMs: 1200,
  wanderStepIntervalMs: 1600,
  chaseStepIntervalMs: 600,
  aggroRadiusTiles: 4,
  leashRadiusTiles: 8,
  respawnDelayMs: 8000,
  loot: [],
};

const SPAWN = { tileX: 20, tileY: 20 };
const NOW = 1_000_000;

function snapshot(overrides: Partial<MonsterSnapshot> = {}): MonsterSnapshot {
  return {
    id: "hg-squirrel-01",
    state: MonsterAiState.Idle,
    tileX: SPAWN.tileX,
    tileY: SPAWN.tileY,
    spawn: SPAWN,
    wanderRadiusTiles: 2,
    nextStepAt: 0,
    nextAttackAt: 0,
    respawnAt: 0,
    ...overrides,
  };
}

function player(sessionId: string, tileX: number, tileY: number): MonsterTarget {
  return { sessionId, tileX, tileY };
}

function decide(
  overrides: Partial<MonsterSnapshot>,
  nearby: readonly MonsterTarget[] = [],
  now: number = NOW,
  type: MonsterType = SQUIRREL,
): MonsterAction {
  return decideMonsterAction(snapshot(overrides), nearby, now, type);
}

function stepOf(action: MonsterAction): { directions: readonly Direction[]; nextStepAt: number } {
  assert.equal(action.kind, MonsterActionKind.Step, `expected a step, got ${action.kind}`);
  assert.ok(action.kind === MonsterActionKind.Step);
  return { directions: action.directions, nextStepAt: action.nextStepAt };
}

describe("decideMonsterAction — dead and respawn", () => {
  it("holds while the respawn delay is still running", () => {
    const action = decide({ state: MonsterAiState.Dead, respawnAt: NOW + 1 });
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Dead);
    assert.equal(action.targetSessionId, null);
  });

  it("respawns on the exact millisecond the delay expires, not one tick later", () => {
    const action = decide({ state: MonsterAiState.Dead, respawnAt: NOW });
    assert.equal(action.kind, MonsterActionKind.Respawn);
    assert.equal(action.state, MonsterAiState.Idle);
  });

  it("respawns as idle with no target, whoever is standing on the corpse", () => {
    const action = decide(
      { state: MonsterAiState.Dead, respawnAt: NOW - 5000 },
      [player("a", SPAWN.tileX, SPAWN.tileY)],
    );
    assert.equal(action.kind, MonsterActionKind.Respawn);
    assert.equal(action.state, MonsterAiState.Idle);
    assert.equal(action.targetSessionId, null);
  });

  it("ignores nearby players entirely while dead — a corpse does not aggro", () => {
    const action = decide(
      { state: MonsterAiState.Dead, respawnAt: NOW + 1 },
      [player("a", SPAWN.tileX + 1, SPAWN.tileY)],
    );
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Dead);
  });
});

describe("decideMonsterAction — idle and wander", () => {
  it("holds as idle before the wander deadline", () => {
    const action = decide({ nextStepAt: NOW + 1 });
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Idle);
  });

  it("wanders on the deadline itself and books the next one a wander interval out", () => {
    const action = decide({ nextStepAt: NOW });
    assert.equal(action.state, MonsterAiState.Wander);
    assert.equal(action.targetSessionId, null);
    assert.equal(stepOf(action).nextStepAt, NOW + SQUIRREL.wanderStepIntervalMs);
  });

  it("offers all four directions from the centre of the wander box", () => {
    const { directions } = stepOf(decide({}));
    assert.deepEqual([...directions].sort(), [
      Direction.Down,
      Direction.Left,
      Direction.Right,
      Direction.Up,
    ].sort());
  });

  it("offers only the directions that keep the monster inside its wander box", () => {
    // The far corner of a radius-2 box: two of the four steps would leave it.
    const { directions } = stepOf(
      decide({ tileX: SPAWN.tileX + 2, tileY: SPAWN.tileY + 2 }),
    );
    assert.deepEqual([...directions].sort(), [Direction.Left, Direction.Up].sort());
  });

  it("never moves a radius-0 spawner, whatever the deadline says", () => {
    const action = decide({ wanderRadiusTiles: 0, nextStepAt: 0 });
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Idle);
  });

  it("is reproducible: the same id and tick always produce the same walk", () => {
    assert.deepEqual(decide({}), decide({}));
    assert.deepEqual(decide({ id: "hg-rabbit-04" }), decide({ id: "hg-rabbit-04" }));
  });

  it("does not march every monster in step — ids diverge at one shared tick", () => {
    const first = new Set<Direction | undefined>();
    for (let index = 0; index < 20; index++) {
      first.add(stepOf(decide({ id: `hg-squirrel-${index}` })).directions[0]);
    }
    assert.ok(first.size > 1, `every id picked the same direction: ${JSON.stringify([...first])}`);
  });

  it("does not march one monster in step with itself as ticks advance", () => {
    const first = new Set<Direction | undefined>();
    for (let tick = 0; tick < 20; tick++) {
      first.add(stepOf(decide({}, [], NOW + tick * MONSTER_TICK_MS)).directions[0]);
    }
    assert.ok(first.size > 1, `every tick picked the same direction: ${JSON.stringify([...first])}`);
  });
});

describe("decideMonsterAction — leash", () => {
  const outsideBox = { tileX: SPAWN.tileX + 5, tileY: SPAWN.tileY };

  it("walks home at the wander pace once it is outside its wander box", () => {
    const action = decide(outsideBox);
    assert.equal(action.state, MonsterAiState.Wander);
    const { directions, nextStepAt } = stepOf(action);
    assert.deepEqual(directions, [Direction.Left], "the only axis with a delta points home");
    assert.equal(nextStepAt, NOW + SQUIRREL.wanderStepIntervalMs, "walking home is not a chase");
  });

  it("drops a target the moment the leash radius is exceeded, even from point blank", () => {
    const far = { tileX: SPAWN.tileX + SQUIRREL.leashRadiusTiles + 1, tileY: SPAWN.tileY };
    const action = decide(far, [player("a", far.tileX + 1, far.tileY)]);
    assert.equal(action.targetSessionId, null, "a leashed monster has no target at all");
    assert.equal(action.state, MonsterAiState.Wander);
    assert.deepEqual(stepOf(action).directions, [Direction.Left]);
  });

  it("still chases at exactly the leash radius — the break is strictly beyond it", () => {
    const edge = { tileX: SPAWN.tileX + SQUIRREL.leashRadiusTiles, tileY: SPAWN.tileY };
    const action = decide(edge, [player("a", edge.tileX + 3, edge.tileY)]);
    assert.equal(action.state, MonsterAiState.Chase);
    assert.equal(action.targetSessionId, "a");
  });
});

describe("decideMonsterAction — target selection", () => {
  it("ignores a player one tile outside the aggro radius", () => {
    const action = decide({}, [player("a", SPAWN.tileX + SQUIRREL.aggroRadiusTiles + 1, SPAWN.tileY)]);
    assert.equal(action.targetSessionId, null);
    assert.equal(action.state, MonsterAiState.Wander);
  });

  it("takes a player standing exactly on the aggro radius", () => {
    const action = decide({}, [player("a", SPAWN.tileX + SQUIRREL.aggroRadiusTiles, SPAWN.tileY)]);
    assert.equal(action.targetSessionId, "a");
    assert.equal(action.state, MonsterAiState.Chase);
  });

  it("re-applies the aggro radius to whatever the caller passed in", () => {
    // A caller querying a wider radius — or a test handing in the whole room — must not widen
    // aggro by accident.
    const action = decide({}, [player("far", SPAWN.tileX + 40, SPAWN.tileY)]);
    assert.equal(action.targetSessionId, null);
  });

  it("picks the nearest player", () => {
    const action = decide({}, [
      player("aaa-far", SPAWN.tileX + 3, SPAWN.tileY),
      player("zzz-near", SPAWN.tileX + 1, SPAWN.tileY + 1),
    ]);
    assert.equal(action.targetSessionId, "zzz-near", "distance beats the id ordering");
  });

  it("breaks a distance tie by session id, so the choice replays identically", () => {
    const tied = [
      player("mmm", SPAWN.tileX + 2, SPAWN.tileY),
      player("aaa", SPAWN.tileX - 2, SPAWN.tileY),
      player("zzz", SPAWN.tileX, SPAWN.tileY + 2),
    ];
    assert.equal(decide({}, tied).targetSessionId, "aaa");
    assert.equal(decide({}, [...tied].reverse()).targetSessionId, "aaa", "and not on array order");
  });

  it("uses Chebyshev distance, so a diagonal neighbour is adjacent", () => {
    const action = decide({}, [player("a", SPAWN.tileX + 1, SPAWN.tileY + 1)]);
    assert.equal(action.state, MonsterAiState.Attack);
  });
});

describe("decideMonsterAction — chase", () => {
  it("steps along the dominant axis first and offers the other as the fallback", () => {
    const action = decide({}, [player("a", SPAWN.tileX + 3, SPAWN.tileY + 1)]);
    assert.equal(action.state, MonsterAiState.Chase);
    assert.deepEqual(stepOf(action).directions, [Direction.Right, Direction.Down]);
  });

  it("breaks an equal-delta tie towards the vertical axis, always the same way", () => {
    const action = decide({}, [player("a", SPAWN.tileX - 2, SPAWN.tileY - 2)]);
    assert.deepEqual(stepOf(action).directions, [Direction.Up, Direction.Left]);
  });

  it("offers a single direction when the target is on the same row", () => {
    const action = decide({}, [player("a", SPAWN.tileX, SPAWN.tileY + 3)]);
    assert.deepEqual(stepOf(action).directions, [Direction.Down]);
  });

  it("books the next step a chase interval out, not a wander interval", () => {
    const action = decide({}, [player("a", SPAWN.tileX + 3, SPAWN.tileY)]);
    assert.equal(stepOf(action).nextStepAt, NOW + SQUIRREL.chaseStepIntervalMs);
  });

  it("holds in the chase state between steps rather than dropping back to idle", () => {
    const action = decide({ nextStepAt: NOW + 1 }, [player("a", SPAWN.tileX + 3, SPAWN.tileY)]);
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Chase);
    assert.equal(action.targetSessionId, "a");
  });

  it("returns to idle the tick its target walks out of range", () => {
    const action = decide({ state: MonsterAiState.Chase, nextStepAt: NOW + 1 }, []);
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Idle);
    assert.equal(action.targetSessionId, null);
  });
});

describe("decideMonsterAction — attack", () => {
  const adjacent = [player("a", SPAWN.tileX + MONSTER_ATTACK_RANGE_TILES, SPAWN.tileY)];

  it("swings at an adjacent target and books the cooldown", () => {
    const action = decide({}, adjacent);
    assert.equal(action.kind, MonsterActionKind.Attack);
    assert.equal(action.state, MonsterAiState.Attack);
    assert.equal(action.targetSessionId, "a");
    assert.ok(action.kind === MonsterActionKind.Attack);
    assert.equal(action.facing, Direction.Right);
    assert.equal(action.nextAttackAt, NOW + SQUIRREL.attackCooldownMs);
  });

  it("holds in the attack state while the cooldown is running, and does not step", () => {
    const action = decide({ nextAttackAt: NOW + 1 }, adjacent);
    assert.equal(action.kind, MonsterActionKind.Hold);
    assert.equal(action.state, MonsterAiState.Attack);
    assert.equal(action.targetSessionId, "a");
  });

  it("swings on the exact millisecond the cooldown expires", () => {
    assert.equal(decide({ nextAttackAt: NOW }, adjacent).kind, MonsterActionKind.Attack);
  });

  it("ignores the step deadline: a swing is not a step", () => {
    const action = decide({ nextStepAt: NOW + 10_000 }, adjacent);
    assert.equal(action.kind, MonsterActionKind.Attack);
  });

  it("reports no facing when the target shares the monster's tile", () => {
    const action = decide({}, [player("a", SPAWN.tileX, SPAWN.tileY)]);
    assert.equal(action.kind, MonsterActionKind.Attack);
    assert.ok(action.kind === MonsterActionKind.Attack);
    assert.equal(action.facing, null, "there is no direction towards where you already are");
  });

  it("faces each of the four directions from the four adjacent tiles", () => {
    const cases: ReadonlyArray<readonly [number, number, Direction]> = [
      [1, 0, Direction.Right],
      [-1, 0, Direction.Left],
      [0, 1, Direction.Down],
      [0, -1, Direction.Up],
    ];
    for (const [dx, dy, expected] of cases) {
      const action = decide({}, [player("a", SPAWN.tileX + dx, SPAWN.tileY + dy)]);
      assert.ok(action.kind === MonsterActionKind.Attack);
      assert.equal(action.facing, expected, `from delta (${dx},${dy})`);
    }
  });
});

describe("decideMonsterAction — deadlines land on ticks", () => {
  it("produces deadlines that are whole ticks away, so nothing rounds to the next one", () => {
    const chase = decide({}, [player("a", SPAWN.tileX + 3, SPAWN.tileY)]);
    const wander = decide({});
    const swing = decide({}, [player("a", SPAWN.tileX + 1, SPAWN.tileY)]);
    assert.ok(swing.kind === MonsterActionKind.Attack);

    for (const [label, deadline] of [
      ["chase step", stepOf(chase).nextStepAt],
      ["wander step", stepOf(wander).nextStepAt],
      ["attack cooldown", swing.nextAttackAt],
    ] as const) {
      assert.equal((deadline - NOW) % MONSTER_TICK_MS, 0, `${label} is not a whole tick away`);
    }
  });
});
