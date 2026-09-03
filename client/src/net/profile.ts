import { AVATAR_SKIN_COUNT } from "@zep-test/shared";

/**
 * Same-origin on purpose: in production the game server serves this bundle, so the request
 * carries the SSO cookies the KAD gateway checks. `vite.config.ts` proxies it in dev.
 */
const PROFILE_PATH = "/api/profile";

/**
 * A remembered skin is a convenience, not a precondition for playing, so a gateway that never
 * answers must not hold character select behind a spinner forever.
 */
const LOAD_TIMEOUT_MS = 3000;

/**
 * The outcome of asking the account what it last picked.
 *
 * `ok` and `skin` are independent on purpose (Phase C, 2026-09-03): "never chose before" and "no
 * SSO identity" are a *successful* read that legitimately found nothing, so `ok: true, skin:
 * null` — only a request that actually failed (network error, timeout, non-OK status) is `ok:
 * false`. Collapsing those into one `null` used to be `BootScene`'s bug: it could not tell "you
 * have never picked" from "the request to check just failed", so it saved over a real stored skin
 * with the picker's arbitrary fallback whenever a transient failure hit mid-boot.
 */
export interface LoadedAvatarSkin {
  ok: boolean;
  skin: number | null;
}

/**
 * Deliberately outside `RoomConnection`: this is account data, read once before the world exists
 * and before any room is joined, so it never touches the join path that carries 500 CCU.
 */
export async function loadAvatarSkin(): Promise<LoadedAvatarSkin> {
  try {
    const response = await fetch(PROFILE_PATH, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, skin: null };
    }
    return { ok: true, skin: readSkin(await response.json()) };
  } catch (error) {
    console.warn("could not read the stored avatar skin; starting from the first one", error);
    return { ok: false, skin: null };
  }
}

/**
 * Records the choice for next time. Fire-and-forget by design: the skin is already applied
 * locally, so awaiting the round trip would only put a network hop between the picker and the
 * world, and a failure costs the player nothing this session.
 */
export function saveAvatarSkin(skin: number): void {
  void fetch(PROFILE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ avatarSkin: skin }),
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    })
    .catch((error: unknown) => {
      console.warn("could not store the avatar skin; it will not be remembered", error);
    });
}

/**
 * Range-checked against the sheet the browser holds rather than trusted: the picker focuses the
 * cell it is given, and an index with no cell would leave character select with nothing selected
 * and nothing focused — a dead keyboard, not a visibly wrong avatar.
 */
function readSkin(body: unknown): number | null {
  const skin = (body as { avatarSkin?: unknown } | null)?.avatarSkin;
  if (typeof skin !== "number" || !Number.isInteger(skin) || skin < 0 || skin >= AVATAR_SKIN_COUNT) {
    return null;
  }
  return skin;
}
