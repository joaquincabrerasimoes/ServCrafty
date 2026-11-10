-- SteamCMD games (v0.3.0). A server of game 'steam' (type STEAMCMD) runs any SteamCMD game described by a
-- game definition; `steam` holds {gameId, vars, workshop, updateOnStart, validateNext} and `extra_ports` the
-- host ports of every published definition port except the main one (which stays in `port`).
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_game_check;
ALTER TABLE servers ADD CONSTRAINT servers_game_check CHECK (game IN ('minecraft','terraria','steam'));

ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_type_check;
ALTER TABLE servers ADD CONSTRAINT servers_type_check CHECK (type IN
  ('VANILLA','PAPER','PURPUR','FOLIA','SPIGOT','BUKKIT','FABRIC','QUILT','FORGE','NEOFORGE','BEDROCK','CURSEFORGE','MODRINTH',
   'TERRARIA','TSHOCK','TMODLOADER','STEAMCMD'));

ALTER TABLE servers ADD COLUMN IF NOT EXISTS steam jsonb NULL;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS extra_ports jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS servers_steam_game_idx ON servers ((steam->>'gameId')) WHERE steam IS NOT NULL;

-- Users allowed to create/edit game definitions (admins always can).
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_author_games boolean NOT NULL DEFAULT false;

-- CUSTOM game definitions only; built-ins ship as files in server/games/ and are read-only.
CREATE TABLE IF NOT EXISTS game_definitions (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  definition jsonb NOT NULL,
  owner_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
