-- The runner reads this table before applying anything, so it has to survive being created
-- by the first migration and then seen again by a later boot: IF NOT EXISTS, and never
-- dropped. Forward-only — there is no down migration for anything in this directory.
CREATE TABLE IF NOT EXISTS schema_migration (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_profile (
  -- The Keycloak access token's `sub`. Typed uuid so a malformed key is refused by the
  -- database rather than by application code that could be bypassed.
  owner_key   uuid PRIMARY KEY,
  -- shared AVATAR_SKIN_COUNT (= 24). Growing the sheet needs a migration that raises this
  -- CHECK too; raising the constant alone makes saves fail loudly here, which is the point.
  avatar_skin smallint NOT NULL CHECK (avatar_skin >= 0 AND avatar_skin < 24),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
