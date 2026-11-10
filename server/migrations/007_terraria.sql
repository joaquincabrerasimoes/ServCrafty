-- Other games: Terraria (v0.2.0). `game` says which game a server runs (derived from `type` by
-- the application, never trusted from the client); `terraria` holds the Terraria config (null for Minecraft).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS game text NOT NULL DEFAULT 'minecraft';
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_game_check;
ALTER TABLE servers ADD CONSTRAINT servers_game_check CHECK (game IN ('minecraft','terraria'));
ALTER TABLE servers ADD COLUMN IF NOT EXISTS terraria jsonb NULL;

ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_type_check;
ALTER TABLE servers ADD CONSTRAINT servers_type_check CHECK (type IN
  ('VANILLA','PAPER','PURPUR','FOLIA','SPIGOT','BUKKIT','FABRIC','QUILT','FORGE','NEOFORGE','BEDROCK','CURSEFORGE','MODRINTH',
   'TERRARIA','TSHOCK','TMODLOADER'));
