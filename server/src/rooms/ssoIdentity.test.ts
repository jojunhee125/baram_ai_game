import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSsoNickname } from "./ssoIdentity";

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

function headersWithToken(token: string | null): Headers {
  const headers = new Headers();
  if (token !== null) {
    headers.set("x-auth-request-access-token", token);
  }
  return headers;
}

describe("deriveSsoNickname", () => {
  it("strips the bracketed English name from preferred_username", () => {
    const token = jwtWithClaims({ preferred_username: "조준희 매니저 [JO JUN HEE]" });
    assert.equal(deriveSsoNickname(headersWithToken(token)), "조준희 매니저");
  });

  it("returns the whole trimmed string when there is no bracket", () => {
    const token = jwtWithClaims({ preferred_username: "  조준희 매니저  " });
    assert.equal(deriveSsoNickname(headersWithToken(token)), "조준희 매니저");
  });

  it("returns null when there is no access-token header", () => {
    assert.equal(deriveSsoNickname(headersWithToken(null)), null);
  });

  it("returns null for a malformed token", () => {
    assert.equal(deriveSsoNickname(headersWithToken("not-a-jwt")), null);
  });

  it("returns null when the token payload is not valid base64url JSON", () => {
    assert.equal(deriveSsoNickname(headersWithToken("header.%%%.sig")), null);
  });

  it("returns null when preferred_username is missing", () => {
    const token = jwtWithClaims({ email: "u@kyungshin.co.kr" });
    assert.equal(deriveSsoNickname(headersWithToken(token)), null);
  });

  it("returns null when preferred_username is not a string", () => {
    const token = jwtWithClaims({ preferred_username: 42 });
    assert.equal(deriveSsoNickname(headersWithToken(token)), null);
  });

  it("returns null when the bracket leaves nothing but whitespace", () => {
    const token = jwtWithClaims({ preferred_username: "   [JO JUN HEE]" });
    assert.equal(deriveSsoNickname(headersWithToken(token)), null);
  });
});
