import { Direction, type MoveRejected, type TilePosition } from "@zep-test/shared";
import type { PlayerSnapshot } from "../net/roomConnection";
import type { PlayerSprites } from "./playerSprites";

// Duplicated from the server's movement resolver — the two live in separate workspaces
// and `shared` holds no geometry helper. Keep in step with server/src/game/movement.ts.
function neighbour(from: TilePosition, dir: Direction): TilePosition {
  switch (dir) {
    case Direction.Up:
      return { tileX: from.tileX, tileY: from.tileY - 1 };
    case Direction.Down:
      return { tileX: from.tileX, tileY: from.tileY + 1 };
    case Direction.Left:
      return { tileX: from.tileX - 1, tileY: from.tileY };
    case Direction.Right:
      return { tileX: from.tileX + 1, tileY: from.tileY };
  }
}

/**
 * Moves the local avatar optimistically and lets the server correct it.
 *
 * Collision is deliberately not predicted: the server owns walkability, so a step into
 * a wall is drawn and then snapped back when `MoveRejected` lands.
 */
export class LocalPlayer {
  private predicted: PlayerSnapshot;
  /** Steps sent but not yet reflected in a state patch. */
  private inFlight = 0;

  constructor(
    private readonly sessionId: string,
    spawn: PlayerSnapshot,
    private readonly sprites: PlayerSprites,
    private readonly sendMove: (dir: Direction) => void,
  ) {
    this.predicted = { ...spawn };
  }

  step(dir: Direction): void {
    const next = neighbour(this.predicted, dir);
    this.predicted = { ...this.predicted, ...next, facing: dir };
    this.inFlight += 1;
    this.sprites.update(this.sessionId, this.predicted);
    this.sendMove(dir);
  }

  /**
   * The server refused a step — wall or rate limit. Its position is absolute, so one
   * correction resolves a whole throttled burst even though only one message arrives.
   */
  applyRejection(correction: MoveRejected): void {
    this.inFlight = 0;
    this.adopt(correction);
  }

  /**
   * A state patch for our own player. While steps are in flight the prediction is
   * legitimately ahead of the server, so patches are consumed rather than applied —
   * otherwise every confirmed step would rubber-band the avatar backwards. Once
   * nothing is outstanding the server wins, which self-heals any drift.
   */
  applyServerState(snapshot: PlayerSnapshot): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
      return;
    }
    this.adopt(snapshot);
  }

  private adopt(state: TilePosition & { facing: Direction }): void {
    this.predicted = {
      ...this.predicted,
      tileX: state.tileX,
      tileY: state.tileY,
      facing: state.facing,
    };
    this.sprites.update(this.sessionId, this.predicted);
  }
}
