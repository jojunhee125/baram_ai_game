import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { beforeEach, describe, it } from "node:test";
import {
  getWsAuthProbeSnapshot,
  observeHttpRequest,
  observeWebSocketUpgrade,
  resetWsAuthProbe,
} from "./wsAuthProbe";

const SECRET = "Zq7x-LEAKED-VALUE-9f3";

const HTTP_HEADERS: IncomingHttpHeaders = {
  "x-auth-request-email": `${SECRET}@example.com`,
  cookie: `_oauth2_proxy=${SECRET}`,
};

const UPGRADE_HEADERS: IncomingHttpHeaders = {
  upgrade: "websocket",
  connection: "Upgrade",
  "x-forwarded-user": SECRET,
  cookie: `_oauth2_proxy_0=${SECRET}`,
};

/** Exactly the ISO-8601 form `Date#toISOString` produces — nothing looser. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

beforeEach(() => {
  resetWsAuthProbe();
});

describe("wsAuthProbe — initial and reset state", () => {
  it("starts with nothing observed", () => {
    assert.deepEqual(getWsAuthProbeSnapshot(), {
      lastHttpRequest: null,
      lastWebSocketUpgrade: null,
    });
  });

  it("returns to the initial state after reset", () => {
    observeHttpRequest(HTTP_HEADERS);
    observeWebSocketUpgrade(UPGRADE_HEADERS);
    assert.notEqual(getWsAuthProbeSnapshot().lastHttpRequest, null);

    resetWsAuthProbe();
    assert.deepEqual(getWsAuthProbeSnapshot(), {
      lastHttpRequest: null,
      lastWebSocketUpgrade: null,
    });
  });

  it("is idempotent when reset twice", () => {
    resetWsAuthProbe();
    resetWsAuthProbe();
    assert.deepEqual(getWsAuthProbeSnapshot(), {
      lastHttpRequest: null,
      lastWebSocketUpgrade: null,
    });
  });
});

describe("wsAuthProbe — the two kinds stay separate", () => {
  it("records an HTTP request without touching the upgrade slot", () => {
    observeHttpRequest(HTTP_HEADERS);
    const snapshot = getWsAuthProbeSnapshot();
    assert.notEqual(snapshot.lastHttpRequest, null);
    assert.equal(snapshot.lastWebSocketUpgrade, null);
  });

  it("records an upgrade without touching the HTTP slot", () => {
    observeWebSocketUpgrade(UPGRADE_HEADERS);
    const snapshot = getWsAuthProbeSnapshot();
    assert.equal(snapshot.lastHttpRequest, null);
    assert.notEqual(snapshot.lastWebSocketUpgrade, null);
  });

  it("keeps one of each and never lets one overwrite the other", () => {
    observeHttpRequest({ "x-auth-request-email": "http@example.com" });
    observeWebSocketUpgrade({ "x-forwarded-user": "upgrade" });

    const snapshot = getWsAuthProbeSnapshot();
    assert.deepEqual(snapshot.lastHttpRequest?.verdict.identityHeaders, [
      "x-auth-request-email",
    ]);
    assert.deepEqual(snapshot.lastWebSocketUpgrade?.verdict.identityHeaders, ["x-forwarded-user"]);
  });

  it("keeps them separate whichever order they arrive in", () => {
    observeWebSocketUpgrade({ "x-forwarded-user": "upgrade" });
    observeHttpRequest({ "x-auth-request-email": "http@example.com" });

    const snapshot = getWsAuthProbeSnapshot();
    assert.deepEqual(snapshot.lastHttpRequest?.verdict.identityHeaders, [
      "x-auth-request-email",
    ]);
    assert.deepEqual(snapshot.lastWebSocketUpgrade?.verdict.identityHeaders, ["x-forwarded-user"]);
  });
});

describe("wsAuthProbe — the newest observation wins", () => {
  it("overwrites the previous HTTP observation", () => {
    observeHttpRequest({ "x-auth-request-email": "first@example.com" });
    observeHttpRequest({ "x-forwarded-email": "second@example.com", cookie: "s=1" });

    const observation = getWsAuthProbeSnapshot().lastHttpRequest;
    assert.deepEqual(observation?.verdict.identityHeaders, ["x-forwarded-email"]);
    assert.deepEqual(observation?.verdict.cookieNames, ["s"]);
  });

  it("overwrites the previous upgrade observation", () => {
    observeWebSocketUpgrade({ "x-auth-request-user": "first" });
    observeWebSocketUpgrade({});

    const observation = getWsAuthProbeSnapshot().lastWebSocketUpgrade;
    assert.equal(observation?.verdict.authenticated, false);
    assert.deepEqual(observation?.verdict.identityHeaders, []);
  });

  it("forgets an earlier authenticated observation once an anonymous one arrives", () => {
    // The PoC reads the *latest* evidence; a stale success must not be reported as current.
    observeWebSocketUpgrade({ "x-auth-request-email": "u@e.com" });
    assert.equal(getWsAuthProbeSnapshot().lastWebSocketUpgrade?.verdict.authenticated, true);

    observeWebSocketUpgrade({ host: "zep.example.com" });
    assert.equal(getWsAuthProbeSnapshot().lastWebSocketUpgrade?.verdict.authenticated, false);
  });

  it("holds exactly two slots after a long run, with no third key appearing", () => {
    // A room server runs for days; an append-only log here would be the memory leak the
    // module's comment rules out.
    for (let index = 0; index < 5000; index++) {
      observeHttpRequest({ "x-auth-request-email": `u${index}@example.com` });
      observeWebSocketUpgrade({ "x-forwarded-user": `u${index}` });
    }

    const snapshot = getWsAuthProbeSnapshot();
    assert.deepEqual(Object.keys(snapshot).sort(), ["lastHttpRequest", "lastWebSocketUpgrade"]);
    assert.deepEqual(snapshot.lastHttpRequest?.verdict.identityHeaders, [
      "x-auth-request-email",
    ]);
    assert.deepEqual(snapshot.lastWebSocketUpgrade?.verdict.identityHeaders, ["x-forwarded-user"]);
    assert.equal(JSON.stringify(snapshot).length < 500, true, "the snapshot must stay small");
  });
});

describe("wsAuthProbe — observation shape", () => {
  it("stamps observedAt as a round-trippable ISO string", () => {
    for (const observation of [observeHttpRequest({}), observeWebSocketUpgrade({})]) {
      assert.equal(typeof observation.observedAt, "string");
      assert.match(observation.observedAt, ISO_8601);
      assert.equal(new Date(observation.observedAt).toISOString(), observation.observedAt);
    }
  });

  it("stamps a time inside the window the call was made in", () => {
    const before = Date.now();
    const observation = observeHttpRequest({});
    const after = Date.now();

    const observedAt = new Date(observation.observedAt).getTime();
    assert.ok(observedAt >= before - 1, `${observation.observedAt} predates the call`);
    assert.ok(observedAt <= after + 1, `${observation.observedAt} postdates the call`);
  });

  it("never moves observedAt backwards between two observations", () => {
    const first = observeHttpRequest({});
    const second = observeHttpRequest({});
    assert.ok(second.observedAt >= first.observedAt, "ISO strings sort chronologically");
  });

  it("returns the same observation it stored", () => {
    const returned = observeHttpRequest(HTTP_HEADERS);
    assert.deepEqual(getWsAuthProbeSnapshot().lastHttpRequest, returned);
  });

  it("carries the same verdict inspectForwardAuth would produce", () => {
    const observation = observeHttpRequest({
      "x-auth-request-email": "u@e.com",
      "x-auth-request-access-token": "token",
      cookie: "_oauth2_proxy=abc; csrf=def",
    });
    assert.deepEqual(observation.verdict, {
      authenticated: true,
      identityHeaders: ["x-auth-request-email", "x-auth-request-access-token"],
      hasCookie: true,
      cookieNames: ["_oauth2_proxy", "csrf"],
    });
  });

  it("gives each observation its own verdict object", () => {
    const first = observeHttpRequest({ "x-auth-request-email": "u@e.com" });
    const second = observeHttpRequest({ "x-auth-request-email": "u@e.com" });
    assert.notEqual(first.verdict, second.verdict, "verdicts must not be shared instances");
    assert.notEqual(
      first.verdict.identityHeaders,
      second.verdict.identityHeaders,
      "arrays must not be shared instances",
    );
  });
});

describe("wsAuthProbe — no value survives into the snapshot", () => {
  it("stores no header or cookie value from an HTTP observation", () => {
    observeHttpRequest(HTTP_HEADERS);
    const json = JSON.stringify(getWsAuthProbeSnapshot());
    assert.ok(!json.includes(SECRET), `value leaked into the snapshot: ${json}`);
  });

  it("stores no header or cookie value from an upgrade observation", () => {
    observeWebSocketUpgrade(UPGRADE_HEADERS);
    const json = JSON.stringify(getWsAuthProbeSnapshot());
    assert.ok(!json.includes(SECRET), `value leaked into the snapshot: ${json}`);
  });

  it("stores no value from either kind at once", () => {
    observeHttpRequest(HTTP_HEADERS);
    observeWebSocketUpgrade(UPGRADE_HEADERS);
    const json = JSON.stringify(getWsAuthProbeSnapshot());
    assert.ok(!json.includes(SECRET), `value leaked into the snapshot: ${json}`);
  });
});
