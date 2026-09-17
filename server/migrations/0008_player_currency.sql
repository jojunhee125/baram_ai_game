-- r04-settlement.md §4 D1: a dedicated table rather than reusing
-- inventory_item's copper-coin row or a column on player_progress (0006_player_progress.sql).
-- Same logic 0006 itself gives for splitting player_progress off player_profile: a currency row
-- shares neither inventory_item's MAX_DISTINCT_ITEMS cap nor its equipped_slot, so folding
-- currency in there would make every future currency change consume one of the account's limited
-- item slots and mix a scalar balance into a row-per-possession model built for something else. A
-- column on player_progress was rejected for the mirror reason: EXP grants and currency grants
-- would then share one row's lock, so a kill that both credits currency and grants EXP would
-- contend with itself on the hunting path this table exists to keep cheap.
--
-- No foreign key on owner_key, matching player_progress and quest_progress: the account's
-- identity is the SSO `sub`, asserted by the store layer (CurrencyStore's assertUuidOwnerKey),
-- not enforced by a reference to a table this project does not keep.
CREATE TABLE player_currency (
  owner_key  uuid   PRIMARY KEY,
  -- Never negative: this CHECK is the backstop behind CurrencyStore.debit's own conditional
  -- UPDATE, the same belt-and-suspenders relationship 0007's kill_count CHECK has with its LEAST
  -- clamp — the application guards the common path, the schema refuses whatever slips past it.
  balance    bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
