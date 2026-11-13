-- v0.4.6: BlueMap markers kept in the panel's own database (the BlueMap API does not persist them) and several
-- public map links per server, each optionally allowed to create/edit markers.

CREATE TABLE IF NOT EXISTS bluemap_public_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  name        text NOT NULL,
  token_enc   text NOT NULL,
  can_edit    boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bluemap_public_links_server ON bluemap_public_links (server_id);

CREATE TABLE IF NOT EXISTS bluemap_marker_sets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id      uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  map_id         text NOT NULL,
  label          text NOT NULL,
  toggleable     boolean NOT NULL DEFAULT true,
  default_hidden boolean NOT NULL DEFAULT false,
  sorting        integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bluemap_marker_sets_server ON bluemap_marker_sets (server_id, map_id);

CREATE TABLE IF NOT EXISTS bluemap_markers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  set_id      uuid NOT NULL REFERENCES bluemap_marker_sets (id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('poi', 'html', 'line', 'shape', 'extrude')),
  label       text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bluemap_markers_server ON bluemap_markers (server_id);
CREATE INDEX IF NOT EXISTS bluemap_markers_set ON bluemap_markers (set_id);

-- The single public link of v0.4.5 (stored inside servers.bluemap) becomes the first row of the new table.
INSERT INTO bluemap_public_links (server_id, name, token_enc, can_edit)
SELECT id, 'Public link', bluemap->>'publicTokenEnc', false
  FROM servers
 WHERE bluemap ? 'publicTokenEnc' AND coalesce(bluemap->>'publicTokenEnc', '') <> '';
UPDATE servers SET bluemap = bluemap - 'publicTokenEnc' WHERE bluemap ? 'publicTokenEnc';
