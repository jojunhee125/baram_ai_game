ALTER TABLE inventory_item ADD COLUMN equipped boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX inventory_item_owner_equipped_uidx ON inventory_item (owner_key) WHERE equipped;
