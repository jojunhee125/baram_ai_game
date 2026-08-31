import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { AVATAR_SKIN_COUNT } from "@zep-test/shared";
import express from "express";
import type { ProfileStore } from "../db/profileStore";
import { markDatabaseDegraded, markDatabaseOk, resetDatabaseStatus } from "../db/status";
import { markReady, markUnhealthy, resetReadiness } from "./readiness";
import { configureHttpRoutes } from "./routes";

/**
 * Its own express app on an ephemeral port, like routes.test.ts: the fixed ports in this
 * workspace are already contended (see the report on 2573), and nothing here needs one.
 */
const PROFILE_PATH = "/api/profile";

/** Two different accounts, so "stored under the right key" is a checkable claim. */
const SUB_A = "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e10";
const SUB_B = "7c2b4d55-1e3f-4a88-b0d2-9f6e5c4a3b21";

/** What the compose healthcheck greps for. A `db` field must not have moved it. */
const HEALTHCHECK_GREP = '"ok":true';

interface RawResponse {
  status: number;
  body: string;
}

/**
 * A store the test drives directly: reads come from `skins`, and either verb can be made to
 * reject, which is the only way to reach the route's 503 and its null-on-read fallback.
 */
class ScriptedProfileStore implements ProfileStore {
  readonly skins = new Map<string, number>();
  readonly writes: { ownerKey: string; avatarSkin: number }[] = [];
  readonly reads: string[] = [];
  failReads = false;
  failWrites = false;

  getAvatarSkin(ownerKey: string): Promise<number | null> {
    this.reads.push(ownerKey);
    if (this.failReads) {
      return Promise.reject(new Error("connection terminated unexpectedly"));
    }
    return Promise.resolve(this.skins.get(ownerKey) ?? null);
  }

  setAvatarSkin(ownerKey: string, avatarSkin: number): Promise<void> {
    if (this.failWrites) {
      return Promise.reject(new Error("connection terminated unexpectedly"));
    }
    this.writes.push({ ownerKey, avatarSkin });
    this.skins.set(ownerKey, avatarSkin);
    return Promise.resolve();
  }
}

let server: Server;
let port: number;
let store: ScriptedProfileStore;

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

function tokenHeader(sub: string): OutgoingHttpHeaders {
  return { "x-auth-request-access-token": jwtWithClaims({ sub }) };
}

/**
 * Raw `node:http` rather than `fetch`, for the same reason routes.test.ts uses it: several
 * cases below depend on bytes undici would normalise — a header sent twice, a body that is
 * not JSON at all, a body larger than the parser's limit.
 */
function send(options: {
  method?: string;
  path: string;
  headers?: OutgoingHttpHeaders;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function postProfile(body: string, headers?: OutgoingHttpHeaders): Promise<RawResponse> {
  return send({
    method: "POST",
    path: PROFILE_PATH,
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

before(async () => {
  const app = express();
  store = new ScriptedProfileStore();
  configureHttpRoutes(app, store);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  resetReadiness();
  resetDatabaseStatus();
  store.skins.clear();
  store.writes.length = 0;
  store.reads.length = 0;
  store.failReads = false;
  store.failWrites = false;
});

describe("GET /api/profile", () => {
  it("answers the stored skin for the account the token names", async () => {
    store.skins.set(SUB_A, 17);
    const response = await send({ path: PROFILE_PATH, headers: tokenHeader(SUB_A) });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: 17 });
    assert.deepEqual(store.reads, [SUB_A], "the sub claim is the key it looked under");
  });

  it("answers null for an account that never chose", async () => {
    const response = await send({ path: PROFILE_PATH, headers: tokenHeader(SUB_A) });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: null });
  });

  it("does not hand one account another account's skin", async () => {
    store.skins.set(SUB_B, 5);
    const response = await send({ path: PROFILE_PATH, headers: tokenHeader(SUB_A) });
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: null });
  });

  it("answers 0 as 0, not as 'never chose'", async () => {
    store.skins.set(SUB_A, 0);
    const response = await send({ path: PROFILE_PATH, headers: tokenHeader(SUB_A) });
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: 0 });
  });

  it("answers 200 with null and never a 4xx when there is no SSO identity", async () => {
    // A 401 here would read as "not signed in" to oauth2-proxy and start an SSO redirect loop,
    // which is the same reason /api/health always answers 200.
    const response = await send({ path: PROFILE_PATH });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: null });
    assert.deepEqual(store.reads, [], "no identity means there is nothing to look up");
  });

  it("answers 200 with null for a token the gateway sent but that carries no sub", async () => {
    const response = await send({
      path: PROFILE_PATH,
      headers: { "x-auth-request-access-token": jwtWithClaims({ preferred_username: "조준희 매니저" }) },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: null });
    assert.deepEqual(store.reads, []);
  });

  it("ignores an empty access-token header rather than treating it as an identity", async () => {
    const response = await send({
      path: PROFILE_PATH,
      headers: { "x-auth-request-access-token": "   " },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: null });
    assert.deepEqual(store.reads, []);
  });

  it("answers 200 with null when the store fails, so character select still opens", async () => {
    store.failReads = true;
    const response = await send({ path: PROFILE_PATH, headers: tokenHeader(SUB_A) });
    assert.equal(response.status, 200, "a failed read must not hold the boot behind an error");
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: null });
  });
});

