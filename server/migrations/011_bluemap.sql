-- v0.4.0: BlueMap web map for Java servers. `{enabled, schema, role, passwordEnc, enabledAt}`; the map
-- tiles live in the PostgreSQL schema `schema`, owned by a role of its own (see services/bluemap.ts).
ALTER TABLE servers ADD COLUMN IF NOT EXISTS bluemap jsonb;
