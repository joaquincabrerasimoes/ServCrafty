-- ServCrafty initial schema (PostgreSQL 13+; uses gen_random_uuid()).

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username        text NOT NULL UNIQUE,
  email           text,
  password_hash   text NOT NULL,
  role            text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  locale          text NOT NULL DEFAULT 'en',
  theme           text NOT NULL DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  disabled        boolean NOT NULL DEFAULT false,
  max_servers     integer,
  max_ram_mb      integer,
  max_cpu         numeric(8, 2),
  max_disk_mb     integer,
  totp_secret_enc text,
  totp_enabled    boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_lower_idx ON users (lower(username));

CREATE TABLE passkeys (
  id           text PRIMARY KEY,              -- credential ID (base64url)
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key   bytea NOT NULL,
  counter      bigint NOT NULL DEFAULT 0,
  transports   text[] NOT NULL DEFAULT '{}',
  name         text NOT NULL DEFAULT 'Passkey',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz
);
CREATE INDEX api_tokens_user_idx ON api_tokens (user_id);

CREATE TABLE sessions (
  id                 text PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at         timestamptz NOT NULL,
  mfa_ok             boolean NOT NULL DEFAULT false,
  user_agent         text,
  ip                 text,
  webauthn_challenge text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE servers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name           text NOT NULL,
  type           text NOT NULL CHECK (type IN ('VANILLA','PAPER','PURPUR','FOLIA','FABRIC','QUILT','FORGE','NEOFORGE','BEDROCK','CURSEFORGE','MODRINTH')),
  mc_version     text NOT NULL DEFAULT 'LATEST',
  loader_version text,
  modpack        jsonb,
  java_args      text,
  memory_mb      integer NOT NULL,
  cpu            numeric(8, 2) NOT NULL,
  disk_mb        integer,
  port           integer NOT NULL UNIQUE,
  env            jsonb NOT NULL DEFAULT '{}'::jsonb,
  container_id   text,
  status         text NOT NULL DEFAULT 'stopped',
  auto_restart   boolean NOT NULL DEFAULT true,
  rcon_password  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX servers_owner_idx ON servers (owner_id);

CREATE TABLE server_shares (
  server_id  uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  level      text NOT NULL CHECK (level IN ('viewer', 'operator', 'manager')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_shares_user_idx ON server_shares (user_id);

CREATE TABLE settings (
  key       text PRIMARY KEY,
  value     jsonb NOT NULL,
  encrypted boolean NOT NULL DEFAULT false
);

CREATE TABLE backups (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  file       text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  kind       text NOT NULL CHECK (kind IN ('manual', 'scheduled')),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  note       text
);
CREATE INDEX backups_server_idx ON backups (server_id, created_at DESC);

CREATE TABLE schedules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  cron        text NOT NULL,
  action      text NOT NULL CHECK (action IN ('restart', 'command', 'backup', 'start', 'stop')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_server_idx ON schedules (server_id);

CREATE TABLE webhooks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  uuid REFERENCES servers (id) ON DELETE CASCADE,  -- NULL = all servers of owner
  owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       text,
  url        text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('discord', 'generic')),
  events     text[] NOT NULL DEFAULT '{}',
  enabled    boolean NOT NULL DEFAULT true,
  secret     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_server_idx ON webhooks (server_id);
CREATE INDEX webhooks_owner_idx ON webhooks (owner_id);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id);
CREATE INDEX audit_log_action_idx ON audit_log (action);

CREATE TABLE templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  config      jsonb NOT NULL,
  shared      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_owner_idx ON templates (owner_id);