describe("POST /api/profile", () => {
  it("stores the skin under the sub claim and echoes it", async () => {
    const response = await postProfile(JSON.stringify({ avatarSkin: 13 }), tokenHeader(SUB_A));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: 13 });
    assert.deepEqual(store.writes, [{ ownerKey: SUB_A, avatarSkin: 13 }]);
  });

  it("round-trips through GET", async () => {
    await postProfile(JSON.stringify({ avatarSkin: 21 }), tokenHeader(SUB_A));
    const read = await send({ path: PROFILE_PATH, headers: tokenHeader(SUB_A) });
    assert.deepEqual(JSON.parse(read.body), { avatarSkin: 21 });
  });

  it("accepts both ends of the sheet", async () => {
    for (const skin of [0, AVATAR_SKIN_COUNT - 1]) {
      const response = await postProfile(JSON.stringify({ avatarSkin: skin }), tokenHeader(SUB_A));
      assert.equal(response.status, 200, `skin ${skin}`);
      assert.deepEqual(JSON.parse(response.body), { avatarSkin: skin });
    }
  });

  it("answers 200 without storing anything when there is no SSO identity", async () => {
    const response = await postProfile(JSON.stringify({ avatarSkin: 4 }));
    assert.equal(response.status, 200, "the choice is valid and the session keeps using it");
    assert.deepEqual(JSON.parse(response.body), { avatarSkin: 4 });
    assert.deepEqual(store.writes, [], "there is no account to file it under");
  });

  it("answers 503 when the store cannot persist, rather than a 200 it never earned", async () => {
    store.failWrites = true;
    const response = await postProfile(JSON.stringify({ avatarSkin: 8 }), tokenHeader(SUB_A));
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: "profile store unavailable" });
  });

  it("rejects a value outside the sheet without writing", async () => {
    for (const skin of [-1, AVATAR_SKIN_COUNT, AVATAR_SKIN_COUNT + 100, -0.5]) {
      const response = await postProfile(JSON.stringify({ avatarSkin: skin }), tokenHeader(SUB_A));
      assert.equal(response.status, 400, `skin ${skin}`);
      assert.match(String(JSON.parse(response.body).error), /avatarSkin must be an integer/);
    }
    assert.deepEqual(store.writes, []);
  });

  it("rejects a non-integer, a non-number and a missing field", async () => {
    const bodies = [
      { avatarSkin: 3.5 },
      { avatarSkin: "3" },
      { avatarSkin: null },
      { avatarSkin: true },
      { avatarSkin: [3] },
      { avatarSkin: { value: 3 } },
      {},
      { skin: 3 },
    ];
    for (const body of bodies) {
      const response = await postProfile(JSON.stringify(body), tokenHeader(SUB_A));
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(store.writes, []);
  });

  it("rejects NaN and Infinity, which JSON smuggles through as null", async () => {
    for (const raw of ['{"avatarSkin":NaN}', '{"avatarSkin":Infinity}', '{"avatarSkin":1e400}']) {
      const response = await postProfile(raw, tokenHeader(SUB_A));
      assert.equal(response.status, 400, raw);
    }
    assert.deepEqual(store.writes, []);
  });

  it("rejects a body that is valid JSON but not an object", async () => {
    for (const raw of ["null", '"13"', "13", "[13]", "true"]) {
      const response = await postProfile(raw, tokenHeader(SUB_A));
      assert.equal(response.status, 400, raw);
    }
    assert.deepEqual(store.writes, []);
  });

  it("answers a parse failure with JSON, not express' HTML stack trace", async () => {
    // The default error handler renders the error page with absolute filesystem paths in it,
    // on a route whose caller only ever parses JSON.
    const response = await postProfile("{not json");
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "body must be a JSON object" });
    assert.doesNotMatch(response.body, /<html|Error:|at .*\.ts:/i, "no stack trace on the wire");
  });

  it("answers an oversized body the same way, without reading all of it", async () => {
    const response = await postProfile(JSON.stringify({ avatarSkin: 3, padding: "x".repeat(20_000) }));
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { error: "body must be a JSON object" });
    assert.deepEqual(store.writes, []);
  });

  it("answers 400 for a body sent with no content-type at all", async () => {
    const response = await send({
      method: "POST",
      path: PROFILE_PATH,
      headers: tokenHeader(SUB_A),
      body: JSON.stringify({ avatarSkin: 3 }),
    });
    // express.json() skips a body it was not told is JSON, leaving `request.body` undefined —
    // refusing is right, and silently storing a 0 would not be.
    assert.equal(response.status, 400);
    assert.deepEqual(store.writes, []);
  });

  it("validates the body before it looks for an identity", async () => {
    // Order matters for the caller: an out-of-range value must not answer 200 just because the
    // request happened to arrive without a token.
    const response = await postProfile(JSON.stringify({ avatarSkin: 999 }));
    assert.equal(response.status, 400);
  });

  it("reads the first value when the gateway sends the token header twice", async () => {
    const response = await postProfile(JSON.stringify({ avatarSkin: 6 }), {
      "x-auth-request-access-token": [jwtWithClaims({ sub: SUB_A }), jwtWithClaims({ sub: SUB_B })],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(store.writes, [{ ownerKey: SUB_A, avatarSkin: 6 }]);
  });

  it("never puts the access token in the response body", async () => {
    const token = jwtWithClaims({ sub: SUB_A });
    const response = await postProfile(JSON.stringify({ avatarSkin: 2 }), {
      "x-auth-request-access-token": token,
    });
    assert.doesNotMatch(response.body, /signature/, "the raw token must not be echoed");
    assert.equal(response.body.includes(token), false);
  });
});

