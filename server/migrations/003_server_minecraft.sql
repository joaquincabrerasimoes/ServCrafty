-- Initial Minecraft configuration chosen at creation (level name, seed, difficulty, whitelist...).
-- Applied as itzg env vars on the first start only (while server.properties does not exist yet).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS minecraft jsonb;
