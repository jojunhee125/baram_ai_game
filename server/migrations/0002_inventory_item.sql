CREATE TABLE inventory_item (
  -- The same key as player_profile.owner_key: the Keycloak access token's `sub`. Deliberately
  -- no foreign key to player_profile — a drop can land before that account has ever confirmed a
  -- skin, and a reward refused because a profile row does not exist yet is a bug report.
  owner_key uuid    NOT NULL,
  -- An ITEM_DEFINITIONS key. The definitions live in code only and the database knows the key
  -- and the amount and nothing else, which is what keeps renaming an item a deploy rather than a
  -- migration. Same trust model as the portal and fixed-object tables.
  item_key  text    NOT NULL,
  -- `> 0`, not `>= 0`: a row that reached zero is an item the player does not have, and leaving
  -- it behind would spend one of the MAX_DISTINCT_ITEMS slots on nothing.
  quantity  integer NOT NULL CHECK (quantity > 0),
  -- No surrogate id. One row per (owner, item) is the stack model itself (design §3.1), and it
  -- is what lets a grant be a single ON CONFLICT upsert instead of a read-modify-write.
  PRIMARY KEY (owner_key, item_key)
);
