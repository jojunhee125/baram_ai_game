import { cumulativeExpForLevel } from "@zep-test/shared";
import { InMemoryCurrencyStore } from "../../../server/src/db/currencyStore";
import { InMemoryInventoryStore } from "../../../server/src/db/inventoryStore";
import { InMemorySettlementStore } from "../../../server/src/db/settlementStore";
import { InMemoryTradeStore } from "../../../server/src/db/tradeStore";
import { InMemoryClassStore } from "../../../server/src/db/classStore";
import { InMemoryProgressStore } from "../../../server/src/db/progressStore";
import { InMemoryQuestStore } from "../../../server/src/db/questStore";
import { ITEM_DEFINITIONS } from "../../../server/src/rooms/itemDefinitions";
import { createGameServer } from "../../../server/src/server";

const currency = new InMemoryCurrencyStore();
const inventory = new InMemoryInventoryStore();
const classes = new InMemoryClassStore();
const progress = new InMemoryProgressStore();
for (let index = 0; index < 7; index++) {
  const owner = `00000000-0000-4000-8000-00000000003${index}`;
  await currency.credit(owner, 20000);
  await progress.grantExp(owner, cumulativeExpForLevel(30));
  await classes.chooseOnce(owner, "warrior");
  for (const item of ITEM_DEFINITIONS) await inventory.add(owner, item.key, item.equipment ? 1 : 50);
}
const server = createGameServer(undefined, inventory, undefined, progress, new InMemoryQuestStore(), new Set(), currency,
  new InMemorySettlementStore(currency, inventory), classes, new InMemoryTradeStore(currency, inventory));
await server.listen(2567, "127.0.0.1");
