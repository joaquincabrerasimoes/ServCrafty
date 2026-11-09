-- Per-server opt-in for the Minecraft Java LAN discovery announcer (UDP multicast 224.0.2.60:4445).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS lan_announce boolean NOT NULL DEFAULT false;
