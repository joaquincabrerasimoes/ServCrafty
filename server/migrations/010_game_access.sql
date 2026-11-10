-- v0.3.2: per-user game access allowlist. A game key is `minecraft`, `terraria` or `steam:<definitionId>`.
-- No rows = the user cannot create any server (admins are never restricted). No grandfathering.
CREATE TABLE IF NOT EXISTS user_game_access (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_key text NOT NULL CHECK (game_key ~ '^(minecraft|terraria|steam:[a-z0-9][a-z0-9-]{1,39})$'),
  PRIMARY KEY (user_id, game_key)
);
CREATE INDEX IF NOT EXISTS user_game_access_key_idx ON user_game_access (game_key);
