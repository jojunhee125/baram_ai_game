import type { IncomingHttpHeaders } from "node:http";

/**
 * Headers the KAD gateway (Traefik ForwardAuth → oauth2-proxy/Keycloak) injects once a
 * request is authenticated. Their *values* are identity material — an email is PII and
 * the access token is a secret — so nothing here ever returns or logs a value. Only the
 * presence of a header is reported, which is all Go/No-go PoC #1 needs.
 */
const IDENTITY_HEADER_NAMES = [
  "x-auth-request-email",
  "x-auth-request-preferred-username",
  "x-auth-request-user",
  "x-auth-request-access-token",
  "x-forwarded-user",
  "x-forwarded-email",
] as const;

export interface ForwardAuthVerdict {
  /** True when at least one identity header arrived. */
  authenticated: boolean;
  /** Header names only, in {@link IDENTITY_HEADER_NAMES} order. */
  identityHeaders: string[];
  hasCookie: boolean;
  /** Cookie names only — enough to see whether the oauth2-proxy session cookie survived. */
  cookieNames: string[];
}

/** Pure: same headers in, same verdict out, no I/O and no module state. */
export function inspectForwardAuth(headers: IncomingHttpHeaders): ForwardAuthVerdict {
  const identityHeaders = IDENTITY_HEADER_NAMES.filter((name) => hasValue(headers[name]));
  const cookie = headers.cookie;
  return {
    authenticated: identityHeaders.length > 0,
    identityHeaders: [...identityHeaders],
    hasCookie: hasValue(cookie),
    cookieNames: parseCookieNames(cookie),
  };
}

/** A header repeated by a proxy arrives as an array, and an empty value is not a value. */
function hasValue(header: string | string[] | undefined): boolean {
  if (Array.isArray(header)) {
    return header.some((value) => value.trim().length > 0);
  }
  return typeof header === "string" && header.trim().length > 0;
}

function parseCookieNames(cookie: string | undefined): string[] {
  if (typeof cookie !== "string") {
    return [];
  }
  const names = new Set<string>();
  for (const pair of cookie.split(";")) {
    const separator = pair.indexOf("=");
    // A segment without "=" is not a cookie-pair (RFC 6265 §4.2.1). It carries no name,
    // only value material, so reporting it as a name would leak exactly what this module
    // promises never to return — and the probe snapshot is process-global, so it would
    // leak to whoever calls the diagnostic next.
    if (separator === -1) {
      continue;
    }
    // Split on the first "=" only: a cookie *value* may contain more of them, and
    // everything after that separator must stay out of the response.
    const name = pair.slice(0, separator).trim();
    if (name.length > 0) {
      names.add(name);
    }
  }
  return [...names];
}
