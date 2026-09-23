import { InMemoryCurrencyStore } from "../../../server/src/db/currencyStore";
import { InMemoryInventoryStore } from "../../../server/src/db/inventoryStore";
import { InMemorySettlementStore } from "../../../server/src/db/settlementStore";
import { InMemoryTradeStore } from "../../../server/src/db/tradeStore";
import { InMemoryClassStore } from "../../../server/src/db/classStore";
import { createGameServer } from "../../../server/src/server";

const currency = new InMemoryCurrencyStore();
const inventory = new InMemoryInventoryStore();
const classes = new InMemoryClassStore();
for (const [owner, balance] of [
  ["abcdef12-3456-4789-abcd-abcdefabcdef", 100],
  ["fedcba98-7654-4321-abcd-fedcbafedcba", 50],
] as const) {
  await currency.credit(owner, balance);
  await classes.chooseOnce(owner, "cleric");
}
await inventory.add("abcdef12-3456-4789-abcd-abcdefabcdef", "padded-armor", 1);
await inventory.add("abcdef12-3456-4789-abcd-abcdefabcdef", "den-fur", 4);
const server = createGameServer(undefined, inventory, undefined, undefined, undefined, new Set(), currency,
  new InMemorySettlementStore(currency, inventory), classes, new InMemoryTradeStore(currency, inventory));
await server.listen(2567, "127.0.0.1");
