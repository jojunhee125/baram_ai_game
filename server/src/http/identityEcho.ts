import type { IncomingHttpHeaders } from "node:http";

/**
 * TEMPORARY diagnostic — echoes this request's own SSO identity headers and decoded
 * access-token claims back to the caller, to find out what Keycloak actually puts in them
 * (title/department claim? what does "user" vs "preferred-username" hold?). Remove once
 * that's confirmed; see docs/decisions.md.
 */
export interface IdentityEcho {
  email: string | null;
  preferredUsername: string | null;
  user: string | null;
  accessTokenClaims: Record<string, unknown> | null;
}

export function echoIdentity(headers: IncomingHttpHeaders): IdentityEcho {
  return {
    email: firstValue(headers["x-auth-request-email"]),
    preferredUsername: firstValue(headers["x-auth-request-preferred-username"]),
    user: firstValue(headers["x-auth-request-user"]),
    accessTokenClaims: decodeJwtClaims(firstValue(headers["x-auth-request-access-token"])),
  };
}

function firstValue(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** No signature check: this only re-displays a claim to the same user the gateway already
 *  authenticated as, it never authorizes anything. */
function decodeJwtClaims(token: string | null): Record<string, unknown> | null {
  if (token === null) {
    return null;
  }
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
