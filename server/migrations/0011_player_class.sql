-- roadmap R05-a (docs/r05-classes-and-skills.md D1, docs/decisions.md 2026-09-18): the class an
-- account chose, write-once — there is no reclass path in V1 (R06 owns that when it exists).
--
-- A new table rather than a column on player_profile (design §2 D1, following 0006_player_
-- progress.sql's own precedent): player_profile.avatar_skin is NOT NULL with no default
-- (0001_player_profile.sql), and "no row = never picked a skin" is load-bearing for the skin
-- picker's own contract (ProfileStore.getAvatarSkin). Reusing that table for a class would force
-- every first-choice write to either invent an avatar_skin default the moment an account picks a
-- class before ever touching the skin picker (silently promoting "never chosen a skin" to "chose
-- skin 0"), or drop the NOT NULL constraint on a column this feature never otherwise touches. A
-- second, independent table avoids both, at the one extra per-join query player_progress already
-- accepted for the same reason.
CREATE TABLE player_class (
  owner_key  uuid        PRIMARY KEY,
  class_key  text        NOT NULL CHECK (class_key IN ('warrior', 'rogue', 'shaman', 'cleric')),
  chosen_at  timestamptz NOT NULL DEFAULT now()
);
