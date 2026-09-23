/**
 * Derives a display nickname from the KAD gateway's SSO access-token JWT. The gateway
 * (ForwardAuth) already verified the token before forwarding it, so this only reads
 * claims for display — it never authorizes anything, hence no signature check here.
 */
export function deriveSsoNickname(headers: Headers): string | null {
  const token = headers.get("x-auth-request-access-token");
  if (token === null) {
    return null;
  }
  const claims = decodeAccessTokenClaims(token);
  return parseDisplayName(claims?.["preferred_username"]);
}

/**
 * The account key everything persisted is filed under. Takes the token string rather than a
 * header container because the two callers hold different ones — the room's `onAuth` gets a
 * WHATWG `Headers`, an express route gets `IncomingHttpHeaders` — so reading the header stays
 * with the caller and reading the claim stays here.
 *
 * `sub` only, with no fallback to `x-auth-request-user` (design §2.5). A missing key is a
 * diagnosable failure; a key that quietly differs between two sources makes a user's saved
 * data look deleted and leaves nothing in the logs to say why.
 *
 * The value is an opaque UUID, not a name: it is safe in a response body and in a log line, and
 * none of the latin1 mangling that affects the Korean-name headers applies to it. The token it
 * came from stays out of both regardless.
 *
 * That shape is enforced here rather than assumed. `player_profile.owner_key` is a `uuid`
 * column, so a `sub` such as a service account's name arrives as a `22P02` the store cannot
 * distinguish from a connection failure — one such account loading the page would leave
 * `/api/health` reporting `db: "degraded"` and make that field useless for spotting a real
 * outage. A `sub` that is not a UUID is therefore no identity at all: the request takes the
 * existing no-identity path instead of failing as storage. The check is exactly as wide as
 * Postgres's own — hyphenated 8-4-4-12 hex, case-insensitive, version and variant nibbles
 * unexamined — because an app stricter than its database is a new failure mode of its own.
 */
export function deriveSsoUserId(accessToken: string | null): string | null {
  if (accessToken === null) {
    return null;
  }
  const subject = decodeAccessTokenClaims(accessToken)?.["sub"];
  if (typeof subject !== "string") {
    return null;
  }
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!UUID_PATTERN.test(trimmed)) {
    // Loud, unlike the other null branches: those are the ordinary unauthenticated case, while
    // this one is an account whose data silently will not persist.
    console.warn(`[zep-test] sub claim is not a UUID, so nothing can be filed under it: ${trimmed}`);
    return null;
  }
  return trimmed.toLowerCase();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeAccessTokenClaims(token: string): Record<string, unknown> | null {
  const payloadSegment = token.split(".")[1];
  if (payloadSegment === undefined) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
    return payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Keycloak's `preferred_username` claim is formatted "{한글이름} {직책} [{영문이름}]"
 * (e.g. "조준희 매니저 [JO JUN HEE]") — the bracketed English name is dropped, since the
 * nickname only needs the Korean name + title.
 */
function parseDisplayName(preferredUsername: unknown): string | null {
  if (typeof preferredUsername !== "string") {
    return null;
  }
  const bracketIndex = preferredUsername.indexOf("[");
  const withoutBracket = bracketIndex === -1 ? preferredUsername : preferredUsername.slice(0, bracketIndex);
  const trimmed = withoutBracket.trim();
  return trimmed.length > 0 ? trimmed : null;
}
