import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { describe, it } from "node:test";
import { inspectForwardAuth, type ForwardAuthVerdict } from "./forwardAuth";

/**
 * The six names inspectForwardAuth reports, in the order it reports them. Duplicated from
 * the module rather than exported: the order is part of the contract Go/No-go PoC #1 reads,
 * so a reordering there has to fail here instead of silently changing the evidence.
 */
const IDENTITY_HEADER_NAMES = [
  "x-auth-request-email",
  "x-auth-request-preferred-username",
  "x-auth-request-user",
  "x-auth-request-access-token",
  "x-forwarded-user",
  "x-forwarded-email",
] as const;

/**
 * Distinctive enough that a substring search for it cannot collide with a header name, a
 * cookie name, or any JSON punctuation the verdict serialises to.
 */
const SECRET = "Zq7x-LEAKED-VALUE-9f3";

const EMPTY_VERDICT: ForwardAuthVerdict = {
  authenticated: false,
  identityHeaders: [],
  hasCookie: false,
  cookieNames: [],
};

/** The only channel the verdict can leak through is its serialised form. */
function serialised(headers: IncomingHttpHeaders): string {
  return JSON.stringify(inspectForwardAuth(headers));
}

describe("inspectForwardAuth — identity headers", () => {
  it("reports nothing for an empty header bag", () => {
    assert.deepEqual(inspectForwardAuth({}), EMPTY_VERDICT);
  });

  it("reports nothing when only unrelated headers arrive", () => {
    const verdict = inspectForwardAuth({
      host: "zep.example.com",
      "user-agent": "probe/1.0",
      accept: "*/*",
      connection: "keep-alive",
    });
    assert.deepEqual(verdict, EMPTY_VERDICT);
  });

  it("recognises each identity header on its own", () => {
    for (const name of IDENTITY_HEADER_NAMES) {
      const verdict = inspectForwardAuth({ [name]: "value" });
      assert.deepEqual(
        verdict,
        { authenticated: true, identityHeaders: [name], hasCookie: false, cookieNames: [] },
        `${name} must be recognised alone`,
      );
    }
  });

  it("authenticates on a single identity header among unrelated ones", () => {
    const verdict = inspectForwardAuth({
      host: "zep.example.com",
      "x-auth-request-email": "user@kyungshin.co.kr",
      "x-forwarded-for": "10.0.0.1",
    });
    assert.equal(verdict.authenticated, true);
    assert.deepEqual(verdict.identityHeaders, ["x-auth-request-email"]);
  });

  it("lists every identity header in allowlist order, not arrival order", () => {
    // Inserted back to front: object key order would otherwise show through.
    const headers: IncomingHttpHeaders = {};
    for (const name of [...IDENTITY_HEADER_NAMES].reverse()) {
      headers[name] = `${SECRET}/${name}`;
    }
    assert.deepEqual(inspectForwardAuth(headers).identityHeaders, [...IDENTITY_HEADER_NAMES]);
  });

  it("ignores oauth2-proxy headers outside the allowlist", () => {
    // Documents the current scope: groups and the non-prefixed username are not evidence.
    const verdict = inspectForwardAuth({
      "x-auth-request-groups": "zep-users",
      "x-forwarded-groups": "zep-users",
      "x-forwarded-preferred-username": "junhui125",
      "x-consumer-username": "junhui125",
      authorization: "Bearer token",
    });
    assert.deepEqual(verdict, EMPTY_VERDICT);
  });
});

describe("inspectForwardAuth — empty and whitespace values", () => {
  it("treats an empty string as no value", () => {
    // A gateway that forwards the header but not the value must not read as authenticated.
    assert.deepEqual(inspectForwardAuth({ "x-auth-request-email": "" }), EMPTY_VERDICT);
  });

  it("treats a whitespace-only value as no value", () => {
    for (const blank of [" ", "   ", "\t", "\n", "\r\n", " \t \n "]) {
      assert.deepEqual(
        inspectForwardAuth({ "x-forwarded-user": blank }),
        EMPTY_VERDICT,
        `${JSON.stringify(blank)} is not a value`,
      );
    }
  });

  it("keeps a value that is only surrounded by whitespace", () => {
    const verdict = inspectForwardAuth({ "x-auth-request-user": "  u  " });
    assert.equal(verdict.authenticated, true);
    assert.deepEqual(verdict.identityHeaders, ["x-auth-request-user"]);
  });

  it("counts a single non-blank member of a repeated header", () => {
    // A header repeated by a proxy is typed as string[]; node's own parser joins duplicates
    // into one string, so this branch only fires for a hand-built or non-node header bag.
    const verdict = inspectForwardAuth({ "x-forwarded-user": ["", "  ", "u"] });
    assert.equal(verdict.authenticated, true);
    assert.deepEqual(verdict.identityHeaders, ["x-forwarded-user"]);
  });

  it("treats an all-blank repeated header as no value", () => {
    assert.deepEqual(inspectForwardAuth({ "x-forwarded-user": ["", "  "] }), EMPTY_VERDICT);
  });

  it("treats an empty array as no value", () => {
    assert.deepEqual(inspectForwardAuth({ "x-forwarded-email": [] }), EMPTY_VERDICT);
  });

  it("treats the comma-joined form node produces for duplicates as one value", () => {
    // What actually arrives when a proxy sends the header twice — verified against a real
    // node HTTP server in routes.test.ts.
    const verdict = inspectForwardAuth({ "x-auth-request-email": "a@b.c, a@b.c" });
    assert.equal(verdict.authenticated, true);
  });
});

