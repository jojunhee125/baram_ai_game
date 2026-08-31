import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { after, before, describe, it } from "node:test";
import type { Server } from "colyseus";
import { createGameServer } from "../server";
import { ROOM_DEFINITIONS } from "../rooms/definitions";
import { resetWsAuthProbe, type WsAuthProbeSnapshot } from "./wsAuthProbe";

/**
 * node:test runs each file in its own process, and the two room suites already own 2568
 * and 2571. A third fixed port keeps this file independent of both. Exactly one file may own a
 * given port: metaverseRoom.interactables.test.ts also claimed 2573 for a while, which killed
 * one suite with EADDRINUSE and left the other's listener open so the run never exited. Grep
 * the other *.test.ts files for the ports they bind before changing this.
 */
const PORT = 2573;

const SECRET = "Zq7x-LEAKED-VALUE-9f3";

interface RawResponse {
  status: number;
  body: string;
}

interface DiagnosticPayload {
  observedAt: string;
  thisRequest: { authenticated: boolean; identityHeaders: string[]; cookieNames: string[] };
  lastHttpRequest: WsAuthProbeSnapshot["lastHttpRequest"];
  lastWebSocketUpgrade: WsAuthProbeSnapshot["lastWebSocketUpgrade"];
}

let gameServer: Server;

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
        port: PORT,
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

async function diagnostic(headers?: OutgoingHttpHeaders): Promise<DiagnosticPayload> {
  const response = await send({ path: "/api/diag/ws-auth", headers });
  assert.equal(response.status, 200, `diagnostic answered ${response.status}`);
  return JSON.parse(response.body) as DiagnosticPayload;
}

/**
 * A real websocket handshake against the live server, carrying the headers the KAD gateway
 * would have injected. Resolves once the server has answered in any way — the `upgrade`
 * listener in server.ts runs before `ws` decides whether to accept, so the observation is
 * recorded either way.
 */
function upgrade(headers: OutgoingHttpHeaders): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: PORT,
      path: "/",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    const finish = (socket?: { destroy(): void }): void => {
      socket?.destroy();
      resolve();
    };
    request.on("upgrade", (_response, socket) => finish(socket));
    request.on("response", (response) => {
      response.resume();
      response.on("end", () => resolve());
    });
    request.on("error", reject);
    request.end();
  });
}

before(async () => {
  gameServer = createGameServer();
  await gameServer.listen(PORT);
});

after(async () => {
  await gameServer.gracefullyShutdown(false);
});

describe("the live server's HTTP surface", () => {
  it("reports itself healthy once beforeListen has validated the maps", async () => {
    const response = await send({ path: "/api/health" });
    assert.equal(response.status, 200);
    assert.ok(
      response.body.includes('"ok":true'),
      `the compose healthcheck greps '"ok":true'; body was ${response.body}`,
    );

    const payload = JSON.parse(response.body) as { ok: boolean; rooms: string[] };
    assert.equal(payload.ok, true);
    assert.deepEqual(
      payload.rooms,
      ROOM_DEFINITIONS.map((definition) => definition.name),
    );
  });

  it("still serves matchmaking with the HTTP routes attached", async () => {
    // The reason routes.ts registers no catch-all. A seat reservation here means a client
    // can still reach the room; a 404 would mean the room is unjoinable.
    const body = JSON.stringify({ nickname: "tester", avatarSkin: 0 });
    const response = await send({
      method: "POST",
      path: `/matchmake/joinOrCreate/${ROOM_DEFINITIONS[0]?.name ?? "plaza"}`,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      body,
    });

    assert.equal(response.status, 200, `matchmaking answered ${response.status}: ${response.body}`);
    const payload = JSON.parse(response.body) as {
      name?: string;
      roomId?: string;
      sessionId?: string;
    };
    assert.equal(payload.name, ROOM_DEFINITIONS[0]?.name, `unexpected reservation: ${response.body}`);
    assert.ok(payload.roomId, `no roomId in the reservation: ${response.body}`);
    assert.ok(payload.sessionId, `no sessionId in the reservation: ${response.body}`);
  });

  it("answers the diagnostic on the live server", async () => {
    const payload = await diagnostic({ "x-auth-request-email": "u@kyungshin.co.kr" });
    assert.equal(payload.thisRequest.authenticated, true);
  });

  it("serves no SPA fallback while the client bundle is absent", async () => {
    // With `client/dist` built this becomes index.html; without it the request must fall
    // through rather than be answered by a catch-all.
    const response = await send({ path: "/definitely-not-a-bundled-asset.js" });
    assert.equal(response.status, 404);
  });
});

