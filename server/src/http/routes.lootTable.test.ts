import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import { buildLootTableView } from "../rooms/lootTableView";
import { configureHttpRoutes } from "./routes";

/**
 * Its own express app on an ephemeral port, like routes.test.ts: the fixed ports in this
 * workspace are already contended and must never be reused by a test file.
 */
const HUNTING_GROUND = "buyeo-novice";

interface LootTableMonsterPayload {
  kind: string;
  name: string;
  drops: { itemKey: string; name: string; icon: string; chancePercent: number }[];
}

let server: Server;
let port: number;

function getLootTable(roomName: string): Promise<{ status: number; monsters: LootTableMonsterPayload[] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: `/api/loot-table/${encodeURIComponent(roomName)}`,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          const payload = JSON.parse(body) as { monsters?: LootTableMonsterPayload[] };
          resolve({ status: response.statusCode ?? 0, monsters: payload.monsters ?? [] });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

before(async () => {
  const app = express();
  configureHttpRoutes(app);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("GET /api/loot-table/:roomName", () => {
  it("answers 200 with the same content buildLootTableView computes, for a room with monsters", async () => {
    const { status, monsters } = await getLootTable(HUNTING_GROUND);
    assert.equal(status, 200);
    assert.deepEqual(monsters, buildLootTableView(HUNTING_GROUND));
    assert.ok(monsters.length > 0, "hunting-ground must have at least one monster kind");
  });

  it("answers 200 with an empty list for a room with no monster spawns", async () => {
    const { status, monsters } = await getLootTable("grand-plaza");
    assert.equal(status, 200);
    assert.deepEqual(monsters, []);
  });

  it("answers 200 with an empty list, never a 404, for a room name that does not exist", async () => {
    const { status, monsters } = await getLootTable("no-such-room");
    assert.equal(status, 200);
    assert.deepEqual(monsters, []);
  });

  it("requires no SSO identity — an unauthenticated call still gets real data", async () => {
    // No access-token header is sent at all in this file, unlike routes.inventory.test.ts and
    // routes.profile.test.ts, and the room's real monsters still come back rather than []: this
    // route never reads identity in the first place (design §G-2-a).
    const { monsters } = await getLootTable(HUNTING_GROUND);
    assert.ok(monsters.length > 0);
  });
});

for (const room of ["buyeo-novice", "buyeo-rat-cave", "buyeo-snake-cave", "buyeo-bear-cave", "buyeo-deer-cave", "buyeo-pig-cave", "buyeo-fox-cave"]) it(`${room}: HTTP publishes the live resolver table`, async () => {
 const {status, monsters} = await getLootTable(room);
 assert.equal(status,200); assert.deepEqual(monsters,buildLootTableView(room)); assert.ok(monsters.length > 0);
});
it("retired hunting rooms expose no active drops", async () => { for (const room of ["hunting-ground","hunting-den","hunting-forest","hunting-wetland","hunting-quarry","hunting-frost","hunting-ruins"]) assert.deepEqual((await getLootTable(room)).monsters, []); });