describe("/api/health — the db field", () => {
  async function health(): Promise<{ raw: string; payload: Record<string, unknown> }> {
    const response = await send({ path: "/api/health" });
    assert.equal(response.status, 200);
    return { raw: response.body, payload: JSON.parse(response.body) as Record<string, unknown> };
  }

  it("reports 'disabled' for a server booted without DATABASE_URL", async () => {
    markReady();
    const { payload } = await health();
    assert.equal(payload["db"], "disabled");
    assert.equal(payload["ok"], true, "no database configured is a healthy state, not a fault");
  });

  it("reports 'ok' once a query has succeeded", async () => {
    markReady();
    markDatabaseOk();
    const { payload } = await health();
    assert.equal(payload["db"], "ok");
    assert.equal(payload["ok"], true);
  });

  it("keeps ok:true when the database is degraded — Coolify rolls back on a miss", async () => {
    // The single most expensive thing that can regress here: the compose healthcheck greps
    // '"ok":true', so flipping `ok` on a Postgres hiccup would take movement and chat down
    // with the deployment.
    markReady();
    markDatabaseDegraded(new Error("connection terminated unexpectedly"));
    const { raw, payload } = await health();
    assert.equal(payload["db"], "degraded");
    assert.equal(payload["ok"], true);
    assert.equal(payload["status"], "ok");
    assert.ok(raw.includes(HEALTHCHECK_GREP), `raw body must still contain ${HEALTHCHECK_GREP}`);
  });

  it("keeps the grep target intact in every db state", async () => {
    markReady();
    for (const mark of [resetDatabaseStatus, markDatabaseOk, () => markDatabaseDegraded("x")]) {
      mark();
      const { raw } = await health();
      assert.ok(raw.includes(HEALTHCHECK_GREP), `missing ${HEALTHCHECK_GREP} in ${raw}`);
    }
  });

  it("reports the db field independently of readiness", async () => {
    // An unhealthy map load and a degraded database are different faults; the payload has to
    // be able to say so, or a rollback decision cannot tell them apart.
    markUnhealthy('map "plaza" failed to load');
    markDatabaseOk();
    const { raw, payload } = await health();
    assert.equal(payload["ok"], false);
    assert.equal(payload["db"], "ok");
    assert.equal(raw.includes(HEALTHCHECK_GREP), false, "an unhealthy server must fail the probe");
  });

  it("still answers 200 with a db field while unhealthy", async () => {
    markUnhealthy('map "plaza" failed to load');
    markDatabaseDegraded("both at once");
    const { payload } = await health();
    assert.equal(payload["db"], "degraded");
    assert.equal(payload["ok"], false);
  });

  it("does not let a profile request against a failing store flip ok to false", async () => {
    markReady();
    store.failWrites = true;
    assert.equal((await postProfile(JSON.stringify({ avatarSkin: 1 }), tokenHeader(SUB_A))).status, 503);
    const { raw, payload } = await health();
    assert.equal(payload["ok"], true);
    assert.ok(raw.includes(HEALTHCHECK_GREP));
  });
});
