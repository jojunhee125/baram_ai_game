-- r04-settlement.md §4 D2, §5: the idempotency gate `SettlementStore.settle`
-- (server/src/db/settlementStore.ts) transacts against. This row's INSERT is the one write that
-- decides whether a settlement has already happened — `ON CONFLICT (grant_key) DO NOTHING` inside
-- settle()'s transaction is what makes a retried request a no-op instead of a second payout, and
-- this table is where "no-op" and "first time" are told apart.
--
-- grant_key is authored by the caller, not generated here (D2): quest completion, a shop purchase
-- and a consumable use each build a deterministic string from their own cause, so the same cause
-- retried after a dropped connection produces the same key and collides on it rather than minting
-- a second grant.
CREATE TABLE reward_grant (
  grant_key  text        PRIMARY KEY,   -- D2's deterministic cause id
  owner_key  uuid        NOT NULL,
  -- The exact response settle() returned the first time, replayed verbatim on every later request
  -- for the same grant_key (roadmap R04: duplicate requests get back the original result, not a
  -- bare "already processed" flag). Nullable because settle() inserts this row before it knows the
  -- outcome and fills `result` in with a second statement once effects are applied — but no
  -- *committed* row is ever left holding NULL: a settlement that fails rolls the whole transaction
  -- back, taking this INSERT with it, so nothing here commits without also committing its result.
  result     jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recent-first per account (design §5): the shape a future "your recent rewards" read would
-- want. Nothing queries this yet — settle() only ever looks up a single grant_key by its
-- primary key — but the index is part of the schema this migration commits to, not something
-- a later caller's migration should have to add.
CREATE INDEX reward_grant_owner_idx ON reward_grant (owner_key, created_at DESC);

-- No foreign key on owner_key, matching player_currency, player_progress and quest_progress: the
-- account's identity is the SSO `sub`, asserted by the store layer (SettlementStore's
-- assertUuidOwnerKey), not enforced by a reference to a table this project does not keep.