describe("inspectForwardAuth — cookie names", () => {
  it("reports no cookie when the header is absent", () => {
    assert.equal(inspectForwardAuth({}).hasCookie, false);
    assert.deepEqual(inspectForwardAuth({}).cookieNames, []);
  });

  it("reports the oauth2-proxy session cookie by name only", () => {
    const verdict = inspectForwardAuth({ cookie: `_oauth2_proxy=${SECRET}` });
    assert.equal(verdict.hasCookie, true);
    assert.deepEqual(verdict.cookieNames, ["_oauth2_proxy"]);
  });

  it("splits several cookies", () => {
    const verdict = inspectForwardAuth({ cookie: "a=1; b=2; c=3" });
    assert.deepEqual(verdict.cookieNames, ["a", "b", "c"]);
  });

  it("cuts at the first = so a value carrying more of them stays out", () => {
    const verdict = inspectForwardAuth({ cookie: `jwt=aaa=${SECRET}=ccc; plain=1` });
    assert.deepEqual(verdict.cookieNames, ["jwt", "plain"]);
  });

  it("keeps base64 padding out of the names", () => {
    const verdict = inspectForwardAuth({ cookie: `_oauth2_proxy=${SECRET}==` });
    assert.deepEqual(verdict.cookieNames, ["_oauth2_proxy"]);
  });

  it("trims whitespace around names", () => {
    const verdict = inspectForwardAuth({ cookie: "   a=1;   b=2  ;\tc=3" });
    assert.deepEqual(verdict.cookieNames, ["a", "b", "c"]);
  });

  it("reports the chunked session cookies oauth2-proxy emits", () => {
    const verdict = inspectForwardAuth({
      cookie: `_oauth2_proxy_0=${SECRET}; _oauth2_proxy_1=${SECRET}; __Host-csrf=${SECRET}`,
    });
    assert.deepEqual(verdict.cookieNames, ["_oauth2_proxy_0", "_oauth2_proxy_1", "__Host-csrf"]);
  });

  it("de-duplicates a repeated cookie name", () => {
    assert.deepEqual(inspectForwardAuth({ cookie: "a=1; a=2; a=3" }).cookieNames, ["a"]);
  });

  it("drops a nameless cookie instead of reporting its value", () => {
    assert.deepEqual(inspectForwardAuth({ cookie: `=${SECRET}; a=1` }).cookieNames, ["a"]);
  });

  it("tolerates trailing and repeated separators", () => {
    assert.deepEqual(inspectForwardAuth({ cookie: "a=1;" }).cookieNames, ["a"]);
    assert.deepEqual(inspectForwardAuth({ cookie: ";; a=1 ;;" }).cookieNames, ["a"]);
    assert.deepEqual(inspectForwardAuth({ cookie: ";;;" }).cookieNames, []);
  });

  it("treats an empty or blank cookie header as no cookie", () => {
    for (const blank of ["", "   ", "\t"]) {
      const verdict = inspectForwardAuth({ cookie: blank });
      assert.equal(verdict.hasCookie, false, `${JSON.stringify(blank)} is not a cookie`);
      assert.deepEqual(verdict.cookieNames, []);
    }
  });

  it("returns no names when a repeated cookie header arrives as an array", () => {
    // node joins duplicate Cookie headers with "; " before this function sees them, so the
    // array shape only reaches here from a non-node header bag. Names are unavailable then,
    // and the important half is that no value is reported either.
    const headers = { cookie: [`a=${SECRET}`, `b=${SECRET}`] } as unknown as IncomingHttpHeaders;
    const verdict = inspectForwardAuth(headers);
    assert.deepEqual(verdict.cookieNames, []);
    assert.ok(!JSON.stringify(verdict).includes(SECRET));
  });
});

