import type { IncomingHttpHeaders } from "node:http";
import { inspectForwardAuth, type ForwardAuthVerdict } from "./forwardAuth";

export interface ProbeObservation {
  observedAt: string;
  verdict: ForwardAuthVerdict;
}

export interface WsAuthProbeSnapshot {
  lastHttpRequest: ProbeObservation | null;
  lastWebSocketUpgrade: ProbeObservation | null;
}

/**
 * Go/No-go PoC #1 — "does a websocket upgrade still carry the gateway's SSO headers?".
 *
 * Exactly one observation is kept per kind, overwritten in place: a room server runs for
 * days, so an append-only log of every request would be a memory leak, and the question
 * only needs the most recent evidence.
 */
let lastHttpRequest: ProbeObservation | null = null;
let lastWebSocketUpgrade: ProbeObservation | null = null;

export function observeHttpRequest(headers: IncomingHttpHeaders): ProbeObservation {
  lastHttpRequest = observe(headers);
  return lastHttpRequest;
}

export function observeWebSocketUpgrade(headers: IncomingHttpHeaders): ProbeObservation {
  lastWebSocketUpgrade = observe(headers);
  return lastWebSocketUpgrade;
}

export function getWsAuthProbeSnapshot(): WsAuthProbeSnapshot {
  return { lastHttpRequest, lastWebSocketUpgrade };
}

/** Test seam: this module's state would otherwise leak between cases. */
export function resetWsAuthProbe(): void {
  lastHttpRequest = null;
  lastWebSocketUpgrade = null;
}

function observe(headers: IncomingHttpHeaders): ProbeObservation {
  return { observedAt: new Date().toISOString(), verdict: inspectForwardAuth(headers) };
}
