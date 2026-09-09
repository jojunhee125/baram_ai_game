import {
  InMemoryBossStateStore,
  PostgresBossStateStore,
  type BossStateStore,
} from "./db/bossStateStore";
import {
  InMemoryInventoryStore,
  PostgresInventoryStore,
  type InventoryStore,
} from "./db/inventoryStore";
import { runMigrations } from "./db/migrate";
import { createPool, resolveDatabaseUrl } from "./db/pool";
import { InMemoryProfileStore, PostgresProfileStore, type ProfileStore } from "./db/profileStore";
import { markDatabaseOk } from "./db/status";
import { createGameServer, resolvePort } from "./server";

const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL);
let profileStore: ProfileStore;
let inventoryStore: InventoryStore;
let bossStateStore: BossStateStore;

if (databaseUrl === null) {
  // A supported mode, not a misconfiguration: KAD always injects the URL, and everything
  // else (tests, the loadtest harness, `npm run dev`) is expected to run without one.
  profileStore = new InMemoryProfileStore();
  inventoryStore = new InMemoryInventoryStore();
  bossStateStore = new InMemoryBossStateStore();
  console.log("[zep-test] DATABASE_URL is not set; profiles, bags and boss timers live in this process only");
} else {
  // Anything that throws here refuses the boot, before `listen`. A configured database that
  // does not answer is a deployment error, and starting anyway would quietly drop every
  // save made that day — the opposite of the missing-URL case, which saves nothing by design.
  const pool = await createPool(databaseUrl);
  const applied = await runMigrations(pool);
  markDatabaseOk();
  profileStore = new PostgresProfileStore(pool);
  inventoryStore = new PostgresInventoryStore(pool);
  bossStateStore = new PostgresBossStateStore(pool);
  console.log(
    applied.length === 0
      ? "[zep-test] database connected; schema already up to date"
      : `[zep-test] database connected; applied ${applied.length} migration(s): ${applied.join(", ")}`,
  );
}

const port = resolvePort(process.env.PORT);
await createGameServer(profileStore, inventoryStore, bossStateStore).listen(port);
console.log(
  `[zep-test] listening on port ${port} — client at /, matchmaking at /matchmake, health at /api/health`,
);
