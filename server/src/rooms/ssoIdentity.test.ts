import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSsoNickname, deriveSsoUserId } from "./ssoIdentity";

const SUB = "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e10";

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

describe("deriveSsoUserId", () => {
  it("reads the sub claim", () => {
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: SUB })), SUB);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: `  ${SUB}  ` })), SUB);
  });

  it("returns null for no token at all — the local-development case", () => {
    assert.equal(deriveSsoUserId(null), null);
  });

  it("returns null when the token carries no sub", () => {
    assert.equal(deriveSsoUserId(jwtWithClaims({ preferred_username: "조준희 매니저" })), null);
  });

  it("returns null when sub is not a string", () => {
    for (const sub of [42, null, true, { id: SUB }, [SUB]]) {
      assert.equal(deriveSsoUserId(jwtWithClaims({ sub })), null, `sub=${JSON.stringify(sub)}`);
    }
  });

  it("returns null for an empty or whitespace-only sub", () => {
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: "" })), null);
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: "   " })), null);
  });

  it("returns null for a malformed token instead of throwing", () => {
    for (const token of ["", "not-a-jwt", "header.%%%.sig", "..", "header."]) {
      assert.equal(deriveSsoUserId(token), null, `token=${JSON.stringify(token)}`);
    }
  });

  it("returns null when the payload decodes to something that is not an object", () => {
    const payload = Buffer.from(JSON.stringify("just a string")).toString("base64url");
    assert.equal(deriveSsoUserId(`header.${payload}.sig`), null);
  });

  it("never falls back to x-auth-request-user, even when sub is the only thing missing", () => {
    // The core decision of design §2.5: two sources for one key means that the day they
    // disagree, a user's saved data looks deleted and nothing in the logs says why. The
    // function takes a token string precisely so no header can reach it — this is the
    // executable form of that argument, and it fails the moment a fallback is added.
    const gatewayUuid = "9b7e6d5c-4a3b-2c1d-0e9f-8a7b6c5d4e3f";
    const token = jwtWithClaims({ preferred_username: "조준희 매니저", email: "u@kyungshin.co.kr" });
    assert.equal(deriveSsoUserId(token), null, "a token without sub yields no key at all");

    // The same UUID the gateway would have supplied is inert here: it can only be read from a
    // `sub` claim, never from the header the room's onAuth also sees.
    assert.equal(deriveSsoUserId(gatewayUuid), null, "a bare UUID is not a token and is not a key");
  });

  it("does not confuse the nickname claim with the account key", () => {
    const token = jwtWithClaims({ sub: SUB, preferred_username: "조준희 매니저 [JO JUN HEE]" });
    assert.equal(deriveSsoUserId(token), SUB);
    assert.equal(deriveSsoNickname(headersWithToken(token)), "조준희 매니저");
  });

  it("treats a sub that is not a UUID as no identity at all", () => {
    // A service account's sub is its name, not a UUID. Letting it through reached the uuid
    // `owner_key` column as a `22P02`, which the store reports as a connection failure — that
    // one account loading the page was enough to pin `/api/health` at `db: "degraded"`.
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: "service-account-metaverse" })), null);
  });

  it("rejects UUID-adjacent shapes the uuid column would also refuse", () => {
    const nearMisses = [
      "1f0d1a9c6b7e4f2a9c310c4c2a5b8e10", // unhyphenated 32 hex
      `{${SUB}}`, // brace-wrapped
      SUB.slice(0, -1), // truncated
      `${SUB}0`, // one hex digit too many
      "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e1g", // non-hex character
      "1f0d1a9c_6b7e_4f2a_9c31_0c4c2a5b8e10", // underscores for hyphens
    ];
    for (const sub of nearMisses) {
      assert.equal(deriveSsoUserId(jwtWithClaims({ sub })), null, `sub=${sub}`);
    }
  });

  it("accepts an uppercase UUID unchanged — Postgres normalises on storage, so this must not", () => {
    const upper = SUB.toUpperCase();
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: upper })), upper);
  });

  it("does not read the version and variant nibbles, because the uuid column does not either", () => {
    // Stricter than the database is its own failure mode: it would reject a key Postgres
    // stores happily, and the rejection would look like a signed-in user with no saved data.
    const nonRfcVariant = "1f0d1a9c-6b7e-0f2a-0c31-0c4c2a5b8e10";
    assert.equal(deriveSsoUserId(jwtWithClaims({ sub: nonRfcVariant })), nonRfcVariant);
  });
});
