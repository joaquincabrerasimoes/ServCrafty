-- Players who tried to join a Java server but were refused by the whitelist (parsed from the server log).
CREATE TABLE IF NOT EXISTS whitelist_attempts (
  server_id  uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  name_lower text NOT NULL,
  name       text NOT NULL,
  uuid       text,
  ip         text,
  attempts   integer NOT NULL DEFAULT 1,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, name_lower)
);
