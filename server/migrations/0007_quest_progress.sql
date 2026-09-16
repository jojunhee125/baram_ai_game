-- One account's state on one quest (roadmap R03, docs/roadmap.md §7-3). Composite key rather
-- than the one-row-per-account shape player_progress uses: a quest is a row that comes into
-- existence when it is accepted and never stops existing, so "has this account accepted it" is
-- the presence of the row itself and needs no nullable accepted_at to stand in for it.
--
-- No status column. Like player_progress deriving level from exp (0006), status is derived:
-- completed_at IS NULL is active, and a timestamp is completed. A stored enum would be a second
-- copy of a fact completed_at already carries, kept in step by hand — and the one write that
-- completes a quest is the same write that increments the counter, so there is no moment where
-- the two could legitimately disagree.
--
-- required_count is deliberately NOT stored. It belongs to QUEST_DEFINITIONS
-- (server/src/rooms/questDefinitions.ts), which is authored in code for the reason every other
-- content table here is: the deploy is the edit permission. Storing it would freeze each row at
-- the requirement in force the day it was accepted, so retuning a quest would need a migration
-- and a backfill instead of a redeploy. The cap therefore travels into the UPDATE as a parameter,
-- exactly as player_progress's death-penalty floor does.
--
-- No foreign key on quest_id, matching inventory_item.item_key and monster_defeat.spawn_id: the
-- code table is the source of truth for which ids exist, enforced by boot validation.
CREATE TABLE quest_progress (
  owner_key    uuid        NOT NULL,
  quest_id     text        NOT NULL,
  -- Never exceeds the objective's count: every write clamps with LEAST($n), so a requirement
  -- lowered by a redeploy cannot leave a row reading "5 / 3".
  kill_count   integer     NOT NULL DEFAULT 0 CHECK (kill_count >= 0),
  -- When the objective was met. NULL while the quest is active; set once and never cleared, so
  -- a completed quest stays completed even if its requirement is raised later.
  completed_at timestamptz,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, quest_id)
);
