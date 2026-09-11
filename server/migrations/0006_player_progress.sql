-- design-phase-w-level-system.md §5.1: level is always levelForExp(exp), never stored — only the
-- cumulative EXP counter is persisted, so a curve or cap change (shared/src/leveling.ts)
-- reinterprets every existing row for free instead of needing a migration of its own.
--
-- A new table rather than a column on player_profile (coder judgement call, decisions.md
-- 2026-09-11 "Phase W-1 서버 구현"): player_profile.avatar_skin is NOT NULL with no default
-- (0001_player_profile.sql), which is load-bearing for the skin picker's own "never stored yet is
-- null, not an invented default" contract (ProfileStore.getAvatarSkin, profileStore.ts) — an
-- account that has never picked a skin has no player_profile row at all. Reusing that table for
-- EXP would force every grantExp UPSERT to either invent an avatar_skin default the moment that
-- account's first kill lands (silently promoting "never chosen" to "chose skin 0", breaking Phase
-- H's skin-skip logic) or drop the NOT NULL constraint on a column this feature never otherwise
-- touches. A second table with its own independent existence avoids both, at the same per-kill
-- query cost either shape would pay (design §5.3's hasMonsters gate applies equally).
CREATE TABLE player_progress (
  owner_key  uuid        PRIMARY KEY,
  exp        bigint      NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
