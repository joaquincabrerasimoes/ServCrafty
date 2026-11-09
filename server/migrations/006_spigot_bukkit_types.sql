-- Allow the Spigot and CraftBukkit server types (itzg TYPE=SPIGOT / TYPE=BUKKIT).
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_type_check;
ALTER TABLE servers ADD CONSTRAINT servers_type_check CHECK (type IN
  ('VANILLA','PAPER','PURPUR','FOLIA','SPIGOT','BUKKIT','FABRIC','QUILT','FORGE','NEOFORGE','BEDROCK','CURSEFORGE','MODRINTH'));