describe("inspectForwardAuth — no value ever reaches the verdict", () => {
  it("keeps every identity header value out of the serialised verdict", () => {
    const headers: IncomingHttpHeaders = {};
    for (const name of IDENTITY_HEADER_NAMES) {
      headers[name] = `${SECRET}/${name}`;
    }
    const json = serialised(headers);
    assert.ok(!json.includes(SECRET), `identity header value leaked into ${json}`);
  });

  it("keeps an access token out of the serialised verdict", () => {
    const json = serialised({ "x-auth-request-access-token": `eyJhbGciOi.${SECRET}.sig` });
    assert.ok(!json.includes(SECRET), `access token leaked into ${json}`);
    assert.ok(!json.includes("eyJhbGciOi"), `access token leaked into ${json}`);
  });

  it("keeps an email out of the serialised verdict", () => {
    const json = serialised({ "x-auth-request-email": "junhui125@kyungshin.co.kr" });
    assert.ok(!json.includes("junhui125"), `PII leaked into ${json}`);
    assert.ok(!json.includes("@"), `PII leaked into ${json}`);
  });

  it("keeps cookie values out of the serialised verdict across every cookie shape", () => {
    const cookies = [
      `_oauth2_proxy=${SECRET}`,
      `_oauth2_proxy=${SECRET}; csrf=${SECRET}`,
      `jwt=a=${SECRET}=b`,
      `padded=${SECRET}==`,
      `  spaced  =  ${SECRET}  `,
      `=${SECRET}`,
      `a=1; =${SECRET}; b=2`,
      `quoted="${SECRET}"`,
      `semi=${SECRET};;`,
      `unicode=${SECRET}é`,
    ];
    for (const cookie of cookies) {
      const json = serialised({ cookie });
      assert.ok(!json.includes(SECRET), `cookie ${JSON.stringify(cookie)} leaked into ${json}`);
    }
  });

  it("keeps values of headers outside the allowlist out of the verdict", () => {
    const json = serialised({
      authorization: `Bearer ${SECRET}`,
      "x-auth-request-groups": SECRET,
      [`x-custom-${SECRET}`]: SECRET,
      "x-auth-request-email": "u@e.com",
    });
    assert.ok(!json.includes(SECRET), `unrelated header leaked into ${json}`);
  });

  it("keeps a value out of the verdict when a cookie segment has no name at all", () => {
    // The module's contract is absolute — "nothing here ever returns a value". A segment
    // with no "=" is not a cookie-pair (RFC 6265 §4.2.1) and carries no name to report, so
    // the whole segment is a value.
    const verdict = inspectForwardAuth({ cookie: `_oauth2_proxy=session; ${SECRET}` });
    assert.ok(
      !JSON.stringify(verdict).includes(SECRET),
      `a cookie segment without "=" was reported verbatim: ${JSON.stringify(verdict)}`,
    );
  });
});

describe("inspectForwardAuth — purity", () => {
  it("returns the same verdict for the same headers", () => {
    const headers: IncomingHttpHeaders = {
      "x-auth-request-email": "u@e.com",
      cookie: "_oauth2_proxy=abc",
    };
    assert.deepEqual(inspectForwardAuth(headers), inspectForwardAuth(headers));
  });

  it("does not mutate the headers it was given", () => {
    const headers: IncomingHttpHeaders = {
      "x-auth-request-email": "u@e.com",
      "x-forwarded-user": ["a", "b"],
      cookie: "a=1; b=2",
    };
    const before = structuredClone(headers);
    inspectForwardAuth(headers);
    assert.deepEqual(headers, before);
  });

  it("hands back fresh arrays, so one caller cannot corrupt the next verdict", () => {
    const headers: IncomingHttpHeaders = { "x-auth-request-email": "u@e.com", cookie: "a=1" };
    const first = inspectForwardAuth(headers);
    first.identityHeaders.push("injected");
    first.cookieNames.push("injected");

    const second = inspectForwardAuth(headers);
    assert.deepEqual(second.identityHeaders, ["x-auth-request-email"]);
    assert.deepEqual(second.cookieNames, ["a"]);
  });
});

describe("inspectForwardAuth — header name casing", () => {
  it("does not recognise a header whose name is not lower-cased", () => {
    // node's HTTP parser lower-cases every incoming header name, which routes.test.ts
    // verifies against a real server. This locks the assumption the lookup depends on: a
    // header bag built by hand with wire casing reads as unauthenticated.
    const headers = {
      "X-Auth-Request-Email": "u@e.com",
      "X-Forwarded-User": "u",
      Cookie: "_oauth2_proxy=abc",
    } as unknown as IncomingHttpHeaders;
    assert.deepEqual(inspectForwardAuth(headers), EMPTY_VERDICT);
  });
});

describe("inspectForwardAuth — Go/No-go PoC #1 caveat", () => {
  it("cannot tell a gateway-injected header from a client-supplied one", () => {
    // Nothing distinguishes the two at this layer, so the PoC verdict is only meaningful
    // when the probing client sends none of these headers itself. Locked as a test so the
    // limitation stays visible to whoever reads the PoC result.
    const forgedByClient = inspectForwardAuth({ "x-auth-request-email": "attacker@evil.test" });
    assert.equal(forgedByClient.authenticated, true);
  });
});
