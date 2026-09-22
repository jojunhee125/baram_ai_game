import {
  Direction,
  type MoveRejected,
  type Teleported,
  type TilePosition,
} from "@zep-test/shared";
import type { PlayerSnapshot } from "../net/roomConnection";
import type { NameTags } from "./nameTags";
import type { PlayerSprites } from "./playerSprites";

/**
 * Whether a tile can be walked onto, answered from the loaded tilemap.
 *
 * Injected rather than looked up so that this class keeps holding no scene, no tilemap and no
 * Phaser type at all — the map is the scene's, and the scene rebuilds it on every room.
 */
export type WalkabilityOracle = (tileX: number, tileY: number) => boolean;

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

function sameTile(a: TilePosition, b: TilePosition): boolean {
  return a.tileX === b.tileX && a.tileY === b.tileY;
}

function tileOf(state: TilePosition): TilePosition {
  return { tileX: state.tileX, tileY: state.tileY };
}

/**
 * Moves the local avatar optimistically and lets the server correct it.
 *
 * Walkability is predicted from the same tilemap the world is drawn from, so walking into a
 * wall no longer draws a step and then snaps back a round trip later. The server still owns the
 * verdict: prediction only ever *withholds* a move, never invents one, so the worst a stale or
 * wrong map can do is refuse a step the server would have allowed.
 */
export class LocalPlayer {
  private predicted: PlayerSnapshot;
  /** Where the server last told us it had us — the base the pending path is measured from. */
  private confirmed: TilePosition;
  /**
   * The tiles the server still owes us a patch for, oldest first, ending at {@link predicted}:
   * one per step sent, plus any teleport we have been told about but not yet seen in a patch.
   *
   * Counting outstanding steps instead was the source of a permanent desync: a warp that reset
   * the count left the patches of steps sent before it to be miscounted against steps sent
   * after it. Positions are self-describing, so a patch is matched rather than counted.
   */
  private readonly pendingPath: TilePosition[] = [];

  constructor(
    private readonly sessionId: string,
    spawn: PlayerSnapshot,
    private readonly sprites: PlayerSprites,
    /** Own nameTag redraw on a level change (§below) — the same renderer WorldScene's own remote branch uses. */
    private readonly nameTags: NameTags,
    private readonly sendMove: (dir: Direction) => void,
    private readonly isWalkable: WalkabilityOracle,
  ) {
    this.predicted = { ...spawn };
    this.confirmed = tileOf(spawn);
  }

  /**
   * Where the avatar is pointing right now, prediction included. Read by the swing animation,
   * which has to point the same way the server's own target selection will.
   */
  get facing(): Direction {
    return this.predicted.facing;
  }

  /** Steps and warps sent or received but not yet reflected in a state patch. */
  private get inFlight(): number {
    return this.pendingPath.length;
  }

  /**
   * Records a tile the server has yet to report.
   *
   * Landing back on a tile the path already holds — walking back off a warp, say — drops the
   * loop instead of extending the path: from there on the server's state is unchanged, so it
   * has nothing left to patch, and a path left waiting on a patch that is never sent would
   * swallow the next correction that does arrive.
   */
  private expect(position: TilePosition): void {
    if (sameTile(position, this.confirmed)) {
      this.pendingPath.length = 0;
      return;
    }
    const looped = this.pendingPath.findIndex((tile) => sameTile(tile, position));
    if (looped >= 0) {
      this.pendingPath.length = looped + 1;
      return;
    }
    this.pendingPath.push(position);
  }

  /**
   * A step into a wall turns the avatar and stops there: nothing is sent and nothing is
   * predicted, so the round trip that used to end in a `MoveRejected` snap never starts.
   *
   * Withholding the message also withholds the turn from the server, so other players do not
   * see this avatar face the wall. That is deliberate: the next accepted step carries the
   * facing with it, so the two converge as soon as the player walks anywhere at all.
   */
  step(dir: Direction): void {
    const next = neighbour(this.predicted, dir);
    if (!this.isWalkable(next.tileX, next.tileY)) {
      if (this.predicted.facing !== dir) {
        this.predicted = { ...this.predicted, facing: dir };
        this.sprites.update(this.sessionId, this.predicted);
      }
      return;
    }
    this.predicted = { ...this.predicted, ...next, facing: dir };
    this.expect(next);
    this.sprites.update(this.sessionId, this.predicted);
    this.sendMove(dir);
  }

  /**
   * The server refused a step — wall or rate limit. Its position is absolute, so one
   * correction resolves a whole throttled burst even though only one message arrives.
   */
  applyRejection(correction: MoveRejected): void {
    this.pendingPath.length = 0;
    this.confirmed = tileOf(correction);
    this.adopt(correction);
  }

  /**
   * The server moved us without us walking there — the home warp.
   *
   * Steps sent just before the warp may still be queued server-side and get applied on top of
   * the destination, so the warp joins the pending path rather than clearing it: their patches
   * still have a tile to match, and one that matches nothing corrects us on the spot.
   */
  applyTeleport(destination: Teleported): void {
    this.expect(destination);
    this.adopt(destination);
  }

  /**
   * A state patch for our own player. While steps are in flight the prediction is legitimately
   * ahead of the server, so a patch that lands on the path we predicted only says how far the
   * server has got and is consumed — otherwise every confirmed step would rubber-band the
   * avatar backwards. A patch anywhere else is the server disagreeing with us and wins, which
   * self-heals any drift.
   */
  applyServerState(snapshot: PlayerSnapshot): void {
    // Skin has no prediction to reconcile — unlike position, the server's value is simply the
    // truth — so it is applied unconditionally, ahead of the tile-reconciliation branches below.
    // Some of those branches return early without ever touching the sprite (the server has not
    // caught up to an in-flight step yet), so without this a re-skin from the character menu
    // (Phase H) would go unseen on the local player's own screen until one of those branches
    // happened to fall through to `adopt()`.
    if (snapshot.avatarSkin !== this.predicted.avatarSkin ||
      snapshot.weaponItemKey !== this.predicted.weaponItemKey ||
      snapshot.armorItemKey !== this.predicted.armorItemKey) {
      this.predicted = {
        ...this.predicted,
        avatarSkin: snapshot.avatarSkin,
        weaponItemKey: snapshot.weaponItemKey,
        armorItemKey: snapshot.armorItemKey,
      };
      this.sprites.update(this.sessionId, this.predicted);
    }

    // Same reasoning and the same "nothing to reconcile, just adopt the server's value" treatment
    // as avatarSkin above: level has no local prediction either, and unlike avatarSkin it also
    // never shows on the sprite itself, only on the name tag — so this redraws that directly
    // rather than routing through `sprites.update()`.
    if (snapshot.level !== this.predicted.level) {
      this.predicted = { ...this.predicted, level: snapshot.level };
      const sprite = this.sprites.get(this.sessionId);
      if (sprite) {
        this.nameTags.add(this.sessionId, sprite, `Lv.${snapshot.level} ${snapshot.nickname}`);
      }
    }

    const reached = this.pendingPath.findIndex((tile) => sameTile(tile, snapshot));
    if (reached >= 0) {
      this.confirmed = tileOf(snapshot);
      this.pendingPath.splice(0, reached + 1);
      return;
    }
    if (this.inFlight > 0 && sameTile(snapshot, this.confirmed)) {
      // The server has not started on the outstanding steps yet; it is behind, not correcting.
      return;
    }
    this.pendingPath.length = 0;
    this.confirmed = tileOf(snapshot);
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
