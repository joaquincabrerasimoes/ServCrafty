-- Start a server automatically when the host (LXC / Docker) comes up, unless a user stopped it by hand.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS auto_start BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS stopped_by_user BOOLEAN NOT NULL DEFAULT false;
