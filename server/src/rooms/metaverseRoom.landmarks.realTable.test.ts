import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { PROGRESSION_REGIONS } from "@zep-test/shared";
import { InMemoryInventoryStore } from "../db/inventoryStore";
import { ROOM_DEFINITIONS } from "./definitions";
import { LANDMARK_DEFINITIONS } from "./landmarkDefinitions";
import { MetaverseRoom } from "./metaverseRoom";

class LandmarkRoom extends MetaverseRoom { override setSimulationInterval(): void {} }
for (const region of PROGRESSION_REGIONS) for (const configuredStore of [false, true]) {
  it(`${region.roomId}: real landmark accepts a fresh account with inventory store=${configuredStore}`, async () => {
    const definition = ROOM_DEFINITIONS.find(row => row.name === region.roomId)!;
    const landmark = LANDMARK_DEFINITIONS.find(row => row.room === region.roomId)!;
    assert.ok(landmark.tile);
    assert.equal(landmark.requiresItemKey, undefined);
    const room = new LandmarkRoom();
    Object.defineProperty(room, "roomName", { value: region.roomId });
    await room.onCreate({ ...definition, inventoryStore: configuredStore ? new InMemoryInventoryStore() : undefined });
    try {
      const client = { sessionId: randomUUID(), auth: { ssoNickname: null, ssoUserId: randomUUID() }, send() {} } as unknown as Parameters<MetaverseRoom["onJoin"]>[0];
      await room.onJoin(client, { nickname: "new-account", avatarSkin: 0, arriveAtLandmark: landmark.id });
      const player = room.state.players.get(client.sessionId)!;
      assert.deepEqual([player.tileX, player.tileY], [landmark.tile.tileX, landmark.tile.tileY]);
      assert.ok(room["collisionMap"].isWalkable(player.tileX, player.tileY));
    } finally { room.onDispose(); }
  });
}
