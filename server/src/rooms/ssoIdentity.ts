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
