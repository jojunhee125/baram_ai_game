import { AVATAR_SKIN_COUNT, type JoinOptions } from "@zep-test/shared";

let sessionIdentity: JoinOptions | null = null;

/**
 * The identity every join of this page uses. Placeholder values until a character-select
 * screen exists; not a Phase1 deliverable.
 *
 * Memoised for the lifetime of the page because joining is no longer a one-off: a portal hop
 * rejoins, and rolling fresh values there would change the player's avatar on every doorway.
 * (Under SSO the server overwrites the nickname, so the skin is the visible half of that bug.)
 */
export function resolveJoinOptions(): JoinOptions {
  sessionIdentity ??= {
    nickname: `손님${Math.floor(Math.random() * 9000) + 1000}`,
    avatarSkin: Math.floor(Math.random() * AVATAR_SKIN_COUNT),
  };
  return { ...sessionIdentity };
}
