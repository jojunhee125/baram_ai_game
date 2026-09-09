-- design-phase-i-boss-monster.md §2.2. Keyed by MonsterSpawnDefinition.id rather than owner_key —
-- the first table in this directory whose PK is not an account: "last defeated at" belongs to a
-- spawn row (a room/zone), not to whoever landed the killing blow. No foreign key, for the same
-- reason inventory_item.item_key has none: monsterDefinitions.ts is the source of truth for which
-- spawn ids exist, enforced by boot validation, not by the schema.
CREATE TABLE monster_defeat (
  spawn_id     text        PRIMARY KEY,
  defeated_at  timestamptz NOT NULL
);
