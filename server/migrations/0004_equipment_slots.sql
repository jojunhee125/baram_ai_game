-- design-hunting-inventory.md §7.2 / design-phase-v-equipment-system.md §2 generalize the single
-- `equipped boolean` (0003) to eight named slots: "at most one equipped item" becomes "at most one
-- equipped item per (owner, slot)".

ALTER TABLE inventory_item ADD COLUMN equipped_slot text NULL;

-- The one and only equipment item that has ever existed (leather-armor) only ever went in the
-- armor slot — that is a historical fact about this table's contents, not something the code
-- decides, so every row `equipped = true` today is unambiguously an armor-slot equip.
UPDATE inventory_item SET equipped_slot = 'armor' WHERE equipped = true;

ALTER TABLE inventory_item ADD CONSTRAINT inventory_item_equipped_slot_check
  CHECK (equipped_slot IN ('armor', 'helmet', 'ring1', 'ring2', 'necklace', 'shoes', 'weapon', 'cloak'));

-- design §2.1's (owner_key) unique index widens to (owner_key, equipped_slot): a same-slot equip
-- race still hits this index's 23505 (PostgresInventoryStore.equip), and a different-slot equip
-- race no longer contends on the same index entry at all — the point of this whole migration.
CREATE UNIQUE INDEX inventory_item_owner_equipped_slot_uidx
  ON inventory_item (owner_key, equipped_slot) WHERE equipped_slot IS NOT NULL;

DROP INDEX IF EXISTS inventory_item_owner_equipped_uidx;
ALTER TABLE inventory_item DROP COLUMN equipped;
