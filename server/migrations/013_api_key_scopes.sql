-- v0.6.0: API keys get permissions. `scopes` lists what the key may do (see lib/apiScopes.ts; `*` = everything its owner can do,
-- which is what every key had before), `server_ids` optionally limits it to some servers (NULL = all the owner's servers).

ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT ARRAY['*']::text[];
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS server_ids uuid[];
