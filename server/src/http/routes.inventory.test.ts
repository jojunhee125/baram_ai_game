import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import type { EquipmentSlot } from "@zep-test/shared";
import type { InventoryRow, InventoryStore } from "../db/inventoryStore";
import { markDatabaseDegraded, resetDatabaseStatus } from "../db/status";
import { ITEM_DEFINITIONS } from "../rooms/itemDefinitions";
import { markReady, resetReadiness } from "./readiness";
import { configureHttpRoutes } from "./routes";

/**
 * Its own express app on an **ephemeral port** (`listen(0)`), like routes.test.ts and
 * routes.profile.test.ts: this file owns no fixed port and must never take one. The fixed ports
 * in this workspace (2567, 2571, 2573, 2575, 2577, 2579, 2581) are already contended, and
 * `node:test` runs these files in parallel — a duplicate number hangs the whole run.
 */
const INVENTORY_PATH = "/api/inventory";

/** Two different accounts, so "read from the right bag" is a checkable claim. */
const SUB_A = "1f0d1a9c-6b7e-4f2a-9c31-0c4c2a5b8e10";
const SUB_B = "7c2b4d55-1e3f-4a88-b0d2-9f6e5c4a3b21";

/** What the compose healthcheck greps for. A failing bag read must not have moved it. */
const HEALTHCHECK_GREP = '"ok":true';

interface RawResponse {
  status: number;
  body: string;
}

interface InventoryItemView {
  itemKey: string;
  name: string;
  icon: string;
  quantity: number;
  equipped: boolean;
  damageReductionRatio?: number;
  sellValue?: number;
  consumable?: boolean;
}

/**
 * A store the test drives directly: `rows` is what a read returns, and it can be made to reject,
 * which is the only way to reach the route's 503.
 */
class ScriptedInventoryStore implements InventoryStore {
  readonly bags = new Map<string, InventoryRow[]>();
  readonly reads: string[] = [];
  failReads = false;

  list(ownerKey: string): Promise<readonly InventoryRow[]> {
    this.reads.push(ownerKey);
    if (this.failReads) {
      return Promise.reject(new Error("connection terminated unexpectedly"));
    }
    return Promise.resolve(this.bags.get(ownerKey) ?? []);
  }

  add(): Promise<number | null> {
    throw new Error("GET /api/inventory must never grant anything");
  }

  grantOnce(): Promise<boolean> {
    throw new Error("GET /api/inventory must never grant anything");
  }

  getEquippedSlots(): Promise<Partial<Record<EquipmentSlot, string>>> {
    throw new Error("GET /api/inventory must never touch equipment");
  }

  equip(): Promise<boolean> {
    throw new Error("GET /api/inventory must never touch equipment");
  }

  unequip(): Promise<boolean> {
    throw new Error("GET /api/inventory must never touch equipment");
  }

  remove(): Promise<number | null> {
    throw new Error("GET /api/inventory must never remove anything");
  }
}

let server: Server;
let port: number;
let store: ScriptedInventoryStore;

function jwtWithClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

function tokenHeader(sub: string): OutgoingHttpHeaders {
  return { "x-auth-request-access-token": jwtWithClaims({ sub }) };
}

/** Raw `node:http` rather than `fetch`, for the reason routes.profile.test.ts gives. */
function send(options: { path: string; headers?: OutgoingHttpHeaders }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path: options.path, headers: options.headers },
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
    request.end();
  });
}

async function readInventory(headers?: OutgoingHttpHeaders): Promise<{
  status: number;
  items: InventoryItemView[];
}> {
  const response = await send({ path: INVENTORY_PATH, headers });
  const payload = JSON.parse(response.body) as { items?: InventoryItemView[] };
  return { status: response.status, items: payload.items ?? [] };
}