describe("Go/No-go PoC #1 — a websocket upgrade through the live server", () => {
  it("records the identity headers a gateway would have put on the upgrade", async () => {
    resetWsAuthProbe();
    await upgrade({
      "X-Auth-Request-Email": `${SECRET}@kyungshin.co.kr`,
      "X-Auth-Request-Access-Token": `eyJhbGciOi.${SECRET}.sig`,
      Cookie: `_oauth2_proxy=${SECRET}; _oauth2_proxy_csrf=${SECRET}`,
    });

    const payload = await diagnostic();
    const observed = payload.lastWebSocketUpgrade;
    assert.ok(observed, "the upgrade listener recorded nothing");
    assert.equal(observed.verdict.authenticated, true);
    assert.deepEqual(observed.verdict.identityHeaders, [
      "x-auth-request-email",
      "x-auth-request-access-token",
    ]);
    assert.deepEqual(observed.verdict.cookieNames, ["_oauth2_proxy", "_oauth2_proxy_csrf"]);
    assert.equal(new Date(observed.observedAt).toISOString(), observed.observedAt);
  });

  it("reports an unauthenticated upgrade as unauthenticated", async () => {
    resetWsAuthProbe();
    await upgrade({});

    const payload = await diagnostic();
    assert.equal(payload.lastWebSocketUpgrade?.verdict.authenticated, false);
    assert.deepEqual(payload.lastWebSocketUpgrade?.verdict.identityHeaders, []);
  });

  it("leaks no header or cookie value from the upgrade into the diagnostic body", async () => {
    resetWsAuthProbe();
    await upgrade({
      "X-Auth-Request-Email": `${SECRET}@kyungshin.co.kr`,
      Cookie: `_oauth2_proxy=${SECRET}`,
    });

    const response = await send({ path: "/api/diag/ws-auth" });
    assert.ok(!response.body.includes(SECRET), `an upgrade value leaked: ${response.body}`);
  });

  it("keeps only the most recent upgrade", async () => {
    resetWsAuthProbe();
    await upgrade({ "X-Auth-Request-Email": "first@example.com" });
    await upgrade({ "X-Forwarded-User": "second" });

    const payload = await diagnostic();
    assert.deepEqual(payload.lastWebSocketUpgrade?.verdict.identityHeaders, ["x-forwarded-user"]);
  });

  it("does not let an upgrade overwrite the last observed HTTP request", async () => {
    resetWsAuthProbe();
    await send({ path: "/some/asset.png", headers: { "x-forwarded-user": "http-user" } });
    await upgrade({ "X-Auth-Request-Email": "ws@example.com" });

    const payload = await diagnostic();
    assert.deepEqual(payload.lastHttpRequest?.verdict.identityHeaders, ["x-forwarded-user"]);
    assert.deepEqual(payload.lastWebSocketUpgrade?.verdict.identityHeaders, [
      "x-auth-request-email",
    ]);
  });

  it("does not observe matchmaking requests, which Colyseus answers before express", async () => {
    // Documented, not desired: `/matchmake/*` is served by a listener prepended to the HTTP
    // server, so the observer middleware never sees it. The HTTP half of the PoC therefore
    // only ever reports asset/API traffic.
    resetWsAuthProbe();
    const body = JSON.stringify({ nickname: "tester" });
    await send({
      method: "POST",
      path: `/matchmake/joinOrCreate/${ROOM_DEFINITIONS[0]?.name ?? "plaza"}`,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-auth-request-email": "matchmaker@example.com",
      },
      body,
    });

    const payload = await diagnostic();
    assert.equal(payload.lastHttpRequest, null);
  });
});
