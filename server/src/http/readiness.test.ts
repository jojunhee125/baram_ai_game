import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { getUnhealthyReason, markReady, markUnhealthy, resetReadiness } from "./readiness";

/**
 * Read at import time, before any test can mutate the module. Reading it inside a test
 * would only prove what the previous test left behind — and "what the module looks like
 * the moment it is loaded" is the whole point: a server that starts out healthy reports
 * `ok:true` to the container probe during the window before `beforeListen` has validated
 * anything.
 */
const INITIAL_REASON = getUnhealthyReason();

beforeEach(() => {
  resetReadiness();
});

describe("readiness — initial state", () => {
  it("starts unhealthy", () => {
    assert.notEqual(INITIAL_REASON, null, "a freshly loaded module must not claim health");
  });

  it("starts with a human-readable reason", () => {
    assert.equal(typeof INITIAL_REASON, "string");
    assert.ok((INITIAL_REASON ?? "").length > 0, "the reason must say something");
  });

  it("names the boot window in the reason so a failing probe is diagnosable", () => {
    assert.equal(INITIAL_REASON, "startup checks have not completed");
  });
});

describe("readiness — transitions", () => {
  it("clears the reason once ready", () => {
    markReady();
    assert.equal(getUnhealthyReason(), null);
  });

  it("reports the reason it was marked unhealthy with", () => {
    markUnhealthy('map "plaza" failed to load');
    assert.equal(getUnhealthyReason(), 'map "plaza" failed to load');
  });

  it("goes unhealthy again after having been ready", () => {
    markReady();
    markUnhealthy("assets went missing");
    assert.equal(getUnhealthyReason(), "assets went missing");
  });

  it("recovers to healthy after having been unhealthy", () => {
    markUnhealthy("transient");
    markReady();
    assert.equal(getUnhealthyReason(), null);
  });

  it("keeps the most recent reason when marked unhealthy twice", () => {
    markUnhealthy("first");
    markUnhealthy("second");
    assert.equal(getUnhealthyReason(), "second");
  });

  it("is idempotent for repeated markReady", () => {
    markReady();
    markReady();
    assert.equal(getUnhealthyReason(), null);
  });

  it("does not change on a read", () => {
    markUnhealthy("stable");
    assert.equal(getUnhealthyReason(), "stable");
    assert.equal(getUnhealthyReason(), "stable");
    assert.equal(getUnhealthyReason(), "stable");
  });
});

describe("readiness — reason values that are not plain sentences", () => {
  it("treats an empty reason as unhealthy, not as healthy", () => {
    // `/api/health` branches on `reason === null`, so an empty string must still read as
    // degraded rather than falling through a truthiness check.
    markUnhealthy("");
    assert.equal(getUnhealthyReason(), "");
    assert.notEqual(getUnhealthyReason(), null);
  });

  it("preserves a reason verbatim, including whitespace and non-ASCII text", () => {
    for (const reason of ["  padded  ", "맵 로드 실패", "line\nbreak", '"quoted"']) {
      markUnhealthy(reason);
      assert.equal(getUnhealthyReason(), reason);
    }
  });

  it("preserves a very long reason without truncating it", () => {
    const reason = "x".repeat(10_000);
    markUnhealthy(reason);
    assert.equal(getUnhealthyReason(), reason);
  });
});

describe("readiness — reset", () => {
  it("returns to the state the module was loaded in", () => {
    markReady();
    resetReadiness();
    assert.equal(getUnhealthyReason(), INITIAL_REASON);
  });

  it("returns to unhealthy from any state", () => {
    for (const seed of [() => markReady(), () => markUnhealthy("boom"), () => markUnhealthy("")]) {
      seed();
      resetReadiness();
      assert.notEqual(getUnhealthyReason(), null);
      assert.equal(getUnhealthyReason(), INITIAL_REASON);
    }
  });

  it("is idempotent", () => {
    resetReadiness();
    resetReadiness();
    assert.equal(getUnhealthyReason(), INITIAL_REASON);
  });
});