/** The first two rows of the real table; the route's ordering claim is about this table. */
function definitionAt(index: number): (typeof ITEM_DEFINITIONS)[number] {
  const definition = ITEM_DEFINITIONS[index];
  assert.ok(definition, `ITEM_DEFINITIONS needs at least ${index + 1} rows for this test`);
  return definition;
}

before(async () => {
  const app = express();
  store = new ScriptedInventoryStore();
  // The profile store is left at its default: this file is about the third argument.
  configureHttpRoutes(app, undefined, store);
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
  store.bags.clear();
  store.reads.length = 0;
  store.failReads = false;
});

describe("GET /api/inventory", () => {
  it("answers the bag of the account the token names, with names and icons attached", async () => {
    const first = definitionAt(0);
    store.bags.set(SUB_A, [{ itemKey: first.key, quantity: 3, equipped: false }]);
    const { status, items } = await readInventory(tokenHeader(SUB_A));
    assert.equal(status, 200);
    assert.deepEqual(items, [
      { itemKey: first.key, name: first.name, icon: first.icon, quantity: 3, equipped: false, sellValue: first.sellValue },
    ]);
    assert.deepEqual(store.reads, [SUB_A], "the sub claim is the key it looked under");
  });

  it("answers an empty list for an account that has never picked anything up", async () => {
    const { status, items } = await readInventory(tokenHeader(SUB_A));
    assert.equal(status, 200);
    assert.deepEqual(items, []);
  });

  it("does not hand one account another account's bag", async () => {
    store.bags.set(SUB_B, [{ itemKey: definitionAt(0).key, quantity: 5, equipped: false }]);
    assert.deepEqual((await readInventory(tokenHeader(SUB_A))).items, []);
  });

  it("orders items by ITEM_DEFINITIONS, not by what the store returned", async () => {
    // The store's order is undefined by contract, so the display order has to come from the
    // table — otherwise the bag rearranges itself between two reads of the same contents.
    const first = definitionAt(0);
    const second = definitionAt(1);
    store.bags.set(SUB_A, [
      { itemKey: second.key, quantity: 1, equipped: false },
      { itemKey: first.key, quantity: 2, equipped: false },
    ]);
    const { items } = await readInventory(tokenHeader(SUB_A));
    assert.deepEqual(
      items.map((item) => item.itemKey),
      [first.key, second.key],
    );
  });

  it("drops a stored row whose key has left the table rather than rendering it nameless", async () => {
    store.bags.set(SUB_A, [
      { itemKey: "a-retired-item", quantity: 9, equipped: false },
      { itemKey: definitionAt(0).key, quantity: 1, equipped: false },
    ]);
    const { items } = await readInventory(tokenHeader(SUB_A));
    assert.deepEqual(
      items.map((item) => item.itemKey),
      [definitionAt(0).key],
      "the code table defines what an item is; the database only stores amounts",
    );
  });

  it("carries sellValue for a sellable item and consumable for a usable one (roadmap R04-c)", async () => {
    const sellable = ITEM_DEFINITIONS.find((item) => item.sellValue !== undefined);
    assert.ok(sellable, "the fixture needs a sellable item in ITEM_DEFINITIONS");
    const consumable = ITEM_DEFINITIONS.find((item) => item.consumable !== undefined);
    assert.ok(consumable, "the fixture needs a consumable item in ITEM_DEFINITIONS");
    const plainItem = ITEM_DEFINITIONS.find(item => item.sellValue === undefined && item.consumable === undefined);
    assert.ok(plainItem, "ITEM_DEFINITIONS needs at least 1 row for this test");
    assert.equal(plainItem.sellValue, undefined, "precondition: this row has neither field");
    assert.equal(plainItem.consumable, undefined, "precondition: this row has neither field");

    store.bags.set(SUB_A, [
      { itemKey: sellable.key, quantity: 1, equipped: false },
      { itemKey: consumable.key, quantity: 1, equipped: false },
      { itemKey: plainItem.key, quantity: 1, equipped: false },
    ]);
    const { items } = await readInventory(tokenHeader(SUB_A));

    const sellableRow = items.find((item) => item.itemKey === sellable.key);
    assert.equal(sellableRow?.sellValue, sellable.sellValue, "sellValue must travel verbatim");
    const consumableRow = items.find((item) => item.itemKey === consumable.key);
    assert.equal(consumableRow?.consumable, true, "consumable collapses to a bare boolean on the wire");
    const plainRow = items.find((item) => item.itemKey === plainItem.key);
    assert.equal(plainRow?.sellValue, undefined, "a non-sellable row must not carry the field at all");
    assert.equal(plainRow?.consumable, undefined, "a non-consumable row must not carry the field at all");
    assert.equal(JSON.stringify(plainRow)?.includes("sellValue"), false, "absent on the wire, not present-and-undefined");
    assert.equal(JSON.stringify(plainRow)?.includes("consumable"), false, "absent on the wire, not present-and-undefined");
  });

  it("answers 200 with an empty list and never a 4xx when there is no SSO identity", async () => {
    // A 401 here would read as "not signed in" to oauth2-proxy and start an SSO redirect loop,
    // which is the same reason /api/health and /api/profile always answer 200.
    const { status, items } = await readInventory();
    assert.equal(status, 200);
    assert.deepEqual(items, []);
    assert.deepEqual(store.reads, [], "no identity means there is nothing to look up");
  });

  it("answers 200 with an empty list for a token the gateway sent but that carries no sub", async () => {
    const { status, items } = await readInventory({
      "x-auth-request-access-token": jwtWithClaims({ preferred_username: "조준희 매니저" }),
    });
    assert.equal(status, 200);
    assert.deepEqual(items, []);
    assert.deepEqual(store.reads, []);
  });

  it("ignores an empty access-token header rather than treating it as an identity", async () => {
    const { status, items } = await readInventory({ "x-auth-request-access-token": "   " });
    assert.equal(status, 200);
    assert.deepEqual(items, []);
    assert.deepEqual(store.reads, []);
  });

  it("reads the first value when the gateway sends the token header twice", async () => {
    await readInventory({
      "x-auth-request-access-token": [jwtWithClaims({ sub: SUB_A }), jwtWithClaims({ sub: SUB_B })],
    });
    assert.deepEqual(store.reads, [SUB_A]);
  });

  it("answers 503 when the store fails, rather than an empty bag that says the loot is gone", async () => {
    store.failReads = true;
    const response = await send({ path: INVENTORY_PATH, headers: tokenHeader(SUB_A) });
    assert.equal(response.status, 503, "a fabricated empty bag is worse than an honest error");
    assert.deepEqual(JSON.parse(response.body), { error: "inventory store unavailable" });
  });

  it("never puts the access token in the response body", async () => {
    const token = jwtWithClaims({ sub: SUB_A });
    const response = await send({
      path: INVENTORY_PATH,
      headers: { "x-auth-request-access-token": token },
    });
    assert.doesNotMatch(response.body, /signature/, "the raw token must not be echoed");
    assert.equal(response.body.includes(token), false);
  });

  it("does not let a failing bag read flip /api/health's ok to false", async () => {
    // The compose healthcheck greps '"ok":true' and Coolify rolls the deployment back on a miss,
    // so a Postgres hiccup must not take movement and chat down with it.
    markReady();
    store.failReads = true;
    assert.equal((await send({ path: INVENTORY_PATH, headers: tokenHeader(SUB_A) })).status, 503);
    markDatabaseDegraded(new Error("connection terminated unexpectedly"));
    const health = await send({ path: "/api/health" });
    assert.equal(health.status, 200);
    const payload = JSON.parse(health.body) as Record<string, unknown>;
    assert.equal(payload["ok"], true);
    assert.equal(payload["db"], "degraded");
    assert.ok(health.body.includes(HEALTHCHECK_GREP), `raw body must still contain ${HEALTHCHECK_GREP}`);
  });
});
