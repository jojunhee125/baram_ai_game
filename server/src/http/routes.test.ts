import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { ROOM_DEFINITIONS } from "../rooms/definitions";
import { getUnhealthyReason, markReady, markUnhealthy, resetReadiness } from "./readiness";
import { configureHttpRoutes } from "./routes";
import {
  getWsAuthProbeSnapshot,
  observeWebSocketUpgrade,
  resetWsAuthProbe,
  type WsAuthProbeSnapshot,
} from "./wsAuthProbe";

const SECRET = "Zq7x-LEAKED-VALUE-9f3";

/**
 * The literal the compose healthcheck greps for:
 *   curl -fsS http://127.0.0.1:8080/api/health | grep -q '"ok":true'
 * A pretty-printer or a renamed field breaks the container probe without breaking any
 * assertion about the parsed payload, so the raw bytes are checked too.
 */
const HEALTHCHECK_GREP = '"ok":true';

/** Stands in for the `/matchmake/*` routes Colyseus registers after this callback runs. */
const MATCHMAKE_MARKER = "matchmake-route-was-reached";
/** Stands in for any other route registered after `configureHttpRoutes`. */
const LATE_ROUTE_MARKER = "late-route-was-reached";

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface HealthPayload {
  status: string;
  ok: boolean;
  uptimeSeconds: number;
  rooms: string[];
  reason?: string;
}

interface DiagnosticPayload {
  observedAt: string;
  thisRequest: {
    authenticated: boolean;
    identityHeaders: string[];
    hasCookie: boolean;
    cookieNames: string[];
  };
  lastHttpRequest: WsAuthProbeSnapshot["lastHttpRequest"];
  lastWebSocketUpgrade: WsAuthProbeSnapshot["lastWebSocketUpgrade"];
}

let server: Server;
let port: number;

