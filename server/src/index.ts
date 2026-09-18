import {
  InMemoryBossStateStore,
  PostgresBossStateStore,
  type BossStateStore,
} from "./db/bossStateStore";
import { InMemoryClassStore, PostgresClassStore, type ClassStore } from "./db/classStore";
import {
  InMemoryCurrencyStore,
  PostgresCurrencyStore,
  type CurrencyStore,
} from "./db/currencyStore";
import {
  InMemoryInventoryStore,
  PostgresInventoryStore,
  type InventoryStore,
} from "./db/inventoryStore";
import { runMigrations } from "./db/migrate";
import { createPool, resolveDatabaseUrl } from "./db/pool";
import { InMemoryProfileStore, PostgresProfileStore, type ProfileStore } from "./db/profileStore";
import { CachedProgressStore } from "./db/progressCache";
import {
  InMemoryProgressStore,
  PostgresProgressStore,
  type ProgressStore,
} from "./db/progressStore";
import { InMemoryQuestStore, PostgresQuestStore, type QuestStore } from "./db/questStore";
import {
  InMemorySettlementStore,
  PostgresSettlementStore,
  type SettlementStore,
} from "./db/settlementStore";
import { markDatabaseOk } from "./db/status";
import { createGameServer, resolveAdminOwnerKeys, resolvePort } from "./server";

const databaseUrl = resolveDatabaseUrl(process.env.DATABASE_URL);
let profileStore: ProfileStore;
let inventoryStore: InventoryStore;
let bossStateStore: BossStateStore;
let progressStore: ProgressStore;
let questStore: QuestStore;
let currencyStore: CurrencyStore;
let settlementStore: SettlementStore;
let classStore: ClassStore;

if (databaseUrl === null) {
  // A supported mode, not a misconfiguration: KAD always injects the URL, and everything
  // else (tests, the loadtest harness, `npm run dev`) is expected to run without one.
  profileStore = new InMemoryProfileStore();
  const memoryInventoryStore = new InMemoryInventoryStore();
  inventoryStore = memoryInventoryStore;
  bossStateStore = new InMemoryBossStateStore();
  // Wrapped the same as the Postgres-backed path below, and not merely for symmetry: the wrapper's
  // per-account queue (design-phase-w2-level-client.md §1.2) is what makes a same-tick kill and
  // death for one account apply in the order they happened rather than the order their promises
  // settle in, and that ordering problem exists purely in this process's own microtask scheduling —
  // it does not go away just because this store answers from memory instead of a round trip.
  progressStore = new CachedProgressStore(new InMemoryProgressStore());
  // Deliberately unwrapped, unlike progress: `CachedProgressStore` exists to serialize writes to a
  // single per-account counter that both a kill and a death race for. A quest row is advanced by
  // one caller only (a kill), and its store already settles every ordering question inside one
  // statement, so a queue here would add a hop and answer nothing.
  questStore = new InMemoryQuestStore();
  const memoryCurrencyStore = new InMemoryCurrencyStore();
  currencyStore = memoryCurrencyStore;
  // Shares this process's actual currency/inventory stores rather than a private pair of its own —
  // `InMemorySettlementStore`'s own reason: a settled quest reward has to show up in the same
  // balance/bag this room's other paths (a bag open, a hunting-ground drop) already read and write.
  settlementStore = new InMemorySettlementStore(memoryCurrencyStore, memoryInventoryStore);
  classStore = new InMemoryClassStore();
  console.log(
    "[zep-test] DATABASE_URL is not set; profiles, bags, boss timers, EXP, quests, currency and classes live in this process only",
  );
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
  // Every room definition shares this one wrapped instance (server.ts:103-110's own spread), which
  // is what turns join-time hydration into "one query per account, ever, for this process" instead
  // of one per join (design-phase-w2-level-client.md §1).
  progressStore = new CachedProgressStore(new PostgresProgressStore(pool));
  questStore = new PostgresQuestStore(pool);
  currencyStore = new PostgresCurrencyStore(pool);
  settlementStore = new PostgresSettlementStore(pool);
  classStore = new PostgresClassStore(pool);
  console.log(
    applied.length === 0
      ? "[zep-test] database connected; schema already up to date"
      : `[zep-test] database connected; applied ${applied.length} migration(s): ${applied.join(", ")}`,
  );
}

const adminOwnerKeys = resolveAdminOwnerKeys(process.env.ADMIN_OWNER_KEYS);
const port = resolvePort(process.env.PORT);
await createGameServer(
  profileStore,
  inventoryStore,
  bossStateStore,
  progressStore,
  questStore,
  adminOwnerKeys,
  currencyStore,
  settlementStore,
  classStore,
).listen(port);
console.log(
  `[zep-test] listening on port ${port} — client at /, matchmaking at /matchmake, health at /api/health`,
);
