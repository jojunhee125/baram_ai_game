import type { JoinOptions } from "@zep-test/shared";

let sessionIdentity: JoinOptions | null = null;
let selectedSkin: number | null = null;

/**
 * Records the avatar the player chose. Must run before the first {@link resolveJoinOptions},
 * i.e. before the first `connect()` — the identity is frozen at that call and every later join
 * reuses it.
 */
export function setAvatarSkin(skin: number): void {
  selectedSkin = skin;
}

/**
 * The identity every join of this page uses. The nickname is still a placeholder; under SSO the
 * server overwrites it.
 *
 * Memoised for the lifetime of the page because joining is not a one-off: a portal hop and a
 * cross-room home hop both rejoin, and rolling fresh values there would change the player's
 * avatar in every doorway.
 */
export function resolveJoinOptions(): JoinOptions {
  sessionIdentity ??= {
    nickname: `손님${Math.floor(Math.random() * 9000) + 1000}`,
    avatarSkin: chosenSkin(),
  };
  return { ...sessionIdentity };
}

/**
 * Deliberately loud and deterministic rather than a random fallback: joining without a choice
 * means the boot flow skipped the picker, and a random skin would hide that behind a plausible
 * avatar until someone noticed their character changing between sessions.
 */
function chosenSkin(): number {
  if (selectedSkin === null) {
    console.warn("resolveJoinOptions() ran before setAvatarSkin(); joining with skin 0");
    return 0;
  }
  return selectedSkin;
}