/**
 * Raw `node:http` rather than `fetch`: the tests below depend on exactly what goes onto
 * the wire — header name casing, a header sent twice, a cookie a URL parser would mangle —
 * and undici normalises several of those before they leave the process.
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
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
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

async function getHealth(): Promise<{ response: RawResponse; payload: HealthPayload }> {
  const response = await send({ path: "/api/health" });
  return { response, payload: JSON.parse(response.body) as HealthPayload };
}

async function getDiagnostic(
  headers?: OutgoingHttpHeaders,
): Promise<{ response: RawResponse; payload: DiagnosticPayload }> {
  const response = await send({ path: "/api/diag/ws-auth", headers });
  return { response, payload: JSON.parse(response.body) as DiagnosticPayload };
}

before(async () => {
  const app = express();
  configureHttpRoutes(app);

  // Registered *after* `configureHttpRoutes`, exactly like Colyseus' matchmaking routes.
  // Anything the static handler swallows never reaches these.
  app.post("/matchmake/:method/:roomName", (request, response) => {
    response.status(200).json({ marker: MATCHMAKE_MARKER, roomName: request.params.roomName });
  });
  app.get("/matchmake/:method/:roomName", (_request, response) => {
    response.status(200).json({ marker: MATCHMAKE_MARKER });
  });
  app.get("/late/route", (_request, response) => {
    response.status(200).json({ marker: LATE_ROUTE_MARKER });
  });
  app.post("/late/route", (_request, response) => {
    response.status(200).json({ marker: LATE_ROUTE_MARKER });
  });

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
  resetWsAuthProbe();
});

describe("GET /api/health — status code", () => {
  it("answers 200 when the server is ready", async () => {
    markReady();
    const { response } = await getHealth();
    assert.equal(response.status, 200);
  });

  it("answers 200 when the server is unhealthy, never 503", async () => {
    // A 401/403/503 from this path reads as "not signed in" to oauth2-proxy behind the KAD
    // gateway and sends the container probe into an SSO redirect loop.
    markUnhealthy('map "plaza" failed to load');
    const { response } = await getHealth();
    assert.equal(response.status, 200);
  });

  it("answers 200 during the boot window, before anything has been validated", async () => {
    assert.notEqual(getUnhealthyReason(), null, "precondition: still in the boot window");
    const { response } = await getHealth();
    assert.equal(response.status, 200);
  });

  it("answers 200 to HEAD as well, which is what a bare probe may send", async () => {
    markReady();
    const response = await send({ method: "HEAD", path: "/api/health" });
    assert.equal(response.status, 200);
  });

  it("serves JSON", async () => {
    markReady();
    const { response } = await getHealth();
    assert.match(String(response.headers["content-type"]), /application\/json/);
  });

  it("also answers a trailing slash and a differently cased path", async () => {
    // Express matches loosely by default. Worth pinning: the compose healthcheck and the
    // `kad.public_paths` label spell the path exactly, and a probe URL that quietly 404s
    // would roll a healthy deployment back.
    markReady();
    for (const path of ["/api/health", "/api/health/", "/API/Health"]) {
      const response = await send({ path });
      assert.equal(response.status, 200, `${path} answered ${response.status}`);
      assert.ok(response.body.includes(HEALTHCHECK_GREP), `${path} body was ${response.body}`);
    }
  });
});

describe("GET /api/health — payload", () => {
  it("reports ok:true and no reason when ready", async () => {
    markReady();
    const { payload } = await getHealth();
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "ok");
    assert.equal("reason" in payload, false, "a healthy server explains nothing");
  });

  it("reports ok:false with a reason when unhealthy", async () => {
    markUnhealthy('map "plaza" failed to load');
    const { payload } = await getHealth();
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "degraded");
    assert.equal(payload.reason, 'map "plaza" failed to load');
  });

  it("reports the boot-window reason before startup checks finish", async () => {
    const { payload } = await getHealth();
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, getUnhealthyReason());
  });

  it("lists the rooms the definition table registers", async () => {
    markReady();
    const { payload } = await getHealth();
    assert.deepEqual(
      payload.rooms,
      ROOM_DEFINITIONS.map((definition) => definition.name),
    );
  });

  it("reports uptime as a whole non-negative number of seconds", async () => {
    markReady();
    const { payload } = await getHealth();
    assert.equal(typeof payload.uptimeSeconds, "number");
    assert.ok(Number.isInteger(payload.uptimeSeconds), "uptimeSeconds must be an integer");
    assert.ok(payload.uptimeSeconds >= 0);
  });

  it("still reports ok:false when the reason is an empty string", async () => {
    // The route branches on `reason === null`; a truthiness check here would call an
    // unhealthy server healthy.
    markUnhealthy("");
    const { payload } = await getHealth();
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "degraded");
    assert.equal(payload.reason, "");
  });
});

describe("GET /api/health — the literal bytes the container healthcheck greps", () => {
  it('emits "ok":true verbatim, with no space after the colon', async () => {
    markReady();
    const { response } = await getHealth();
    assert.ok(
      response.body.includes(HEALTHCHECK_GREP),
      `compose healthcheck greps ${HEALTHCHECK_GREP}; body was ${response.body}`,
    );
  });

  it('emits "ok":false and never "ok":true when unhealthy', async () => {
    markUnhealthy("degraded on purpose");
    const { response } = await getHealth();
    assert.ok(response.body.includes('"ok":false'), `body was ${response.body}`);
    assert.ok(
      !response.body.includes(HEALTHCHECK_GREP),
      `a degraded server must not satisfy the healthcheck grep; body was ${response.body}`,
    );
  });

  it("never puts the grep literal into the degraded body through another field", async () => {
    // `status:"ok"` serialises as `"status":"ok"`, which must not be mistaken for a match.
    markUnhealthy('reason mentioning "ok":true on purpose');
    const { response } = await getHealth();
    const payload = JSON.parse(response.body) as HealthPayload;
    assert.equal(payload.ok, false);
    // The reason is attacker-free (it comes from server.ts), so this only documents that a
    // reason string is the one place a false grep match could be introduced.
    assert.ok(response.body.includes('\\"ok\\":true'), "the reason is JSON-escaped");
  });
});

describe("GET /api/diag/ws-auth — always answers", () => {
  it("answers 200 with no headers at all", async () => {
    const { response, payload } = await getDiagnostic();
    assert.equal(response.status, 200);
    assert.equal(payload.thisRequest.authenticated, false);
  });

  it("answers 200 while the server is unhealthy", async () => {
    markUnhealthy("boot failed");
    const { response } = await getDiagnostic();
    assert.equal(response.status, 200);
  });

  it("serves JSON", async () => {
    const { response } = await getDiagnostic();
    assert.match(String(response.headers["content-type"]), /application\/json/);
  });

  it("stamps observedAt as an ISO string", async () => {
    const { payload } = await getDiagnostic();
    assert.equal(new Date(payload.observedAt).toISOString(), payload.observedAt);
  });

  it("reports nothing observed yet right after a reset", async () => {
    const { payload } = await getDiagnostic();
    assert.equal(payload.lastHttpRequest, null);
    assert.equal(payload.lastWebSocketUpgrade, null);
  });

  it("reports the last websocket upgrade the server saw", async () => {
    observeWebSocketUpgrade({ "x-auth-request-email": "u@example.com", cookie: "_oauth2_proxy=x" });
    const { payload } = await getDiagnostic();
    assert.equal(payload.lastWebSocketUpgrade?.verdict.authenticated, true);
    assert.deepEqual(payload.lastWebSocketUpgrade?.verdict.identityHeaders, [
      "x-auth-request-email",
    ]);
    assert.deepEqual(payload.lastWebSocketUpgrade?.verdict.cookieNames, ["_oauth2_proxy"]);
  });
});

describe("GET /api/diag/ws-auth — header propagation is reported by name", () => {
  it("sees a header sent with wire casing, because node lower-cases incoming names", async () => {
    // The whole lookup in forwardAuth.ts is lower-case; this is the assumption behind it.
    const { payload } = await getDiagnostic({
      "X-Auth-Request-Email": "user@kyungshin.co.kr",
      "X-Forwarded-User": "user",
      Cookie: "_oauth2_proxy=abc",
    });
    assert.equal(payload.thisRequest.authenticated, true);
    assert.deepEqual(payload.thisRequest.identityHeaders, [
      "x-auth-request-email",
      "x-forwarded-user",
    ]);
    assert.deepEqual(payload.thisRequest.cookieNames, ["_oauth2_proxy"]);
  });

  it("reports every identity header the gateway forwards, in allowlist order", async () => {
    const { payload } = await getDiagnostic({
      "x-forwarded-email": "u@e.com",
      "x-forwarded-user": "u",
      "x-auth-request-access-token": "token",
      "x-auth-request-user": "u",
      "x-auth-request-preferred-username": "u",
      "x-auth-request-email": "u@e.com",
    });
    assert.deepEqual(payload.thisRequest.identityHeaders, [
      "x-auth-request-email",
      "x-auth-request-preferred-username",
      "x-auth-request-user",
      "x-auth-request-access-token",
      "x-forwarded-user",
      "x-forwarded-email",
    ]);
  });

  it("still authenticates when a proxy forwards the same header twice", async () => {
    // node joins duplicates into "a@b.c, d@e.f" before the route sees them.
    const { payload } = await getDiagnostic({
      "X-Auth-Request-Email": ["a@b.c", "d@e.f"],
    });
    assert.equal(payload.thisRequest.authenticated, true);
    assert.deepEqual(payload.thisRequest.identityHeaders, ["x-auth-request-email"]);
  });

  it("reads an empty header value as an absent one", async () => {
    const { payload } = await getDiagnostic({ "x-auth-request-email": "" });
    assert.equal(payload.thisRequest.authenticated, false);
    assert.deepEqual(payload.thisRequest.identityHeaders, []);
  });

  it("reports chunked oauth2-proxy cookies by name", async () => {
    const { payload } = await getDiagnostic({
      Cookie: "_oauth2_proxy_0=aaa; _oauth2_proxy_1=bbb; _oauth2_proxy_csrf=ccc",
    });
    assert.equal(payload.thisRequest.hasCookie, true);
    assert.deepEqual(payload.thisRequest.cookieNames, [
      "_oauth2_proxy_0",
      "_oauth2_proxy_1",
      "_oauth2_proxy_csrf",
    ]);
  });
});

describe("GET /api/diag/ws-auth — no value reaches the response body", () => {
  it("echoes no identity header value", async () => {
    const { response } = await getDiagnostic({
      "x-auth-request-email": `${SECRET}@example.com`,
      "x-auth-request-preferred-username": SECRET,
      "x-auth-request-user": SECRET,
      "x-auth-request-access-token": `eyJhbGciOi.${SECRET}.sig`,
      "x-forwarded-user": SECRET,
      "x-forwarded-email": `${SECRET}@example.com`,
    });
    assert.ok(!response.body.includes(SECRET), `a header value leaked: ${response.body}`);
  });

  it("echoes no cookie value", async () => {
    const { response } = await getDiagnostic({
      Cookie: `_oauth2_proxy=${SECRET}; csrf=a=${SECRET}=b; padded=${SECRET}==`,
    });
    assert.ok(!response.body.includes(SECRET), `a cookie value leaked: ${response.body}`);
    assert.ok(response.body.includes("_oauth2_proxy"), "cookie names are still reported");
  });

  it("echoes no value of a header outside the allowlist", async () => {
    const { response } = await getDiagnostic({
      authorization: `Bearer ${SECRET}`,
      "x-auth-request-groups": SECRET,
      "user-agent": SECRET,
      "x-forwarded-for": SECRET,
    });
    assert.ok(!response.body.includes(SECRET), `an unrelated header leaked: ${response.body}`);
  });

  it("shows one caller's cookie material to the next caller when a segment has no name", async () => {
    // The impact of the forwardAuth cookie-parsing gap, at the boundary that matters: the
    // snapshot is process-global, so whatever the parser keeps from one request is handed
    // to whoever calls the diagnostic afterwards — a different person on a different
    // connection who sent no cookie at all.
    await send({
      path: "/late/route",
      headers: { Cookie: `_oauth2_proxy=session; ${SECRET}` },
    });

    const { response } = await getDiagnostic();
    assert.ok(
      !response.body.includes(SECRET),
      `another caller's cookie material was served: ${response.body}`,
    );
  });

  it("echoes no value carried by an earlier request or upgrade", async () => {
    // The snapshot is process-global: whatever it holds is shown to whoever calls next.
    observeWebSocketUpgrade({
      "x-auth-request-access-token": SECRET,
      cookie: `_oauth2_proxy=${SECRET}`,
    });
    await send({ path: "/late/route", headers: { "x-auth-request-email": `${SECRET}@e.com` } });

    const { response } = await getDiagnostic();
    assert.ok(!response.body.includes(SECRET), `a stored value leaked: ${response.body}`);
  });
});

describe("the diagnostics are registered ahead of the request observer", () => {
  it("does not let a health probe become the last observed HTTP request", async () => {
    await send({ path: "/api/health" });
    assert.equal(
      getWsAuthProbeSnapshot().lastHttpRequest,
      null,
      "the container probe is not user traffic and must not be reported as evidence",
    );
  });

  it("does not let the diagnostic call itself become the last observed HTTP request", async () => {
    await getDiagnostic({ "x-auth-request-email": "u@e.com" });
    const { payload } = await getDiagnostic();
    assert.equal(payload.lastHttpRequest, null, "the diagnostic must not observe itself");
  });

  it("does not let repeated probing overwrite real evidence", async () => {
    await send({ path: "/late/route", headers: { "x-forwarded-user": "real-user" } });
    for (let index = 0; index < 5; index++) {
      await send({ path: "/api/health" });
      await getDiagnostic();
    }

    const { payload } = await getDiagnostic();
    assert.deepEqual(payload.lastHttpRequest?.verdict.identityHeaders, ["x-forwarded-user"]);
  });

  it("does observe ordinary traffic", async () => {
    await send({
      path: "/late/route",
      headers: { "x-auth-request-email": "u@e.com", Cookie: "_oauth2_proxy=abc" },
    });
    const { payload } = await getDiagnostic();
    assert.equal(payload.lastHttpRequest?.verdict.authenticated, true);
    assert.deepEqual(payload.lastHttpRequest?.verdict.cookieNames, ["_oauth2_proxy"]);
  });

  it("observes a request that matches no route at all", async () => {
    const response = await send({
      path: "/nothing/here",
      headers: { "x-forwarded-email": "u@e.com" },
    });
    assert.equal(response.status, 404);
    assert.equal(getWsAuthProbeSnapshot().lastHttpRequest?.verdict.authenticated, true);
  });

  it("keeps exactly one HTTP observation however much traffic arrives", async () => {
    for (let index = 0; index < 50; index++) {
      await send({ path: `/late/route?i=${index}`, headers: { "x-forwarded-user": `u${index}` } });
    }
    const snapshot = getWsAuthProbeSnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ["lastHttpRequest", "lastWebSocketUpgrade"]);
    assert.notEqual(snapshot.lastHttpRequest, null);
  });
});

describe("static serving falls through instead of swallowing later routes", () => {
  it("lets a GET reach a route registered after configureHttpRoutes", async () => {
    const response = await send({ path: "/matchmake/joinOrCreate/plaza" });
    assert.equal(response.status, 200);
    assert.ok(response.body.includes(MATCHMAKE_MARKER), `body was ${response.body}`);
  });

  it("lets a POST reach the matchmaking route", async () => {
    // serve-static answers 405 for non-GET when `fallthrough` is off. Matchmaking is a
    // POST, so a change to that option would make the room unjoinable while every GET
    // still looked fine.
    const body = JSON.stringify({ nickname: "tester" });
    const response = await send({
      method: "POST",
      path: "/matchmake/joinOrCreate/plaza",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      body,
    });
    assert.equal(response.status, 200, `POST was answered ${response.status}: ${response.body}`);
    assert.ok(response.body.includes(MATCHMAKE_MARKER), `body was ${response.body}`);
    assert.equal(response.headers.allow, undefined, "no 405 Allow header from serve-static");
  });

  it("lets a POST reach any other late route", async () => {
    const response = await send({ method: "POST", path: "/late/route" });
    assert.equal(response.status, 200);
    assert.ok(response.body.includes(LATE_ROUTE_MARKER));
  });

  it("registers no catch-all: an unknown path 404s rather than being answered", async () => {
    // An SPA fallback here would answer `/matchmake/*` before Colyseus ever saw it, and it
    // would answer every path below — none of which a `client/dist` build ever contains, so
    // the verdict does not depend on whether `npm run build` has run in this checkout.
    // `/` and `/index.html` are deliberately absent: `express.static` serves those with 200
    // from a built bundle, which is static serving working, not a catch-all.
    for (const path of [
      "/anything",
      "/api/unknown",
      "/deep/nested/path",
      "/definitely-not-a-bundled-asset.js",
    ]) {
      const response = await send({ path });
      assert.equal(response.status, 404, `${path} must not be answered by a catch-all`);
    }
  });

  it("does not answer a matchmaking path itself when no later route exists", async () => {
    const response = await send({ path: "/matchmake/joinOrCreate/does-not-exist/extra/segments" });
    assert.equal(response.status, 404);
  });

  it("keeps serving after a request for a path a static handler cannot decode", async () => {
    // A malformed percent-escape must not take the process down, whatever status it earns.
    const malformed = await send({ path: "/%zz" });
    assert.ok(malformed.status >= 400 && malformed.status < 500, `got ${malformed.status}`);

    markReady();
    const { response } = await getHealth();
    assert.equal(response.status, 200, "the server is still serving afterwards");
  });

  it("does not walk out of the client bundle directory", async () => {
    for (const path of ["/../../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/package.json"]) {
      const response = await send({ path });
      assert.notEqual(response.status, 200, `${path} must not resolve to a file`);
      assert.ok(!response.body.includes("@zep-test"), `${path} served a repository file`);
    }
  });
});

describe("routes under load", () => {
  it("answers 200 to a burst of concurrent health probes", async () => {
    markReady();
    const responses = await Promise.all(Array.from({ length: 200 }, () => getHealth()));
    for (const { response, payload } of responses) {
      assert.equal(response.status, 200);
      assert.equal(payload.ok, true);
      assert.ok(response.body.includes(HEALTHCHECK_GREP));
    }
  });

  it("answers 200 to a burst of concurrent diagnostics without leaking a value", async () => {
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        getDiagnostic({ "x-auth-request-email": `${SECRET}-${index}@example.com` }),
      ),
    );
    for (const { response, payload } of responses) {
      assert.equal(response.status, 200);
      assert.equal(payload.thisRequest.authenticated, true);
      assert.ok(!response.body.includes(SECRET), `a value leaked under load: ${response.body}`);
    }
  });

  it("does not let a caller park an oversized cookie list in the shared snapshot", async () => {
    // Cookie names are echoed verbatim to whoever calls the diagnostic next, so a hostile
    // Cookie header is stored-and-reflected input. It is bounded by node's header limit and
    // by the single-slot overwrite — the next ordinary request must displace it entirely.
    const manyNames = Array.from({ length: 300 }, (_unused, index) => `c${index}=v`).join("; ");
    const hostile = await send({ path: "/late/route", headers: { Cookie: manyNames } });
    assert.equal(hostile.status, 200, "the server survives the oversized cookie header");
    assert.equal(getWsAuthProbeSnapshot().lastHttpRequest?.verdict.cookieNames.length, 300);

    await send({ path: "/late/route", headers: { Cookie: "_oauth2_proxy=abc" } });
    assert.deepEqual(getWsAuthProbeSnapshot().lastHttpRequest?.verdict.cookieNames, [
      "_oauth2_proxy",
    ]);
    assert.ok(JSON.stringify(getWsAuthProbeSnapshot()).length < 500, "the snapshot shrinks back");
  });

  it("keeps the probe bounded to two slots under concurrent traffic", async () => {
    await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        send({ path: `/late/route?i=${index}`, headers: { "x-forwarded-user": `u${index}` } }),
      ),
    );
    const snapshot = getWsAuthProbeSnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ["lastHttpRequest", "lastWebSocketUpgrade"]);
    assert.ok(JSON.stringify(snapshot).length < 500, "the snapshot must stay small");
  });
});
